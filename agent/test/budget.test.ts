import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEther } from 'viem';
import { type Rule, TxTimeout, VaultRejection, type VaultPort } from '../src/chain/vault.ts';
import { Budget, BudgetRefusal, budgetedFetch, GuardedVault, readBudgetSettings } from '../src/engine/budget.ts';
import type { Balances } from '../src/engine/cycle.ts';
import { CycleRunner } from '../src/engine/cycle.ts';
import { EventLog } from '../src/log.ts';
import type { PriceUpdate } from '../src/pyth/hermes.ts';

const settings = readBudgetSettings({});
const DAY_MS = 86_400_000;
// 2026-10-31T12:00:00Z
const NOON = 1_793_448_000_000;
const update: PriceUpdate = { updates: [], prices: [] };

const setup = ({ eth = '0.02', usd = 0 } = {}) => {
  const clock = { ms: NOON };
  const log = new EventLog({ now: () => clock.ms });
  const wallet: Balances = { eth: parseEther(eth) };
  // What the cost ledger says the agent spent on data today
  const data = { usd };
  const budget = new Budget({
    settings,
    log,
    nowMs: () => clock.ms,
    readBalances: async () => ({ ...wallet }),
    dataSpentToday: () => data.usd,
  });
  const modes = () =>
    log.recent().flatMap((event) => (event.kind === 'budget.mode' ? [[event.mode, event.reason]] : []));
  return { clock, log, wallet, data, budget, modes };
};

test('the defaults: a dollar a day for data, 0.005 ETH for gas', () => {
  assert.deepEqual(settings, {
    dataUsdPerDay: 1,
    ethPerDay: parseEther('0.005'),
    minEth: parseEther('0.0005'),
    maxTxPerHour: 30,
    savingAtPct: 80,
  });
  assert.equal(readBudgetSettings({ AGENT_BUDGET_USD_PER_DAY: '0.25' }).dataUsdPerDay, 0.25);
});

test('gas spent today is the day-start balance minus the current one, and a top-up is not spending', async () => {
  const { budget, wallet } = setup();
  await budget.check();
  wallet.eth -= parseEther('0.001');
  await budget.check();
  assert.deepEqual(budget.spentToday(), { eth: parseEther('0.001') });
  wallet.eth += parseEther('1');
  await budget.check();
  wallet.eth -= parseEther('0.0005');
  await budget.check();
  assert.equal(budget.spentToday().eth, parseEther('0.0015'));
});

test('a new UTC day captures a fresh day-start balance', async () => {
  const { budget, wallet, clock } = setup();
  await budget.check();
  wallet.eth -= parseEther('0.0045');
  await budget.check();
  assert.equal(budget.mode, 'saving');
  clock.ms = Math.ceil(NOON / DAY_MS) * DAY_MS;
  await budget.check();
  assert.equal(budget.spentToday().eth, 0n);
  assert.equal(budget.mode, 'normal');
});

test('the data budget saves at 80% and halts when used up, each change logged once', async () => {
  const { budget, data, modes } = setup();
  await budget.check();
  await budget.check();
  data.usd = 0.8;
  await budget.check();
  await budget.check();
  data.usd = 1;
  await budget.check();
  assert.deepEqual(modes(), [
    ['normal', 'within budget'],
    ['saving', 'data budget at 80% or more ($0.8000 of $1.0000)'],
    ['halted', 'data budget for today used up ($1.0000 of $1.0000)'],
  ]);
  assert.deepEqual(setup().log.recent(), []);
});

test('low ETH: within 2x of the minimum saves, below it halts', async () => {
  const low = setup({ eth: '0.0009' });
  await low.budget.check();
  assert.deepEqual(low.modes(), [['saving', 'agent ETH within 2x of its minimum (0.0009 ETH)']]);
  low.wallet.eth = parseEther('0.0004');
  await low.budget.check();
  assert.equal(low.budget.mode, 'halted');
  assert.match(String(low.modes()[1]?.[1]), /agent ETH below its minimum \(0.0004 ETH < 0.0005 ETH\)/);
  const gas = setup();
  await gas.budget.check();
  gas.wallet.eth -= parseEther('0.005');
  await gas.budget.check();
  assert.match(String(gas.modes()[1]?.[1]), /gas budget for today used up/);
});

// A vault that records each write and answers it
const recordingVault = () => {
  const writes: string[] = [];
  const vault: VaultPort = {
    kind: 'onchain',
    keeperSellKinds: ['take-profit', 'stop-loss', 'stagnation'],
    listRules: async () => [] as Rule[],
    listPositions: async () => [],
    openTrigger: async () => {
      writes.push('openTrigger');
      return { triggerId: '1' };
    },
    confirmTrigger: async (triggerId) => {
      writes.push('confirmTrigger');
      return { triggerId, positionId: '1', usdcIn: 0n, assetOut: 0n, price: 0n };
    },
    expireTrigger: async () => {
      writes.push('expireTrigger');
    },
    sell: async (positionId) => {
      writes.push('sell');
      return { positionId, usdcOut: 0n, price: 0n };
    },
  };
  return { vault, writes };
};

