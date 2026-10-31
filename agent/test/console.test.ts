import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { startConsoleServer } from '../src/console/server.ts';
import { EventLog } from '../src/log.ts';
// @ts-expect-error The view model is plain browser JavaScript without type declarations
import { buildEngineRoom, buildView, cycleTone, formatBps, shortAmount, trackPosition } from '../src/console/public/view-model.js';

const withServer = async (
  run: (base: string, log: EventLog) => Promise<void>,
  options: { status?: () => unknown } = {}
) => {
  const log = new EventLog({ now: () => 1_000 });
  const server = await startConsoleServer({ log, now: () => 1_793_380_950, port: 0, clockIntervalMs: 20, ...options });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, log);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

test('serves the page, its assets and the state', async () => {
  await withServer(async (base, log) => {
    log.append({ kind: 'payment.settled', transaction: '0xabc' });
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /The Wire Desk/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    for (const asset of ['/console.css', '/console.js', '/view-model.js']) {
      assert.equal((await fetch(`${base}${asset}`)).status, 200, asset);
    }
    const state = (await (await fetch(`${base}/api/state`)).json()) as { now: number; events: unknown[] };
    assert.equal(state.now, 1_793_380_950);
    assert.equal(state.events.length, 1);
  });
});

test('lets only the allowed origins read the state and the stream', async () => {
  await withServer(async (base) => {
    const read = async (path: string, origin: string) => {
      const controller = new AbortController();
      const response = await fetch(`${base}${path}`, { headers: { Origin: origin }, signal: controller.signal });
      controller.abort();
      return response.headers.get('access-control-allow-origin');
    };
    assert.equal(await read('/api/state', 'http://localhost:8000'), 'http://localhost:8000');
    assert.equal(await read('/api/stream', 'http://localhost:8000'), 'http://localhost:8000');
    assert.equal(await read('/api/state', 'https://evil.example'), null);
    assert.equal(await read('/api/stream', 'https://evil.example'), null);
    assert.equal(await read('/', 'http://localhost:8000'), null, 'the console page itself stays same-origin');
  });
});

test('reads its allowed origins from the options', async () => {
  const log = new EventLog({ now: () => 1_000 });
  const server = await startConsoleServer({ log, now: () => 0, port: 0, allowedOrigins: ['https://vault.example'] });
  const { port } = server.address() as AddressInfo;
  try {
    const allowed = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Origin: 'https://vault.example' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://vault.example');
    const before = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Origin: 'http://localhost:8000' } });
    assert.equal(before.headers.get('access-control-allow-origin'), null, 'the default is replaced, not extended');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves one signed price per asset per window, and only for known assets', async () => {
  const log = new EventLog({ now: () => 1_000 });
  const fetched: string[] = [];
  let fail = false;
  const prices = {
    assets: ['ETH', 'BTC'],
    fetch: async (asset: string) => {
      fetched.push(asset);
      if (fail) throw new Error('payment failed');
      return { airnode: '0x11F6e1661f92775Cd63763941E3c7C57750dE449', requestHash: '0x01', timestamp: String(fetched.length), data: '{"price":2070}', signature: '0x02' } as never;
    },
  };
  const server = await startConsoleServer({ log, now: () => 0, port: 0, prices, priceCacheMs: 200 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (asset: string) => fetch(`${base}/api/signed-price?asset=${asset}`, { headers: { Origin: 'http://localhost:8000' } });
  try {
    const state = (await (await fetch(`${base}/api/state`)).json()) as { signedPrices: boolean };
    assert.equal(state.signedPrices, true);

    const [first, second] = await Promise.all([get('ETH'), get('ETH')]);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('access-control-allow-origin'), 'http://localhost:8000');
    const body = (await first.json()) as { asset: string; response: { timestamp: string; data: string } };
    assert.equal(body.asset, 'ETH');
    assert.equal(body.response.data, '{"price":2070}');
    assert.deepEqual(await second.json(), body, 'requests in the same window share one signed price');
    assert.deepEqual(fetched, ['ETH'], 'one fetch for both requests');

    assert.equal((await get('DOGE')).status, 400, 'an asset the agent does not price');
    assert.equal((await get('')).status, 400);
    assert.deepEqual(fetched, ['ETH'], 'unknown assets never reach the paid source');

    fail = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const failed = await get('ETH');
    assert.equal(failed.status, 502);
    assert.match(((await failed.json()) as { error: string }).error, /payment failed/);
    assert.equal((await get('ETH')).status, 502, 'a failure is not retried inside its window');
    assert.deepEqual(fetched, ['ETH', 'ETH']);

    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await get('ETH')).status, 200, 'a new window fetches again');
    assert.deepEqual(fetched, ['ETH', 'ETH', 'ETH']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('without a price source the signed-price route says so', async () => {
  await withServer(async (base) => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as { signedPrices: boolean };
    assert.equal(state.signedPrices, false);
    const response = await fetch(`${base}/api/signed-price?asset=ETH`);
    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /no signed prices/);
  });
});

