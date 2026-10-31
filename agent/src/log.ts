// The explanation log: why the agent flagged or skipped each post and what the vault did with each trigger. The console
// shows it; the vault never reads it. Values are plain strings and numbers, so every event serializes as JSON.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Classification } from './classifier/types.ts';

export type AgentEvent =
  | { kind: 'agent.started'; mode: string; vault: string; classifier: string; accounts: string[] }
  | { kind: 'post.seen'; account: string; postId: string; text: string; createdAt: number }
  | { kind: 'post.skipped'; account: string; postId: string; reason: string }
  | { kind: 'post.classified'; account: string; postId: string; classifier: string; results: Classification[] }
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
    }
  | { kind: 'trigger.rejected'; triggerId?: string; asset: string; stage: 'open' | 'confirm'; reason: string }
  | { kind: 'trigger.expired'; triggerId: string; asset: string }
  | { kind: 'position.sold'; positionId: string; asset: string; sellKind: string; price: string; usdcOut: string }
  | { kind: 'payment.settled'; transaction: string }
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
      // From the balances at the start and the end of the cycle; a payment can settle a block late
      ausdSpent: string;
      ethSpent: string;
      errors: number;
      nextAt: number;
    }
  | { kind: 'cycle.skipped'; cycle: number; reason: string; runningForMs: number }
  | {
      kind: 'budget.mode';
      mode: 'normal' | 'saving' | 'halted';
      reason: string;
      ausdSpentToday: string;
      ethSpentToday: string;
      ausdBalance: string;
      ethBalance: string;
    }
  | { kind: 'error'; where: string; message: string };

export type LoggedEvent = AgentEvent & { seq: number; at: number };

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
    const logged = { ...event, seq: ++this.seq, at: this.now() } as LoggedEvent;
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
