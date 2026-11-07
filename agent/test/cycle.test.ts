import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import type { Rule } from '../src/chain/vault.ts';
import { type AgentMode, type Balances, type CycleFinished, CycleRunner, type HealthPort } from '../src/engine/cycle.ts';
import { EventLog, type LoggedEvent } from '../src/log.ts';
import type { WatchedAccount } from '../src/sources/posts.ts';

const AGENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_AGENT: Address = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const account = (handle: string): WatchedAccount => ({ handle, label: handle, assets: ['ETH'], pinned: false });
const watchlist = [account('demo'), account('realDonaldTrump'), account('elonmusk')];

const rule = (id: string, accounts: Record<string, string[]>, { paused = false, agent = AGENT } = {}) =>
  ({ id, owner: id, agent, paused, accounts, assets: [], topics: {} }) as unknown as Rule;

// A deferred promise, to hold a step open while the test looks at the runner
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

interface HealthScript {
  mode?: AgentMode;
  before?: Balances;
  after?: Balances;
  failing?: boolean;
}

const setup = ({ rules = [rule('u1', { demo: ['ETH'] })] as Rule[], health = undefined as HealthScript | undefined } = {}) => {
  const clock = { ms: 1_793_400_000_000 };
  const log = new EventLog({ now: () => clock.ms });
  const calls: string[] = [];
  const fail = new Set<string>();
  const slow = new Map<string, Promise<void>>();
  let active = 0;
  let maxActive = 0;
  const act = async (name: string) => {
    calls.push(name);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const hold = slow.get(name);
      if (hold) await hold;
      if (fail.has(name)) throw new Error(`${name} failed`);
    } finally {
      active -= 1;
    }
  };
  const state = { rules };
  const zero: Balances = { eth: 0n };
  const healthPort: HealthPort | undefined = health && {
    check: async () => {
      calls.push('health');
      if (health.failing) throw new Error('RPC down');
      return { mode: health.mode ?? 'normal', balances: health.before ?? zero };
    },
    readBalances: async () => {
      calls.push('summary');
      return health.after ?? health.before ?? zero;
    },
  };
  const runner = new CycleRunner({
    log,
    nowMs: () => clock.ms,
    agent: AGENT,
    watchlist,
    cycleIntervalSec: 30,
    pollIntervalSec: 60,
    vault: {
      listRules: async () => {
        await act('rules');
        return state.rules;
      },
    },
    engine: {
      checkPending: () => act('gate2'),
      pollAccount: (watched) => act(`gate1:${watched.handle}`),
    },
    keeper: { tick: () => act('keeper') },
    ...(healthPort ? { health: healthPort } : {}),
  });
  const finished = () => log.recent().filter((event) => event.kind === 'cycle.finished') as (LoggedEvent & CycleFinished)[];
  return { clock, log, calls, fail, slow, runner, state, finished, maxActive: () => maxActive };
};

test('a cycle runs health, rules, Gate 2, keeper, Gate 1 and the summary, in that order', async () => {
  const { runner, calls, finished } = setup({ health: {} });
  await runner.tick();
  assert.deepEqual(calls, ['health', 'rules', 'gate2', 'keeper', 'gate1:demo', 'summary']);
  const [summary] = finished();
  assert.equal(summary?.cycle, 1);
  assert.equal(summary?.mode, 'normal');
  assert.equal(summary?.polled, true);
  assert.deepEqual(summary?.accountsPolled, ['demo']);
});

test('Gate 1 runs only once the poll interval has passed', async () => {
  const { runner, calls, clock, finished } = setup();
  await runner.tick();
  clock.ms += 30_000;
  await runner.tick();
  clock.ms += 30_000;
  await runner.tick();
  assert.deepEqual(
    calls.filter((call) => call.startsWith('gate1')),
    ['gate1:demo', 'gate1:demo']
  );
  assert.deepEqual(
    finished().map((event) => event.polled),
    [true, false, true]
  );
  // Gate 2 and the keeper run every cycle
  assert.equal(calls.filter((call) => call === 'gate2').length, 3);
  assert.equal(calls.filter((call) => call === 'keeper').length, 3);
});

