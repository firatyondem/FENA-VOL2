// The agent's own money: USD for data (post fetches and model calls, from the cost ledger) and ETH for gas and Pyth's
// fees (the agent wallet). The vault guards the users' money; this guards the agent's. Every cycle reads both and picks
// a mode:
// - normal: everything allowed
// - saving: no new post polls, so no new triggers, but open triggers still get Gate 2, expiries and sells
// - halted: no paid calls and no transactions, except expireTrigger while the agent can pay its gas
// The checks sit in wrappers around the fetch and the vault, never inside the engine.
import { formatEther, parseEther } from 'viem';
import { type OpenTriggerInput, type SellKind, TxTimeout, type VaultPort } from '../chain/vault.ts';
import type { EventLog } from '../log.ts';
import type { PriceUpdate } from '../pyth/hermes.ts';
import type { AgentMode, Balances, HealthPort } from './cycle.ts';

export interface BudgetSettings {
  // Most USD the agent may spend on data (posts and model calls) per UTC day
  dataUsdPerDay: number;
  // Most ETH (wei) the agent wallet may spend on gas and Pyth's fees per UTC day
  ethPerDay: bigint;
  // Below this the agent sends no transaction
  minEth: bigint;
  // Hard cap on transactions per rolling hour
  maxTxPerHour: number;
  // Share of a daily budget, in percent, at which saving mode starts
  savingAtPct: number;
}

export const readBudgetSettings = (env: NodeJS.ProcessEnv = process.env): BudgetSettings => ({
  dataUsdPerDay: Number(env.AGENT_BUDGET_USD_PER_DAY || 1),
  ethPerDay: parseEther(env.AGENT_BUDGET_ETH_PER_DAY || '0.005'),
  minEth: parseEther(env.AGENT_MIN_ETH || '0.0005'),
  maxTxPerHour: Number(env.AGENT_MAX_TX_PER_HOUR || 30),
  savingAtPct: Number(env.AGENT_SAVING_AT_PCT || 80),
});

