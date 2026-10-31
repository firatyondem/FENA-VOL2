// One explicit cycle: the agent's whole job, in a fixed order, on a fixed schedule. Gate 2 goes before Gate 1, because
// open triggers are time-critical and already paid for; Gate 1 polls only the accounts an active rule watches, so no rule
// means no paid call. A cycle never throws and never overlaps the next one, and each ends with one cycle.finished event.
import { type Address, formatEther, formatUnits, isAddressEqual } from 'viem';
import { AUSD_DECIMALS } from '../airnode/client.ts';
import type { Rule, VaultPort } from '../chain/vault.ts';
import type { AgentEvent, EventLog, LoggedEvent } from '../log.ts';
import type { WatchedAccount } from '../sources/twitter.ts';
import { activeWatchSet, watchedAccountsIn } from './watch-set.ts';

export type AgentMode = 'normal' | 'saving' | 'halted';

export interface Balances {
  // The payer's aUSD, with 6 decimals
  ausd: bigint;
  // The agent wallet's ETH, in wei
  eth: bigint;
}

// Step 1. The budget implements it: it reads both balances and decides what the agent may do this cycle.
export interface HealthPort {
  check(): Promise<{ mode: AgentMode; balances: Balances }>;
  readBalances(): Promise<Balances>;
}

export interface CycleRunnerDeps {
  log: EventLog;
  engine: { checkPending(): Promise<void>; pollAccount(account: WatchedAccount): Promise<void> };
  keeper: { tick(): Promise<void> };
  vault: Pick<VaultPort, 'listRules'>;
  // The accounts the agent can read; Gate 1 polls the ones in the active watch set
  watchlist: readonly WatchedAccount[];
  // Milliseconds since the epoch
  nowMs?: () => number;
  // Only rules naming this wallet count. ViemVault already returns only those; the SimVault returns every rule.
  agent?: Address;
  // Without it every cycle runs in normal mode and spends nothing it can measure
  health?: HealthPort;
  cycleIntervalSec?: number;
  pollIntervalSec?: number;
}

export type CycleFinished = Extract<AgentEvent, { kind: 'cycle.finished' }>;

export const STEPS = ['health', 'rules', 'gate2', 'keeper', 'gate1', 'summary'] as const;
export type StepName = (typeof STEPS)[number];

const TX_KINDS = new Set<string>(['trigger.opened', 'trigger.bought', 'trigger.expired', 'position.sold']);

// An event that stands for a transaction the agent's wallet sent
export const isAgentTransaction = (event: AgentEvent) =>
  TX_KINDS.has(event.kind) && 'txHash' in event && Boolean(event.txHash);