test('Gate 1 polls only the active watch set, and no rule means no paid call', async () => {
  const watched = setup({
    rules: [rule('u1', { realDonaldTrump: ['ETH'], elonmusk: [] }), rule('u2', { demo: ['BTC'] })],
  });
  await watched.runner.tick();
  // elonmusk has no linked asset, and an account outside the watchlist cannot be read
  assert.deepEqual(
    watched.calls.filter((call) => call.startsWith('gate1')),
    ['gate1:demo', 'gate1:realDonaldTrump']
  );

  const none = setup({ rules: [] });
  await none.runner.tick();
  assert.deepEqual(none.calls, ['rules', 'gate2', 'keeper']);
  assert.equal(none.finished()[0]?.polled, false);
  assert.equal(none.finished()[0]?.paidCalls, 0);
});

test("a paused rule's accounts and another agent's rules are not polled", async () => {
  const { runner, calls } = setup({
    rules: [
      rule('u1', { demo: ['ETH'] }, { paused: true }),
      rule('u2', { elonmusk: ['DOGE'] }, { agent: OTHER_AGENT }),
      rule('u3', { realDonaldTrump: ['ETH'] }),
    ],
  });
  await runner.tick();
  assert.deepEqual(
    calls.filter((call) => call.startsWith('gate1')),
    ['gate1:realDonaldTrump']
  );
});

test('a slow cycle makes the next one skip, and two cycles never run at once', async () => {
  const { runner, slow, clock, log, maxActive, finished } = setup();
  const hold = deferred();
  slow.set('gate2', hold.promise);
  const first = runner.tick();
  clock.ms += 30_000;
  const second = runner.tick();
  clock.ms += 30_000;
  const third = runner.tick();

  const skipped = log.recent().filter((event) => event.kind === 'cycle.skipped');
  assert.deepEqual(
    skipped.map((event) => event.kind === 'cycle.skipped' && [event.cycle, event.reason, event.runningForMs]),
    [
      [2, 'previous cycle still running', 30_000],
      [3, 'previous cycle still running', 60_000],
    ]
  );
  hold.resolve();
  await Promise.all([first, second, third]);
  assert.equal(maxActive(), 1);
  assert.deepEqual(
    finished().map((event) => event.cycle),
    [1]
  );
  assert.deepEqual(runner.status().cyclesSkipped, 2);

  // The next due cycle runs again
  clock.ms += 30_000;
  await runner.tick();
  assert.deepEqual(
    finished().map((event) => event.cycle),
    [1, 4]
  );
});

test('a throwing step logs an error with its cycle and step, and the later steps still run', async () => {
  const { runner, calls, fail, log, finished } = setup();
  fail.add('rules');
  fail.add('keeper');
  await runner.tick();
  // Without rules the agent does not know whom to poll, so Gate 1 waits; Gate 2 and the summary still run
  assert.deepEqual(calls, ['rules', 'gate2', 'keeper']);
  const errors = log.recent().filter((event) => event.kind === 'error');
  assert.deepEqual(
    errors.map((event) => event.kind === 'error' && event.where),
    ['cycle 1 step rules', 'cycle 1 step keeper']
  );
  assert.equal(finished()[0]?.errors, 2);

  fail.clear();
  fail.add('gate2');
  await runner.tick();
  assert.deepEqual(calls.slice(3), ['rules', 'gate2', 'keeper', 'gate1:demo']);
  assert.equal(finished().length, 2);
});

