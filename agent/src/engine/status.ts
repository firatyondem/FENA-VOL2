// What the Engine Room shows: the agent's schedule, mode, budgets, wallets and totals, as plain JSON (no bigints), so the
// console can render it and the frontend can read it from /api/state.
import { type Address, formatEther, formatUnits } from 'viem';
import { AUSD_DECIMALS } from '../airnode/client.ts';
import type { Budget } from './budget.ts';
import type { CycleRunner } from './cycle.ts';
import type { SourceGuard } from './sources.ts';

export const basescanAddress = (address: Address) => `https://sepolia.basescan.org/address/${address}`;

export interface StatusDeps {
  cycles: Pick<CycleRunner, 'status'>;
  budget?: Pick<Budget, 'status'>;
  sources?: Pick<SourceGuard, 'status'>;
  agent: Address;
  payer?: Address;
  // Milliseconds since the epoch
  startedAt: number;
  restarts: number;
  cycleIntervalSec: number;
  pollIntervalSec: number;
  nowMs?: () => number;
}

const ausd = (value: bigint) => formatUnits(value, AUSD_DECIMALS);

export const buildStatus = ({
  cycles,
  budget,
  sources,
  agent,
  payer,
  startedAt,
  restarts,
  cycleIntervalSec,
  pollIntervalSec,
  nowMs = Date.now,
}: StatusDeps) => {
  const now = nowMs();
  const cycle = cycles.status();
  const money = budget?.status();
  const last = cycle.lastCycle;
  const lastFinishedAt = last ? last.startedAt + last.durationMs : undefined;
  const { totals } = cycle;
  return {
    generatedAt: now,
    startedAt,
    uptimeSec: Math.floor((now - startedAt) / 1000),
    restarts,
    mode: money?.mode ?? cycle.mode,
    modeReason: money?.reason ?? 'no budget in this mode',
    schedule: {
      cycleIntervalSec,
      pollIntervalSec,
      cyclesRun: cycle.cyclesRun,
      cyclesSkipped: cycle.cyclesSkipped,
      running: cycle.running,
      lastCycle: last?.cycle ?? null,
      lastFinishedAt: lastFinishedAt ?? null,
      lastCycleAgeSec: lastFinishedAt === undefined ? null : Math.max(0, Math.floor((now - lastFinishedAt) / 1000)),
      nextAt: cycle.nextAt ?? null,
    },
    watchSet: cycle.watchSet,
    wallets: {
      agent: { address: agent, link: basescanAddress(agent), eth: money?.balances ? formatEther(money.balances.eth) : null },
      payer: payer
        ? { address: payer, link: basescanAddress(payer), ausd: money?.balances ? ausd(money.balances.ausd) : null }
        : null,
    },
    budget: money
      ? {
          ausd: {
            tracked: money.trackAusd,
            spentToday: ausd(money.ausdSpentToday),
            limit: ausd(money.settings.ausdPerDay),
            min: ausd(money.settings.minAusd),
          },
          eth: {
            spentToday: formatEther(money.ethSpentToday),
            limit: formatEther(money.settings.ethPerDay),
            min: formatEther(money.settings.minEth),
          },
          txLastHour: money.txLastHour,
          maxTxPerHour: money.settings.maxTxPerHour,
          savingAtPct: money.settings.savingAtPct,
        }
      : null,
    totals: {
      cycles: cycle.cyclesRun,
      skipped: cycle.cyclesSkipped,
      posts: totals.postsNew,
      triggers: totals.triggersOpened,
      p1Checks: totals.p1Checks,
      buys: totals.bought,
      sells: totals.sold,
      rejected: totals.rejected,
      expired: totals.expired,
      paidCalls: totals.paidCalls,
      txSent: totals.txSent,
      errors: totals.errors,
      ausdSpent: ausd(totals.ausdSpent),
      ethSpent: formatEther(totals.ethSpent),
    },
    sources: sources?.status() ?? {},
  };
};

export type AgentStatus = ReturnType<typeof buildStatus>;
