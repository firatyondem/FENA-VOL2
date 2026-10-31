// Backs off a data source that keeps failing, so a down Airnode or RPC is not hammered (or paid) every cycle: after 3
// failures in a row the source is skipped for 2 cycles, then 4, 8 and so on, at most 10 minutes, until a call to it
// succeeds again. A skipped call fails fast with SourceBackoff, which the engine treats like any passing failure.
import type { Classifier } from '../classifier/types.ts';
import type { EventLog } from '../log.ts';

export const SOURCES = ['twitterapi', 'nodary', 'tickerlayer', 'rpc', 'classifier'] as const;
export type SourceName = (typeof SOURCES)[number];

export class SourceBackoff extends Error {
  readonly source: SourceName;
  readonly retryAt: number;

  constructor(source: SourceName, retryAt: number) {
    super(`${source} is backing off after repeated failures, next try at ${new Date(retryAt).toISOString()}`);
    this.name = 'SourceBackoff';
    this.source = source;
    this.retryAt = retryAt;
  }
}

export interface SourceGuardOptions {
  log: EventLog;
  // Milliseconds since the epoch
  nowMs?: () => number;
  cycleIntervalSec?: number;
  // Failures in a row before the source is skipped
  threshold?: number;
  maxBackoffMs?: number;
}

export interface SourceState {
  // Failures in a row
  failures: number;
  // While degraded, no call before this time (milliseconds)
  retryAt: number;
  degraded: boolean;
}

export class SourceGuard {
  private readonly log: EventLog;
  private readonly nowMs: () => number;
  private readonly cycleMs: number;
  private readonly threshold: number;
  private readonly maxBackoffMs: number;
  private readonly states = new Map<SourceName, SourceState>();

  constructor({ log, nowMs = Date.now, cycleIntervalSec = 30, threshold = 3, maxBackoffMs = 600_000 }: SourceGuardOptions) {
    this.log = log;
    this.nowMs = nowMs;
    this.cycleMs = cycleIntervalSec * 1000;
    this.threshold = threshold;
    this.maxBackoffMs = maxBackoffMs;
  }

  private state(source: SourceName): SourceState {
    let state = this.states.get(source);
    if (!state) {
      state = { failures: 0, retryAt: 0, degraded: false };
      this.states.set(source, state);
    }
    return state;
  }

  // Runs one call to `source`, unless the source is backing off. A throw counts as a failure, and so does a result that
  // `isFailure` names, such as an HTTP 503.
  async call<T>(source: SourceName, action: () => Promise<T>, isFailure: (result: T) => boolean = () => false): Promise<T> {
    const state = this.state(source);
    if (state.degraded && this.nowMs() < state.retryAt) throw new SourceBackoff(source, state.retryAt);
    let result: T;
    try {
      result = await action();
    } catch (error) {
      this.failed(source);
      throw error;
    }
    if (isFailure(result)) this.failed(source);
    else this.succeeded(source);
    return result;
  }

  private failed(source: SourceName) {
    const state = this.state(source);
    state.failures += 1;
    if (state.failures < this.threshold) return;
    // 2, 4, 8 … cycles: the third failure in a row skips 2, each failed retry doubles it
    const cycles = 2 ** (state.failures - this.threshold + 1);
    state.retryAt = this.nowMs() + Math.min(cycles * this.cycleMs, this.maxBackoffMs);
    state.degraded = true;
    this.log.append({ kind: 'source.degraded', source, failures: state.failures, retryAt: state.retryAt });
  }

  private succeeded(source: SourceName) {
    const state = this.state(source);
    if (state.degraded) this.log.append({ kind: 'source.recovered', source });
    state.failures = 0;
    state.retryAt = 0;
    state.degraded = false;
  }

  status(): Partial<Record<SourceName, SourceState>> {
    return Object.fromEntries([...this.states].map(([source, state]) => [source, { ...state }]));
  }
}

// An HTTP failure of the source itself: no answer, a server error, or a rate limit. A 4xx such as 402 (pay first) or 400
// is an answer, not an outage.
export const isOutage = (response: Response) => response.status >= 500 || response.status === 429;

// Sends each request through the guard of the source it belongs to; requests of no known source pass untouched.
export const guardedFetch =
  (inner: typeof fetch, guard: SourceGuard, sourceOf: (url: string) => SourceName | undefined): typeof fetch =>
  (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const source = sourceOf(url);
    return source ? guard.call(source, () => inner(input, init), isOutage) : inner(input, init);
  };

// The Airnode a URL belongs to, by the URLs in shared/asset-profiles.json
export const airnodeSourceOf = (airnodes: Record<string, { url: string }>) => (url: string) => {
  const match = Object.entries(airnodes).find(([, airnode]) => url.startsWith(airnode.url));
  return match && (SOURCES as readonly string[]).includes(match[0]) ? (match[0] as SourceName) : undefined;
};

// The classifier behind the guard: an API error counts as a failure; a model that declines still answers
export const guardedClassifier = (inner: Classifier, guard: SourceGuard): Classifier => ({
  name: inner.name,
  classify: (post, candidates) => guard.call('classifier', () => inner.classify(post, candidates)),
});