test('refuses writes and unknown paths', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/secrets.env`)).status, 404);
  });
});

test('streams missed events, new events and the clock', async () => {
  await withServer(async (base, log) => {
    log.append({ kind: 'payment.settled', transaction: '0x1' });
    log.append({ kind: 'payment.settled', transaction: '0x2' });
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream?since=1`, { signal: controller.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    log.append({ kind: 'payment.settled', transaction: '0x3' });
    let text = '';
    while (!(text.includes('0x3') && text.includes('event: clock'))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    assert.ok(!text.includes('"0x1"'), 'skips what the client already has');
    assert.ok(text.includes('"0x2"') && text.includes('"0x3"'));
    assert.match(text, /event: clock\ndata: \{"now":1793380950\}/);
  });
});

test('each run has its own id, so an open page notices an agent restart', async () => {
  const runIds: string[] = [];
  for (let run = 0; run < 2; run++) {
    await withServer(async (base) => {
      const state = (await (await fetch(`${base}/api/state`)).json()) as { runId: string };
      const controller = new AbortController();
      const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
      const { value } = await (response.body as ReadableStream<Uint8Array>).getReader().read();
      controller.abort();
      // The stream greets with the same id the state carries
      assert.equal(new TextDecoder().decode(value).split('\n\n')[0], `event: hello\ndata: {"runId":"${state.runId}"}`);
      runIds.push(state.runId);
    });
  }
  assert.notEqual(runIds[0], runIds[1]);
});

const at = (seq: number, event: Record<string, unknown>) => ({ seq, at: seq * 1000, ...event });

test('the view follows a post through a trigger to a sale', () => {
  const view = buildView([
    at(1, { kind: 'post.seen', account: 'a', postId: '9', text: 'Venezuela', createdAt: 100 }),
    at(2, {
      kind: 'post.classified',
      account: 'a',
      postId: '9',
      classifier: 'k',
      results: [{ asset: 'OIL', relevant: true, confidence: 0.8, reason: 'r' }],
    }),
    at(3, {
      kind: 'trigger.opened',
      triggerId: '1',
      ruleId: 'r',
      asset: 'OIL',
      account: 'a',
      postId: '9',
      p0: '70',
      t0: 100,
      opensAt: 220,
      closesAt: 700,
      thresholdBps: 150,
      spikeCapBps: 500,
    }),
    at(4, { kind: 'trigger.checked', triggerId: '1', asset: 'OIL', p1: '71.4', changeBps: 200, verdict: 'submitting' }),
    at(5, {
      kind: 'trigger.bought',
      triggerId: '1',
      positionId: '1',
      asset: 'OIL',
      usdcIn: '500',
      assetOut: '7.002801120448179271',
      price: '71.4',
    }),
    at(6, { kind: 'position.sold', positionId: '1', asset: 'OIL', sellKind: 'take-profit', price: '77.2', usdcOut: '540.6' }),
    at(7, { kind: 'trigger.rejected', asset: 'ETH', stage: 'open', reason: 'PostAlreadyUsed' }),
  ]);
  assert.equal(view.posts[0].verdicts[0].asset, 'OIL');
  assert.equal(view.triggers[0].status, 'bought');
  assert.equal(view.triggers[0].outcome, 'Bought 7.0028 OIL for 500 USDC at 71.4');
  assert.deepEqual(
    view.ledger.map((row: { side: string }) => row.side),
    ['Sell', 'Buy']
  );
  assert.deepEqual(view.counts, { posts: 1, waiting: 0, bought: 1, refused: 0 });
  assert.match(view.notices[0].text, /PostAlreadyUsed/);
});

