import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { startConsoleServer } from '../src/console/server.ts';
import { EventLog } from '../src/log.ts';
// @ts-expect-error The view model is plain browser JavaScript without type declarations
import { buildView, formatBps, shortAmount, trackPosition } from '../src/console/public/view-model.js';

const withServer = async (run: (base: string, log: EventLog) => Promise<void>) => {
  const log = new EventLog({ now: () => 1_000 });
  const server = await startConsoleServer({ log, now: () => 1_793_380_950, port: 0, clockIntervalMs: 20 });
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
});