const tryAll = async (guarded: GuardedVault) => {
  const outcome: Record<string, string> = {};
  const attempt = async (name: string, call: () => Promise<unknown>) => {
    try {
      await call();
      outcome[name] = 'sent';
    } catch (error) {
      outcome[name] = error instanceof BudgetRefusal ? 'refused' : 'failed';
    }
  };
  await attempt('openTrigger', () => guarded.openTrigger({ ruleId: 'r', asset: 'ETH', account: 'a', postId: '1', p0: update }));
  await attempt('confirmTrigger', () => guarded.confirmTrigger('1', update));
  await attempt('expireTrigger', () => guarded.expireTrigger('1'));
  await attempt('sell', () => guarded.sell('1', 'stop-loss', update));
  return outcome;
};

test('saving still sends Gate 2 confirmations, expiries and sells', async () => {
  const { budget, data } = setup();
  data.usd = 0.9;
  await budget.check();
  assert.equal(budget.mode, 'saving');
  const { vault, writes } = recordingVault();
  assert.deepEqual(await tryAll(new GuardedVault(vault, budget)), {
    openTrigger: 'sent',
    confirmTrigger: 'sent',
    expireTrigger: 'sent',
    sell: 'sent',
  });
  assert.equal(writes.length, 4);
});

test('halted refuses every write but expireTrigger, and that one only with ETH for its gas', async () => {
  const { budget, data, wallet } = setup();
  data.usd = 2;
  await budget.check();
  assert.equal(budget.mode, 'halted');
  const { vault, writes } = recordingVault();
  const guarded = new GuardedVault(vault, budget);
  assert.deepEqual(await tryAll(guarded), {
    openTrigger: 'refused',
    confirmTrigger: 'refused',
    expireTrigger: 'sent',
    sell: 'refused',
  });
  assert.deepEqual(writes, ['expireTrigger']);
  wallet.eth = parseEther('0.0001');
  await budget.check();
  assert.equal((await tryAll(guarded)).expireTrigger, 'refused');
  assert.deepEqual(await guarded.listRules(), []);
});

test('the hourly transaction cap refuses the 31st write in a rolling hour', async () => {
  const { budget, clock } = setup();
  await budget.check();
  const { vault, writes } = recordingVault();
  const guarded = new GuardedVault(vault, budget);
  for (let index = 0; index < 30; index += 1) {
    await guarded.expireTrigger(String(index));
    clock.ms += 60_000;
  }
  await assert.rejects(guarded.expireTrigger('31'), /30 transactions in the last hour/);
  clock.ms = NOON + 3_600_000 + 1;
  await guarded.expireTrigger('32');
  assert.equal(writes.length, 31);
  assert.equal(budget.status().txLastHour, 30);
});

test('a refused write and a vault rejection are not counted; a timed-out one is', async () => {
  const { budget, data } = setup();
  data.usd = 2;
  await budget.check();
  await assert.rejects(new GuardedVault(recordingVault().vault, budget).sell('1', 'take-profit', update), BudgetRefusal);
  assert.equal(budget.status().txLastHour, 0);

  data.usd = 0;
  await budget.check();
  const rejecting = recordingVault().vault;
  rejecting.confirmTrigger = async () => {
    throw new VaultRejection('TrendTooWeak');
  };
  await assert.rejects(new GuardedVault(rejecting, budget).confirmTrigger('1', update), VaultRejection);
  assert.equal(budget.status().txLastHour, 0);

  const stuck = recordingVault().vault;
  stuck.expireTrigger = async () => {
    throw new TxTimeout('0x01', 90_000);
  };
  await assert.rejects(new GuardedVault(stuck, budget).expireTrigger('1'), TxTimeout);
  assert.equal(budget.status().txLastHour, 1);
});

test('a paid post call is refused while halted; other calls always pass', async () => {
  const { budget, data } = setup();
  const called: string[] = [];
  const inner: typeof fetch = async (input) => {
    called.push(String(input));
    return new Response('{}');
  };
  const fetchWithBudget = budgetedFetch(inner, ['https://api.getxapi.com/'], budget);
  await budget.check();
  await fetchWithBudget('https://api.getxapi.com/twitter/tweet/advanced_search');
  data.usd = 1;
  await budget.check();
  await assert.rejects(fetchWithBudget('https://api.getxapi.com/x'), /halted, no paid call to api.getxapi.com/);
  await fetchWithBudget(new URL('https://hermes.pyth.network/v2/updates/price/latest'));
  assert.equal(called.length, 2);
});

test('in a cycle, saving skips the post poll while Gate 2 and the keeper still run', async () => {
  const { budget, data, log } = setup();
  data.usd = 0.9;
  const calls: string[] = [];
  const cycles = new CycleRunner({
    log,
    health: budget,
    watchlist: [{ handle: 'demo', label: 'demo', assets: ['ETH'] }],
    vault: { listRules: async () => [{ paused: false, accounts: { demo: ['ETH'] } } as unknown as Rule] },
    engine: {
      checkPending: async () => void calls.push('gate2'),
      pollAccount: async () => void calls.push('gate1'),
    },
    keeper: { tick: async () => void calls.push('keeper') },
  });
  await cycles.tick();
  assert.deepEqual(calls, ['gate2', 'keeper']);
  const finished = log.recent().find((event) => event.kind === 'cycle.finished');
  assert.equal(finished?.kind === 'cycle.finished' && finished.mode, 'saving');
});
