import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEther, parseUnits } from 'viem';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { type Rule, TxTimeout, VaultRejection, type VaultPort } from '../src/chain/vault.ts';
import {
  Budget,
  BudgetRefusal,
  budgetedFetch,
  GuardedVault,
  readBudgetSettings,
} from '../src/engine/budget.ts';
import type { Balances } from '../src/engine/cycle.ts';
import { CycleRunner } from '../src/engine/cycle.ts';
import { EventLog } from '../src/log.ts';

const settings = readBudgetSettings({});
const DAY_MS = 86_400_000;
const aUSD = (text: string) => parseUnits(text, 6);
// 2026-10-31T12:00:00Z
const NOON = 1_793_448_000_000;

const setup = ({ ausd = '3', eth = '0.02', trackAusd = true } = {}) => {
  const clock = { ms: NOON };
  const log = new EventLog({ now: () => clock.ms });
  const wallet: Balances = { ausd: aUSD(ausd), eth: parseEther(eth) };
  const budget = new Budget({
    settings,
    log,
    trackAusd,
    nowMs: () => clock.ms,
    readBalances: async () => ({ ...wallet }),
  });
  const modes = () =>
    log.recent().flatMap((event) => (event.kind === 'budget.mode' ? [[event.mode, event.reason]] : []));
  return { clock, log, wallet, budget, modes };
};

test('the defaults are the spec settings', () => {
  assert.deepEqual(settings, {
    ausdPerDay: aUSD('3'),
    ethPerDay: parseEther('0.005'),
    minEth: parseEther('0.0005'),
    minAusd: aUSD('0.2'),
    maxTxPerHour: 30,
    savingAtPct: 80,
  });
  assert.equal(readBudgetSettings({ AGENT_BUDGET_AUSD_PER_DAY: '0.05' }).ausdPerDay, 50_000n);
});

test('spent today is the day-start balance minus the current one, and a top-up is not spending', async () => {
  const { budget, wallet } = setup();
  await budget.check();
  wallet.ausd -= aUSD('0.4');
  wallet.eth -= parseEther('0.001');
  await budget.check();
  assert.deepEqual(budget.spentToday(), { ausd: aUSD('0.4'), eth: parseEther('0.001') });

  // A top-up of 5 aUSD, then 0.1 more spent: today's spending is 0.5, not negative
  wallet.ausd += aUSD('5');
  await budget.check();
  wallet.ausd -= aUSD('0.1');
  await budget.check();
  assert.equal(budget.spentToday().ausd, aUSD('0.5'));
});

test('a new UTC day captures fresh day-start balances', async () => {
  const { budget, wallet, clock } = setup();
  await budget.check();
  wallet.ausd -= aUSD('2.5');
  await budget.check();
  assert.equal(budget.mode, 'saving');
  // Midnight UTC: what was spent yesterday no longer counts
  clock.ms = Math.ceil(NOON / DAY_MS) * DAY_MS;
  await budget.check();
  assert.equal(budget.spentToday().ausd, 0n);
  assert.equal(budget.mode, 'normal');
});

test('each mode change is logged once with its reason, and the first check is logged too', async () => {
  const { budget, wallet, modes } = setup();
  await budget.check();
  await budget.check();
  // 2.4 of 3 aUSD is 80%: saving
  wallet.ausd -= aUSD('2.4');
  await budget.check();
  await budget.check();
  // 3 of 3: halted
  wallet.ausd -= aUSD('0.6');
  await budget.check();
  assert.deepEqual(modes(), [
    ['normal', 'within budget'],
    ['saving', 'aUSD budget at 80% or more (2.4 aUSD of 3 aUSD)'],
    [
      'halted',
      'aUSD budget for today used up (3 aUSD of 3 aUSD); payer aUSD below its minimum (0 aUSD < 0.2 aUSD)',
    ],
  ]);
  // Before the first check nothing is logged
  assert.deepEqual(setup().log.recent(), []);
});

test('low balances: within 2x of a minimum saves, below it halts', async () => {
  const lowEth = setup({ eth: '0.0009' });
  await lowEth.budget.check();
  assert.deepEqual(lowEth.modes(), [['saving', 'agent ETH within 2x of its minimum (0.0009 ETH)']]);
  lowEth.wallet.eth = parseEther('0.0004');
  await lowEth.budget.check();
  assert.equal(lowEth.budget.mode, 'halted');
  assert.match(String(lowEth.modes()[1]?.[1]), /agent ETH below its minimum \(0.0004 ETH < 0.0005 ETH\)/);

  const lowAusd = setup({ ausd: '0.3' });
  await lowAusd.budget.check();
  assert.equal(lowAusd.budget.mode, 'saving');
  // A gas budget used up halts too
  const gas = setup();
  await gas.budget.check();
  gas.wallet.eth -= parseEther('0.005');
  await gas.budget.check();
  assert.match(String(gas.modes()[1]?.[1]), /gas budget for today used up/);
});

test('without a payer the aUSD side is off: no aUSD neither saves nor halts', async () => {
  const { budget, modes } = setup({ ausd: '0', trackAusd: false });
  await budget.check();
  assert.deepEqual(modes(), [['normal', 'within budget']]);
});