// A call or a transaction that the agent's own limits refuse. The engine treats it like any passing failure and tries
// again on a later cycle, which is right: the mode may change by then.
export class BudgetRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Budget: ${reason}`);
    this.name = 'BudgetRefusal';
    this.reason = reason;
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const atLeastZero = (value: bigint) => (value > 0n ? value : 0n);
const usd = (value: number) => `$${value.toFixed(4)}`;
const eth = (value: bigint) => `${formatEther(value)} ETH`;

export interface BudgetDeps {
  settings: BudgetSettings;
  // The agent wallet's ETH
  readBalances: () => Promise<Balances>;
  // USD spent on data today, from the cost ledger; 0 without one
  dataSpentToday?: () => number;
  log: EventLog;
  // Milliseconds since the epoch
  nowMs?: () => number;
}

export interface BudgetStatus {
  mode: AgentMode;
  reason: string;
  balances?: Balances;
  dataUsdToday: number;
  ethSpentToday: bigint;
  settings: BudgetSettings;
  txLastHour: number;
}

export class Budget implements HealthPort {
  private readonly deps: BudgetDeps;
  private readonly nowMs: () => number;
  private day: number | undefined;
  private dayStart: Balances | undefined;
  private last: Balances | undefined;
  private current: { mode: AgentMode; reason: string } | undefined;
  private readonly txTimes: number[] = [];

  constructor(deps: BudgetDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? Date.now;
  }

  get mode(): AgentMode {
    return this.current?.mode ?? 'normal';
  }

  private dataToday(): number {
    return this.deps.dataSpentToday?.() ?? 0;
  }

  // Cycle step 1: read the balance and the ledger, account for the day, and pick the mode
  async check(): Promise<{ mode: AgentMode; balances: Balances }> {
    const balances = await this.deps.readBalances();
    this.observe(balances);
    const next = this.evaluate(balances);
    if (next.mode !== this.current?.mode) {
      this.deps.log.append({
        kind: 'budget.mode',
        mode: next.mode,
        reason: next.reason,
        dataUsdToday: this.dataToday().toFixed(4),
        ethSpentToday: formatEther(this.spentToday().eth),
        ethBalance: formatEther(balances.eth),
      });
    }
    this.current = next;
    return { mode: next.mode, balances };
  }

  readBalances(): Promise<Balances> {
    return this.deps.readBalances();
  }

  // Spent today = the day-start balance minus the current one. A rise is a top-up and raises the day-start figure, so it
  // never counts as negative spending.
  private observe(balances: Balances) {
    const day = Math.floor(this.nowMs() / DAY_MS);
    if (day !== this.day || !this.dayStart || !this.last) {
      this.day = day;
      this.dayStart = { ...balances };
      this.last = { ...balances };
      return;
    }
    if (balances.eth > this.last.eth) this.dayStart.eth += balances.eth - this.last.eth;
    this.last = { ...balances };
  }

  spentToday(): Balances {
    if (!this.dayStart || !this.last) return { eth: 0n };
    return { eth: atLeastZero(this.dayStart.eth - this.last.eth) };
  }

  private evaluate(balances: Balances): { mode: AgentMode; reason: string } {
    const { settings } = this.deps;
    const halted: string[] = [];
    const saving: string[] = [];
    const data = this.dataToday();
    if (data >= settings.dataUsdPerDay) {
      halted.push(`data budget for today used up (${usd(data)} of ${usd(settings.dataUsdPerDay)})`);
    } else if (data * 100 >= settings.dataUsdPerDay * settings.savingAtPct) {
      saving.push(`data budget at ${settings.savingAtPct}% or more (${usd(data)} of ${usd(settings.dataUsdPerDay)})`);
    }
    const gas = this.spentToday().eth;
    if (gas >= settings.ethPerDay) {
      halted.push(`gas budget for today used up (${eth(gas)} of ${eth(settings.ethPerDay)})`);
    } else if (gas * 100n >= settings.ethPerDay * BigInt(settings.savingAtPct)) {
      saving.push(`gas budget at ${settings.savingAtPct}% or more (${eth(gas)} of ${eth(settings.ethPerDay)})`);
    }
    if (balances.eth < settings.minEth) halted.push(`agent ETH below its minimum (${eth(balances.eth)} < ${eth(settings.minEth)})`);
    else if (balances.eth < 2n * settings.minEth) saving.push(`agent ETH within 2x of its minimum (${eth(balances.eth)})`);
    if (halted.length > 0) return { mode: 'halted', reason: halted.join('; ') };
    if (saving.length > 0) return { mode: 'saving', reason: saving.join('; ') };
    return { mode: 'normal', reason: 'within budget' };
  }

  // The modes that may make a paid call: everything but halted. Saving still pays for what open triggers need.
  allowsPaidCalls(): boolean {
    return this.mode !== 'halted';
  }

  private txLastHour(): number {
    const since = this.nowMs() - HOUR_MS;
    while (this.txTimes.length > 0 && (this.txTimes[0] ?? 0) <= since) this.txTimes.shift();
    return this.txTimes.length;
  }

  // Throws when the agent's limits forbid this write
  assertWrite(functionName: 'openTrigger' | 'confirmTrigger' | 'expireTrigger' | 'sell'): void {
    const { settings } = this.deps;
    if (this.mode === 'halted') {
      if (functionName !== 'expireTrigger') throw new BudgetRefusal(`halted, no ${functionName}: ${this.current?.reason}`);
      if ((this.last?.eth ?? 0n) < settings.minEth) throw new BudgetRefusal('halted, no ETH for the gas of expireTrigger');
    }
    if (this.txLastHour() >= settings.maxTxPerHour) {
      throw new BudgetRefusal(`${settings.maxTxPerHour} transactions in the last hour, the most allowed`);
    }
  }

  recordTransaction(): void {
    this.txTimes.push(this.nowMs());
  }

  status(): BudgetStatus {
    return {
      mode: this.mode,
      reason: this.current?.reason ?? 'not checked yet',
      ...(this.last ? { balances: { ...this.last } } : {}),
      dataUsdToday: this.dataToday(),
      ethSpentToday: this.spentToday().eth,
      settings: this.deps.settings,
      txLastHour: this.txLastHour(),
    };
  }
}

// Refuses a call to a paid data source while the budget forbids paid calls; other calls always pass.
export const budgetedFetch =
  (inner: typeof fetch, pricedUrls: readonly string[], budget: Pick<Budget, 'allowsPaidCalls' | 'mode'>): typeof fetch =>
  async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (pricedUrls.some((priced) => url.startsWith(priced)) && !budget.allowsPaidCalls()) {
      throw new BudgetRefusal(`${budget.mode}, no paid call to ${new URL(url).host}`);
    }
    return inner(input, init);
  };

// The vault, behind the agent's own limits. Reads pass through; each write must pass the budget first, and counts
// toward the hourly cap once it went through.
export class GuardedVault implements VaultPort {
  readonly kind: VaultPort['kind'];
  readonly keeperSellKinds: readonly SellKind[];
  private readonly inner: VaultPort;
  private readonly budget: Pick<Budget, 'assertWrite' | 'recordTransaction'>;

  constructor(inner: VaultPort, budget: Pick<Budget, 'assertWrite' | 'recordTransaction'>) {
    this.inner = inner;
    this.budget = budget;
    this.kind = inner.kind;
    this.keeperSellKinds = inner.keeperSellKinds;
  }

  listRules() {
    return this.inner.listRules();
  }

  listPositions() {
    return this.inner.listPositions();
  }

  listOpenTriggers() {
    return this.inner.listOpenTriggers?.() ?? Promise.resolve([]);
  }

  private async write<T>(functionName: Parameters<Budget['assertWrite']>[0], send: () => Promise<T>): Promise<T> {
    this.budget.assertWrite(functionName);
    try {
      const result = await send();
      this.budget.recordTransaction();
      return result;
    } catch (error) {
      // A timed-out transaction was sent and may still cost gas, so it counts toward the hourly cap
      if (error instanceof TxTimeout) this.budget.recordTransaction();
      throw error;
    }
  }

  openTrigger(input: OpenTriggerInput) {
    return this.write('openTrigger', () => this.inner.openTrigger(input));
  }

  confirmTrigger(triggerId: string, p1: PriceUpdate) {
    return this.write('confirmTrigger', () => this.inner.confirmTrigger(triggerId, p1));
  }

  expireTrigger(triggerId: string) {
    return this.write('expireTrigger', () => this.inner.expireTrigger(triggerId));
  }

  sell(positionId: string, kind: SellKind, price: PriceUpdate) {
    return this.write('sell', () => this.inner.sell(positionId, kind, price));
  }
}