test('view helpers place times on the track and format moves', () => {
  const trigger = { t0: 100, closesAt: 700 };
  assert.equal(trackPosition(trigger, 100), 0);
  assert.equal(trackPosition(trigger, 400), 0.5);
  assert.equal(trackPosition(trigger, 900), 1);
  assert.equal(formatBps(163), '+1.63%');
  assert.equal(formatBps(-500), '−5.00%');
  assert.equal(shortAmount('7.002801120448179271'), '7.0028');
  assert.equal(shortAmount('500'), '500');
  assert.equal(shortAmount('2.10000'), '2.1');
  assert.equal(shortAmount('0.000123456', 6), '0.000123');
});

test('/api/state and each clock tick carry the live status; the replay sends none', async () => {
  let ticks = 0;
  const status = () => ({ mode: 'normal', ticks: ++ticks });
  await withServer(
    async (base) => {
      const state = (await (await fetch(`${base}/api/state`)).json()) as { status: { mode: string } };
      assert.equal(state.status.mode, 'normal');
      const controller = new AbortController();
      const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let text = '';
      while (!text.includes('event: clock')) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      assert.match(text, /event: clock\ndata: \{"now":1793380950,"status":\{"mode":"normal","ticks":\d+\}\}/);
    },
    { status }
  );
  await withServer(async (base) => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    assert.equal('status' in state, false);
  });
});

test('/api/state sends at most the newest 1,000 events', async () => {
  await withServer(async (base, log) => {
    for (let index = 0; index < 1_005; index += 1) log.append({ kind: 'payment.settled', transaction: `0x${index}` });
    const state = (await (await fetch(`${base}/api/state`)).json()) as { events: { seq: number }[] };
    assert.equal(state.events.length, 1_000);
    assert.equal(state.events[0]?.seq, 6);
  });
});

// A live status as buildStatus writes it
const liveStatus = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: 1_793_400_100_000,
  startedAt: 1_793_400_000_000,
  uptimeSec: 100,
  restarts: 1,
  mode: 'saving',
  modeReason: 'aUSD budget at 80% or more (2.4 aUSD of 3 aUSD)',
  schedule: {
    cycleIntervalSec: 30,
    pollIntervalSec: 60,
    cyclesRun: 3,
    cyclesSkipped: 1,
    running: false,
    lastCycle: 4,
    lastFinishedAt: 1_793_400_088_000,
    lastCycleAgeSec: 12 as number | null,
    nextAt: 1_793_400_120_000,
  },
  watchSet: ['demo'],
  wallets: {
    agent: {
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      link: 'https://sepolia.basescan.org/address/0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      eth: '0.0123456789',
    },
    payer: {
      address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      link: 'https://sepolia.basescan.org/address/0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      ausd: '0.6',
    } as Record<string, string> | null,
  },
  budget: {
    ausd: { tracked: true, spentToday: '2.4', limit: '3', min: '0.2' },
    eth: { spentToday: '0.0001', limit: '0.005', min: '0.0005' },
    txLastHour: 3,
    maxTxPerHour: 30,
    savingAtPct: 80,
  },
  totals: {
    cycles: 3,
    skipped: 1,
    posts: 2,
    triggers: 1,
    p1Checks: 2,
    buys: 1,
    sells: 0,
    rejected: 1,
    expired: 0,
    paidCalls: 4,
    txSent: 2,
    errors: 1,
    ausdSpent: '0.04',
    ethSpent: '0.000123',
  },
  sources: {},
  ...overrides,
});

const cycle = (fields: Record<string, unknown>) => ({
  kind: 'cycle.finished',
  cycle: 1,
  startedAt: 1_793_400_000_000,
  durationMs: 1_200,
  mode: 'normal',
  polled: false,
  accountsPolled: [],
  postsNew: 0,
  classified: 0,
  triggersOpened: 0,
  p1Checks: 0,
  bought: 0,
  rejected: 0,
  expired: 0,
  sold: 0,
  paidCalls: 0,
  txSent: 0,
  ausdSpent: '0',
  ethSpent: '0',
  errors: 0,
  nextAt: 0,
  ...fields,
});

