import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import type { Rule } from '../src/chain/vault.ts';
import { Budget, readBudgetSettings } from '../src/engine/budget.ts';
import { CycleRunner } from '../src/engine/cycle.ts';
import { SourceGuard } from '../src/engine/sources.ts';
import { basescanAddress, buildStatus } from '../src/engine/status.ts';
import { EventLog } from '../src/log.ts';

const AGENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('the status reports schedule, mode, wallets, budgets and totals as plain JSON', async () => {
  const clock = { ms: 1_793_400_000_000 };
  const log = new EventLog({ now: () => clock.ms });
  const wallet = { eth: 10n ** 16n };
  const budget = new Budget({
    settings: readBudgetSettings({}),
    log,
    nowMs: () => clock.ms,
    readBalances: async () => ({ ...wallet }),
  });
  const cycles = new CycleRunner({
    log,
    nowMs: () => clock.ms,
    health: budget,
    watchlist: [{ handle: 'demo', label: 'demo', assets: ['ETH'], pinned: false }],
    vault: { listRules: async () => [{ paused: false, accounts: { demo: ['ETH'] } } as unknown as Rule] },
    engine: {
      checkPending: async () => {},
      pollAccount: async () => {
        log.append({ kind: 'post.seen', account: 'demo', postId: '1', text: 'ETH', createdAt: 0 });
        // The poll cost 0.001 USD
        log.append({ kind: 'cost', costKind: 'post-fetch', source: 'getxapi', usd: 0.001, units: 1, users: [] });
        clock.ms += 1_500;
      },
    },
    keeper: { tick: async () => {} },
  });

  const startedAt = clock.ms;
  await cycles.tick();
  clock.ms += 10_000;
  const report = buildStatus({
    cycles,
    budget,
    sources: new SourceGuard({ log }),
    agent: AGENT,
    postSource: 'getxapi',
    classifier: 'keywords',
    startedAt,
    restarts: 2,
    cycleIntervalSec: 30,
    pollIntervalSec: 60,
    nowMs: () => clock.ms,
  });

  // JSON-safe: no bigint anywhere, so the console and the frontend read it as is
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(report.uptimeSec, 11);
  assert.equal(report.restarts, 2);
  assert.equal(report.mode, 'normal');
  assert.equal(report.schedule.cyclesRun, 1);
  assert.equal(report.schedule.lastCycle, 1);
  assert.equal(report.schedule.lastCycleAgeSec, 10);
  assert.equal(report.schedule.nextAt, startedAt + 30_000);
  assert.deepEqual(report.watchSet, ['demo']);
  assert.deepEqual(report.wallets.agent, { address: AGENT, link: basescanAddress(AGENT), eth: '0.01' });
  assert.deepEqual(report.data, { posts: 'getxapi', classifier: 'keywords', prices: 'Pyth (Hermes)' });
  assert.deepEqual(report.budget?.data, { spentTodayUsd: '0.0000', limitUsd: '1.00' });
  assert.equal(report.totals.posts, 1);
  assert.equal(report.totals.costUsd, '0.0010');
  assert.equal(report.totals.cycles, 1);
});

test('without a budget or a payer the status still serializes, with nulls', async () => {
  const log = new EventLog();
  const cycles = new CycleRunner({
    log,
    watchlist: [],
    vault: { listRules: async () => [] },
    engine: { checkPending: async () => {}, pollAccount: async () => {} },
    keeper: { tick: async () => {} },
  });
  const report = buildStatus({ cycles, agent: AGENT, startedAt: Date.now(), restarts: 0, cycleIntervalSec: 30, pollIntervalSec: 60 });
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(report.data.posts, null);
  assert.equal(report.budget, null);
  assert.equal(report.schedule.lastCycle, null);
  assert.equal(report.schedule.lastCycleAgeSec, null);
});