// A vault that records each write and answers it
const recordingVault = () => {
  const writes: string[] = [];
  const response = {} as SignedResponse;
  const vault: VaultPort = {
    kind: 'onchain',
    keeperSellKinds: ['take-profit', 'stagnation'],
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
  return { vault, writes, response };
};

const tryAll = async (guarded: GuardedVault, response: SignedResponse) => {
  const outcome: Record<string, string> = {};
  const attempt = async (name: string, call: () => Promise<unknown>) => {
    try {
      await call();
      outcome[name] = 'sent';
    } catch (error) {
      outcome[name] = error instanceof BudgetRefusal ? 'refused' : 'failed';
    }
  };
  await attempt('openTrigger', () => guarded.openTrigger({ ruleId: 'r', asset: 'ETH', account: 'a', post: response, p0: response }));
  await attempt('confirmTrigger', () => guarded.confirmTrigger('1', response));
  await attempt('expireTrigger', () => guarded.expireTrigger('1'));
  await attempt('sell', () => guarded.sell('1', 'take-profit', response));
  return outcome;
};

test('saving still sends Gate 2 confirmations, expiries and sells', async () => {
  const { budget, wallet } = setup();
  wallet.ausd = aUSD('0.3');
  await budget.check();
  assert.equal(budget.mode, 'saving');
  const { vault, response, writes } = recordingVault();
  const outcome = await tryAll(new GuardedVault(vault, budget), response);
  assert.deepEqual(outcome, { openTrigger: 'sent', confirmTrigger: 'sent', expireTrigger: 'sent', sell: 'sent' });
  assert.equal(writes.length, 4);
});

test('halted refuses every write but expireTrigger, and that one only with ETH for its gas', async () => {
  const { budget, wallet } = setup();
  wallet.ausd = aUSD('0.1');
  await budget.check();
  assert.equal(budget.mode, 'halted');
  const { vault, response, writes } = recordingVault();
  const guarded = new GuardedVault(vault, budget);
  assert.deepEqual(await tryAll(guarded, response), {
    openTrigger: 'refused',
    confirmTrigger: 'refused',
    expireTrigger: 'sent',
    sell: 'refused',
  });
  assert.deepEqual(writes, ['expireTrigger']);

  wallet.eth = parseEther('0.0001');
  await budget.check();
  assert.equal((await tryAll(guarded, response)).expireTrigger, 'refused');
  // Reads pass through in any mode
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
  await assert.rejects(guarded.expireTrigger('31'), (error: unknown) => {
    assert.ok(error instanceof BudgetRefusal);
    assert.equal(error.reason, '30 transactions in the last hour, the most allowed');
    return true;
  });
  // An hour after the first write, it has left the window
  clock.ms = NOON + 3_600_000 + 1;
  await guarded.expireTrigger('32');
  assert.equal(writes.length, 31);
  assert.equal(budget.status().txLastHour, 30);
});

test('a refused write is not counted, and a vault rejection is not counted either', async () => {
  const { budget, wallet } = setup();
  wallet.ausd = aUSD('0.1');
  await budget.check();
  const guarded = new GuardedVault(recordingVault().vault, budget);
  await assert.rejects(guarded.sell('1', 'take-profit', {} as SignedResponse), BudgetRefusal);
  assert.equal(budget.status().txLastHour, 0);

  // Back to normal: a write the vault's simulation rejects sent no transaction, so it does not count
  wallet.ausd = aUSD('3');
  await budget.check();
  const rejecting = recordingVault().vault;
  rejecting.confirmTrigger = async () => {
    throw new VaultRejection('TrendTooWeak');
  };
  await assert.rejects(new GuardedVault(rejecting, budget).confirmTrigger('1', {} as SignedResponse), VaultRejection);
  assert.equal(budget.status().txLastHour, 0);
});

test('a timed-out transaction was sent, so it counts toward the hourly cap', async () => {
  const { budget } = setup();
  await budget.check();
  const stuck = recordingVault().vault;
  stuck.expireTrigger = async () => {
    throw new TxTimeout('0x01', 90_000);
  };
  await assert.rejects(new GuardedVault(stuck, budget).expireTrigger('1'), TxTimeout);
  assert.equal(budget.status().txLastHour, 1);
});

test('a paid call is refused while halted; free Airnodes always pass', async () => {
  const { budget, wallet } = setup();
  const called: string[] = [];
  const inner: typeof fetch = async (input) => {
    called.push(String(input));
    return new Response('{}');
  };
  const priced = ['https://airnode-twitterapi.fly.dev/', 'https://airnode-tickerlayer.fly.dev/'];
  const fetchWithBudget = budgetedFetch(inner, priced, budget);

  await budget.check();
  await fetchWithBudget('https://airnode-twitterapi.fly.dev/');
  wallet.ausd = aUSD('0.3');
  await budget.check();
  // Saving still pays, for the P1 of an open trigger
  await fetchWithBudget('https://airnode-tickerlayer.fly.dev/');
  wallet.ausd = aUSD('0.1');
  await budget.check();
  await assert.rejects(fetchWithBudget('https://airnode-twitterapi.fly.dev/'), (error: unknown) => {
    assert.ok(error instanceof BudgetRefusal);
    assert.equal(error.reason, 'halted, no paid call to airnode-twitterapi.fly.dev');
    return true;
  });
  await fetchWithBudget(new URL('https://airnode-nodary.fly.dev/'));
  assert.deepEqual(called, [
    'https://airnode-twitterapi.fly.dev/',
    'https://airnode-tickerlayer.fly.dev/',
    'https://airnode-nodary.fly.dev/',
  ]);
});

test('in a cycle, saving skips the post poll while Gate 2 and the keeper still run', async () => {
  const { budget, wallet, log } = setup();
  wallet.ausd = aUSD('0.3');
  const calls: string[] = [];
  const cycles = new CycleRunner({
    log,
    health: budget,
    watchlist: [{ handle: 'demo', label: 'demo', assets: ['ETH'], pinned: false }],
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