// What one cycle did, read from the events appended while it ran
export const countCycleEvents = (events: readonly AgentEvent[]) => {
  const count = (kind: AgentEvent['kind']) => events.filter((event) => event.kind === kind).length;
  return {
    postsNew: count('post.seen'),
    classified: count('post.classified'),
    triggersOpened: count('trigger.opened'),
    p1Checks: count('trigger.checked'),
    bought: count('trigger.bought'),
    rejected: count('trigger.rejected'),
    expired: count('trigger.expired'),
    sold: count('position.sold'),
    paidCalls: count('payment.settled'),
    txSent: events.filter(isAgentTransaction).length,
    errors: count('error'),
  };
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// What fell between two balance readings; a top-up is not spending
const spentBetween = (before: bigint, after: bigint) => (before > after ? before - after : 0n);

export type CycleCounts = ReturnType<typeof countCycleEvents>;

// What the cycles did since the agent started
export interface CycleTotals extends CycleCounts {
  ausdSpent: bigint;
  ethSpent: bigint;
}

export interface CycleStatus {
  cyclesRun: number;
  cyclesSkipped: number;
  running: boolean;
  lastCycle?: CycleFinished;
  nextAt?: number;
  mode: AgentMode;
  // The accounts the last cycle would poll
  watchSet: string[];
  totals: CycleTotals;
}

export class CycleRunner {
  private readonly deps: CycleRunnerDeps;
  private readonly nowMs: () => number;
  private readonly cycleMs: number;
  private readonly pollMs: number;
  private cycle = 0;
  private cyclesRun = 0;
  private cyclesSkipped = 0;
  private running: { cycle: number; startedAt: number } | undefined;
  private current: Promise<void> | undefined;
  private lastPollAt: number | undefined;
  private lastMode: AgentMode = 'normal';
  private lastCycle: CycleFinished | undefined;
  private lastWatchSet: string[] = [];
  private readonly totals: CycleTotals = { ...countCycleEvents([]), ausdSpent: 0n, ethSpent: 0n };
  private nextAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: CycleRunnerDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? Date.now;
    this.cycleMs = (deps.cycleIntervalSec ?? 30) * 1000;
    this.pollMs = (deps.pollIntervalSec ?? 60) * 1000;
  }

  // Runs one cycle now and then one every cycle interval
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cycleMs);
  }

  // Stops the schedule and waits for a running cycle to finish
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current;
  }

  // Starts the cycle that is due. When the previous one is still running, this one is skipped, never run alongside it.
  tick(): Promise<void> {
    const startedAt = this.nowMs();
    const cycle = ++this.cycle;
    this.nextAt = startedAt + this.cycleMs;
    if (this.running) {
      this.cyclesSkipped += 1;
      this.deps.log.append({
        kind: 'cycle.skipped',
        cycle,
        reason: 'previous cycle still running',
        runningForMs: startedAt - this.running.startedAt,
      });
      return this.current ?? Promise.resolve();
    }
    this.running = { cycle, startedAt };
    this.current = this.run(cycle, startedAt).finally(() => {
      this.running = undefined;
      this.current = undefined;
    });
    return this.current;
  }

  status(): CycleStatus {
    return {
      cyclesRun: this.cyclesRun,
      cyclesSkipped: this.cyclesSkipped,
      running: Boolean(this.running),
      mode: this.lastMode,
      watchSet: [...this.lastWatchSet],
      totals: { ...this.totals },
      ...(this.lastCycle ? { lastCycle: this.lastCycle } : {}),
      ...(this.nextAt === undefined ? {} : { nextAt: this.nextAt }),
    };
  }

  private namingAgent(rules: readonly Rule[]) {
    const { agent } = this.deps;
    return agent ? rules.filter((rule) => isAddressEqual(rule.agent, agent)) : rules;
  }

  private async run(cycle: number, startedAt: number): Promise<void> {
    const { log, health } = this.deps;
    const appended: LoggedEvent[] = [];
    const unsubscribe = log.subscribe((event) => appended.push(event));
    // Each step stands alone: a failure is logged and the cycle goes on with the next step
    const step = async <T>(name: StepName, action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (error) {
        log.append({ kind: 'error', where: `cycle ${cycle} step ${name}`, message: errorMessage(error) });
        return undefined;
      }
    };
    try {
      // 1. Health and budget: what the agent may do this cycle
      const checked = health ? await step('health', () => health.check()) : undefined;
      const mode = checked?.mode ?? this.lastMode;
      this.lastMode = mode;

      // 2. Rules: the accounts that at least one unpaused rule naming this agent watches
      const rules = await step('rules', () => this.deps.vault.listRules());
      const watchSet = rules ? activeWatchSet(this.namingAgent(rules)) : [];
      if (rules) this.lastWatchSet = watchSet;

      // 3. Gate 2 first: open triggers are time-critical and already paid for
      await step('gate2', () => this.deps.engine.checkPending());

      // 4. Keeper: take profit and stagnation exits
      await step('keeper', () => this.deps.keeper.tick());

      // 5. Gate 1: paid post polls, only when due, only in normal mode, only for the active watch set
      const accountsPolled: string[] = [];
      const pollDue = this.lastPollAt === undefined || startedAt - this.lastPollAt >= this.pollMs;
      const accounts = watchedAccountsIn(this.deps.watchlist, watchSet);
      if (pollDue && mode === 'normal' && accounts.length > 0) {
        this.lastPollAt = startedAt;
        for (const account of accounts) {
          accountsPolled.push(account.handle);
          await step('gate1', () => this.deps.engine.pollAccount(account));
        }
      }

      // 6. Summary: what the cycle did and spent
      const after = health && checked ? await step('summary', () => health.readBalances()) : undefined;
      unsubscribe();
      const before = checked?.balances;
      const counts = countCycleEvents(appended);
      const ausdSpent = before && after ? spentBetween(before.ausd, after.ausd) : 0n;
      const ethSpent = before && after ? spentBetween(before.eth, after.eth) : 0n;
      const finished = log.append({
        kind: 'cycle.finished',
        cycle,
        startedAt,
        durationMs: this.nowMs() - startedAt,
        mode,
        polled: accountsPolled.length > 0,
        accountsPolled,
        ...counts,
        ausdSpent: formatUnits(ausdSpent, AUSD_DECIMALS),
        ethSpent: formatEther(ethSpent),
        nextAt: this.nextAt ?? startedAt + this.cycleMs,
      });
      this.lastCycle = finished as CycleFinished;
      this.cyclesRun += 1;
      for (const key of Object.keys(counts) as (keyof CycleCounts)[]) this.totals[key] += counts[key];
      this.totals.ausdSpent += ausdSpent;
      this.totals.ethSpent += ethSpent;
    } catch (error) {
      // Only the summary itself can land here; the heartbeat must not stop over it
      log.append({ kind: 'error', where: `cycle ${cycle} step summary`, message: errorMessage(error) });
    } finally {
      unsubscribe();
    }
  }
}