test('the Engine Room shows the heartbeat, the mode, both wallets, the budgets and the totals', () => {
  const room = buildEngineRoom(liveStatus(), []);
  assert.deepEqual(room.heartbeat, { text: 'Last cycle 12 s ago', stale: false });
  assert.deepEqual(room.mode, { mode: 'saving', reason: 'aUSD budget at 80% or more (2.4 aUSD of 3 aUSD)' });
  assert.match(room.schedule, /^One cycle every 30 s · posts polled every 60 s · watching @demo · next cycle \d\d:\d\d:\d\d UTC$/);
  assert.deepEqual(
    room.wallets.map((wallet: { role: string; short: string; balance: string }) => [wallet.role, wallet.short, wallet.balance]),
    [
      ['Agent wallet', '0x7099…79C8', '0.012345 ETH'],
      ['Payer wallet', '0x3C44…93BC', '0.6 aUSD'],
    ]
  );
  assert.deepEqual(
    room.budgets.map((budget: { label: string; text: string; pct: number; tone: string }) => [
      budget.label,
      budget.text,
      budget.pct,
      budget.tone,
    ]),
    [
      ['Data', '2.4 of 3 aUSD today', 80, 'amber'],
      ['Gas', '0.0001 of 0.005 ETH today', 2, 'ok'],
      ['Transactions', '3 of 30 in the last hour', 10, 'ok'],
    ]
  );
  assert.deepEqual(room.totals, [
    ['Cycles', 3],
    ['Posts', 2],
    ['Triggers', 1],
    ['Buys', 1],
    ['Sells', 0],
    ['aUSD', '0.04'],
    ['ETH', '0.000123'],
    ['Errors recovered', 1],
    ['Restarts', 1],
  ]);
  // The replay has no status, so no Engine Room
  assert.equal(buildEngineRoom(undefined, []), undefined);
});

test('the heartbeat turns red after three missed cycles', () => {
  const late = liveStatus({ schedule: { ...liveStatus().schedule, lastCycleAgeSec: 91 } });
  assert.deepEqual(buildEngineRoom(late, []).heartbeat, { text: 'Last cycle 91 s ago', stale: true });
  const never = liveStatus({ uptimeSec: 120, schedule: { ...liveStatus().schedule, lastCycleAgeSec: null } });
  assert.deepEqual(buildEngineRoom(never, []).heartbeat, { text: 'No cycle yet', stale: true });
});

test('without a payer the data budget and the aUSD card are left out', () => {
  const status = liveStatus();
  const freeData = liveStatus({
    wallets: { ...status.wallets, payer: null },
    budget: { ...status.budget, ausd: { ...status.budget.ausd, tracked: false } },
  });
  const room = buildEngineRoom(freeData, []);
  assert.deepEqual(
    room.wallets.map((wallet: { role: string }) => wallet.role),
    ['Agent wallet']
  );
  assert.deepEqual(
    room.budgets.map((budget: { label: string }) => budget.label),
    ['Gas', 'Transactions']
  );
});

test('the cycle strip colours the last 60 cycles by what they did', () => {
  assert.equal(cycleTone(cycle({})), 'grey');
  assert.equal(cycleTone(cycle({ polled: true })), 'blue');
  assert.equal(cycleTone(cycle({ polled: true, rejected: 1 })), 'amber');
  assert.equal(cycleTone(cycle({ rejected: 1, bought: 1 })), 'green');
  assert.equal(cycleTone(cycle({ sold: 1 })), 'green');
  assert.equal(cycleTone(cycle({ bought: 1, errors: 1 })), 'red');
  assert.equal(cycleTone({ kind: 'cycle.skipped', cycle: 2, reason: 'previous cycle still running', runningForMs: 31_000 }), 'red');

  const events = [
    { kind: 'post.seen' },
    ...Array.from({ length: 70 }, (_, index) => cycle({ cycle: index + 1, polled: index % 2 === 0 })),
    { kind: 'cycle.skipped', cycle: 71, reason: 'previous cycle still running', runningForMs: 31_000 },
  ];
  const { strip } = buildEngineRoom(liveStatus(), events);
  assert.equal(strip.length, 60);
  assert.equal(strip[0].cycle, 12);
  assert.equal(strip.at(-1).tone, 'red');
  assert.equal(strip.at(-1).title, 'Cycle 71 skipped: previous cycle still running (31 s)');
  assert.match(strip[0].title, /^Cycle 12 · \d\d:\d\d:\d\d UTC · 1.2 s · normal\nNo post poll\n0 new posts/);
});