test('the counters in cycle.finished match the events appended during the cycle', async () => {
  const { log, finished } = setup();
  // The steps append what the engine and keeper would; one event before the cycle must not count
  log.append({ kind: 'error', where: 'before the cycle', message: 'not counted' });
  const busy = new CycleRunner({
    log,
    watchlist,
    agent: AGENT,
    vault: { listRules: async () => [rule('u1', { demo: ['ETH'] })] },
    engine: {
      checkPending: async () => {
        log.append({ kind: 'trigger.checked', triggerId: '1', asset: 'ETH', p1: '2070', changeBps: 350, verdict: 'submitting' });
        log.append({
          kind: 'trigger.bought',
          triggerId: '1',
          positionId: '1',
          asset: 'ETH',
          usdcIn: '50',
          assetOut: '0.02',
          price: '2070',
          txHash: '0xabc',
        });
        log.append({ kind: 'trigger.expired', triggerId: '2', asset: 'BTC' });
      },
      pollAccount: async () => {
        log.append({ kind: 'cost', costKind: 'post-fetch', source: 'getxapi', usd: 0.001, units: 1, users: ['u1'] });
        log.append({ kind: 'post.seen', account: 'demo', postId: '9', text: 'ETH', createdAt: 0 });
        log.append({ kind: 'post.classified', account: 'demo', postId: '9', classifier: 'stub', results: [] });
        log.append({
          kind: 'trigger.opened',
          triggerId: '3',
          ruleId: 'u1',
          asset: 'ETH',
          account: 'demo',
          postId: '9',
          p0: '2000',
          t0: 0,
          opensAt: 0,
          closesAt: 0,
          thresholdBps: 300,
          spikeCapBps: 1200,
          txHash: '0xdef',
        });
        log.append({ kind: 'trigger.rejected', asset: 'BTC', stage: 'open', reason: 'TweetAlreadyUsed' });
      },
    },
    keeper: {
      tick: async () => {
        log.append({ kind: 'position.sold', positionId: '1', asset: 'ETH', sellKind: 'take-profit', price: '2240', usdcOut: '54' });
      },
    },
  });
  await busy.tick();
  const [summary] = finished();
  assert.ok(summary);
  const { postsNew, classified, triggersOpened, p1Checks, bought, rejected, expired, sold, paidCalls, txSent, errors } =
    summary;
  assert.deepEqual(
    { postsNew, classified, triggersOpened, p1Checks, bought, rejected, expired, sold, paidCalls, txSent, errors },
    {
      postsNew: 1,
      classified: 1,
      triggersOpened: 1,
      p1Checks: 1,
      bought: 1,
      rejected: 1,
      expired: 1,
      sold: 1,
      paidCalls: 1,
      // The buy and the opened trigger carry a transaction hash
      txSent: 2,
      errors: 0,
    }
  );
});

test('saving and halted modes skip Gate 1 but keep Gate 2 and the keeper', async () => {
  for (const mode of ['saving', 'halted'] as const) {
    const { runner, calls, finished } = setup({ health: { mode } });
    await runner.tick();
    assert.deepEqual(calls, ['health', 'rules', 'gate2', 'keeper', 'summary'], mode);
    const [summary] = finished();
    assert.equal(summary?.mode, mode);
    assert.equal(summary?.polled, false);
  }
});

test('the cycle reports what the gas balance fell by, and a top-up is not spending', async () => {
  const spent = setup({ health: { before: { eth: 10n ** 16n }, after: { eth: 10n ** 16n - 2n * 10n ** 12n } } });
  await spent.runner.tick();
  assert.equal(spent.finished()[0]?.ethSpent, '0.000002');

  const toppedUp = setup({ health: { before: { eth: 0n }, after: { eth: 10n ** 16n } } });
  await toppedUp.runner.tick();
  assert.equal(toppedUp.finished()[0]?.ethSpent, '0');
});

test('a failing health check keeps the last mode and the cycle still finishes', async () => {
  const { runner, finished, log } = setup({ health: { failing: true } });
  await runner.tick();
  assert.equal(finished()[0]?.mode, 'normal');
  assert.equal(finished()[0]?.costUsd, '0.000000');
  assert.ok(log.recent().some((event) => event.kind === 'error' && event.where === 'cycle 1 step health'));
});

test('start runs a cycle at once and stop waits for it', async () => {
  const { runner, finished } = setup();
  runner.start();
  await runner.stop();
  assert.equal(finished().length, 1);
  assert.equal(runner.status().cyclesRun, 1);
  assert.equal(runner.status().nextAt, (finished()[0]?.startedAt ?? 0) + 30_000);
});
