// The explanation log: why the agent flagged or skipped each post and what the vault did with each trigger. The console
// shows it; the vault never reads it. Values are plain strings and numbers, so every event serializes as JSON.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Classification } from './classifier/types.ts';

export type AgentEvent =
  | {
      kind: 'agent.started';
      mode: string;
      vault: string;
      classifier: string;
      accounts: string[];
      // How often the supervisor restarted the agent before this start
      restarts?: number;
      // The intervals and limits this run ran with (live mode)
      settings?: Record<string, string | number>;
    }
  | { kind: 'post.seen'; account: string; postId: string; text: string; createdAt: number }
  | { kind: 'post.skipped'; account: string; postId: string; reason: string }
  | {
      kind: 'post.classified';
      account: string;
      postId: string;
      classifier: string;
      // relevant | not-relevant | skipped-by-filter
      verdict?: string;
      results: Classification[];
    }
  | {
      kind: 'trigger.opened';
      triggerId: string;
      ruleId: string;
      asset: string;
      account: string;
      postId: string;
      p0: string;
      t0: number;
      opensAt: number;
      closesAt: number;
      thresholdBps: number;
      spikeCapBps: number;
      txHash?: string;
      // What the transaction cost the agent wallet in gas
      gasEth?: string;
    }
  | { kind: 'trigger.checked'; triggerId: string; asset: string; p1: string; changeBps: number; verdict: string }
  | {
      kind: 'trigger.bought';
      triggerId: string;
      positionId: string;
      asset: string;
      usdcIn: string;
      assetOut: string;
      price: string;
      txHash?: string;
      gasEth?: string;
    }
  | { kind: 'trigger.rejected'; triggerId?: string; asset: string; stage: 'open' | 'confirm'; reason: string }
  | { kind: 'trigger.expired'; triggerId: string; asset: string; txHash?: string; gasEth?: string }
  | {
      kind: 'position.sold';
      positionId: string;
      asset: string;
      sellKind: string;
      price: string;
      usdcOut: string;
      txHash?: string;
      gasEth?: string;
    }
  // A paid action, booked to the users it served (split evenly in the cost ledger)
  | {
      kind: 'cost';
      costKind: 'post-fetch' | 'ai-call' | 'price-update-fee' | 'gas';
      source: string;
      usd: number;
      units: number;
      users: string[];
      ref?: string;
    }
  | { kind: 'tamper.result'; name: string; expected: string; actual: string; passed: boolean }
  | {
      kind: 'cycle.finished';
      cycle: number;
      // Milliseconds since the epoch
      startedAt: number;
      durationMs: number;
      mode: 'normal' | 'saving' | 'halted';
      polled: boolean;
      accountsPolled: string[];
      postsNew: number;
      classified: number;
      triggersOpened: number;
      p1Checks: number;
      bought: number;
      rejected: number;
      expired: number;
      sold: number;
      paidCalls: number;
      txSent: number;
      // USD of the cost events in the cycle: posts, model calls, and gas and fees priced at mainnet ETH
      costUsd: string;
      // From the agent wallet's balance at the start and the end of the cycle
      ethSpent: string;
      errors: number;
      nextAt: number;
    }
  | { kind: 'cycle.skipped'; cycle: number; reason: string; runningForMs: number }
  // A source that failed `failures` times in a row is skipped until retryAt (milliseconds); recovered on its next success
  | { kind: 'source.degraded'; source: string; failures: number; retryAt: number }
  | { kind: 'source.recovered'; source: string }
  // The open triggers a restart picked up again from the vault
  | { kind: 'agent.recovered'; openTriggers: string[] }
  | {
      kind: 'budget.mode';
      mode: 'normal' | 'saving' | 'halted';
      reason: string;
      dataUsdToday: string;
      ethSpentToday: string;
      ethBalance: string;
    }
  | { kind: 'error'; where: string; message: string };

export type LoggedEvent = AgentEvent & { seq: number; at: number };

// Cuts every URL down to its scheme and host. An RPC URL carries its API key in the path (Alchemy's /v2/<key>), in the
// query or before the host, and an error from viem quotes the URL in full. The log reaches the console, /api/state, the
// frontend and the run report, so no URL leaves the agent with more than its host.
export const redactUrls = (text: string) =>
  text.replace(/\b(https?):\/\/(?:[^\s/?#@"'<>]*@)?([^\s/?#"'<>]+)([/?#][^\s"'<>]*)?/g, (_url, scheme, host, rest) =>
    rest ? `${scheme}://${host}/…` : `${scheme}://${host}`
  );

const redactStrings = (value: unknown): unknown => {
  if (typeof value === 'string') return redactUrls(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redactStrings(field)]));
  }
  return value;
};

// Every string of an event goes out redacted, error messages and rejection reasons above all. A post's own text is
// left as it is: its links are the post's, and it comes from the post provider, never from the agent's configuration.
const redactEvent = (event: AgentEvent): AgentEvent => {
  const redacted = redactStrings(event) as AgentEvent;
  return event.kind === 'post.seen' && redacted.kind === 'post.seen' ? { ...redacted, text: event.text } : redacted;
};

export interface EventLogOptions {
  // JSON lines are appended here when set
  file?: URL;
  capacity?: number;
  now?: () => number;
}

export class EventLog {
  private readonly events: LoggedEvent[] = [];
  private readonly listeners = new Set<(event: LoggedEvent) => void>();
  private readonly capacity: number;
  private readonly file?: string;
  private readonly now: () => number;
  private seq = 0;

  // 5,000 events hold a multi-hour live run: two cycle summaries a minute plus everything the cycles did
  constructor({ file, capacity = 5000, now = Date.now }: EventLogOptions = {}) {
    this.capacity = capacity;
    this.now = now;
    if (file) {
      this.file = fileURLToPath(file);
      mkdirSync(dirname(this.file), { recursive: true });
    }
  }

  append(event: AgentEvent): LoggedEvent {
    const logged = { ...redactEvent(event), seq: ++this.seq, at: this.now() } as LoggedEvent;
    this.events.push(logged);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(logged)}\n`);
    for (const listener of this.listeners) listener(logged);
    return logged;
  }

  // Newest last
  recent(limit = this.capacity): LoggedEvent[] {
    return this.events.slice(-limit);
  }

  since(seq: number): LoggedEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  subscribe(listener: (event: LoggedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
