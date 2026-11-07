import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerdictCache } from '../src/classifier/tiered.ts';
import { ledgerRecorder } from '../src/engine/costs.ts';
import { EventLog } from '../src/log.ts';
import { openDb } from '../src/store/db.ts';
import { DecisionLog } from '../src/store/decisions.ts';
import { CostLedger } from '../src/store/ledger.ts';
import { PollStateStore } from '../src/store/poll-state.ts';

const ALICE = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const BOB = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
// 2026-11-07T12:00:00Z
const NOW = Date.UTC(2026, 10, 7, 12);

test('the ledger splits a shared poll evenly and reports per user and day', () => {
  const clock = { ms: NOW };
  const ledger = new CostLedger(openDb(), () => clock.ms);
  ledger.record({ kind: 'post-fetch', source: 'getxapi', users: [ALICE, BOB], units: 1, usd: 0.001 });
  ledger.record({ kind: 'ai-call', source: 'claude-haiku-5-5', users: [ALICE], units: 900, usd: 0.0002 });
  ledger.record({ kind: 'gas', source: 'base-sepolia', users: [ALICE, BOB], units: 1, usd: 0.02, wei: 3n });
  ledger.record({ kind: 'price-update-fee', source: 'pyth', users: [ALICE], units: 1, usd: 0, wei: 30n });
  clock.ms = NOW - 86_400_000;
  ledger.record({ kind: 'post-fetch', source: 'getxapi', users: [ALICE], units: 1, usd: 0.001 });
  clock.ms = NOW;

  const alice = ledger.report(ALICE, 3);
  assert.equal(alice.days.length, 3);
  const today = alice.days.at(-1);
  assert.equal(today?.date, '2026-11-07');
  assert.equal(today?.posts, 0.5);
  assert.equal(today?.aiCalls, 1);
  assert.equal(today?.priceUpdates, 1);
  // 3 wei of gas split two ways: the first user carries the odd wei
  assert.equal(today?.gasWei, '2');
  assert.equal(today?.totalUsd, 0.0107);
  assert.deepEqual(Object.keys(today?.bySource ?? {}).sort(), ['base-sepolia', 'claude-haiku-5-5', 'getxapi', 'pyth']);
  assert.equal(alice.days[1]?.totalUsd, 0.001);
  assert.equal(alice.totalUsd, 0.0117);
  assert.equal(ledger.report(BOB, 1).days[0]?.gasWei, '1');
  assert.equal(ledger.report('*', 1).totalUsd, 0.0212);
  // Today's data: post fetches and model calls, every user
  assert.equal(ledger.usdToday().toFixed(4), '0.0012');
});

test('the recorder books costs and logs them for the cycle summary', () => {
  const ledger = new CostLedger(openDb(), () => NOW);
  const log = new EventLog();
  const costs = ledgerRecorder({ ledger, ethUsd: () => 2000, log });
  costs.transaction({ txHash: '0xab', gasWei: 10n ** 13n, feeWei: 30n }, [ALICE]);
  costs.transaction(undefined, [ALICE]);
  const kinds = log.recent().map((event) => (event.kind === 'cost' ? event.costKind : event.kind));
  assert.deepEqual(kinds, ['price-update-fee', 'gas']);
  // 0.00001 ETH at 2,000 USD
  assert.equal(ledger.report(ALICE, 1).days[0]?.bySource['base-sepolia']?.usd, 0.02);
});

test('the decision log keeps each post, its verdict and what the vault did, per user', () => {
  const decisions = new DecisionLog(openDb(), () => NOW);
  decisions.recordPost({ tweetId: '2', account: 'realDonaldTrump', text: 'Venezuela!', createdAt: 100, users: [ALICE, BOB] });
  decisions.recordPost({ tweetId: '1', account: 'realDonaldTrump', text: 'Hello', createdAt: 50, users: [ALICE] });
  decisions.recordVerdict('2', 'relevant', 'OIL: names Venezuela', 'claude-haiku-5-5');
  decisions.recordVerdict('1', 'skipped-by-filter', 'no topic', 'filter');
  decisions.recordOutcome('2', ALICE, 'OIL', 1, 'opened', '0xopen', '7');
  decisions.recordOutcome('2', BOB, 'OIL', 1, 'DailyBudgetExceeded');
  decisions.recordTriggerOutcome('7', 'TrendTooWeak');
  // A later outcome of the same gate replaces the first
  decisions.recordTriggerOutcome('7', 'bought', '0xbuy');

  const alice = decisions.list(ALICE);
  assert.deepEqual(alice.map((d) => d.tweetId), ['2', '1']);
  assert.deepEqual(alice[0], {
    tweetId: '2',
    account: 'realDonaldTrump',
    text: 'Venezuela!',
    createdAt: 100,
    verdict: 'relevant',
    reason: 'OIL: names Venezuela',
    classifier: 'claude-haiku-5-5',
    assets: [
      { assetId: 'OIL', gate: 1, outcome: 'opened', txHash: '0xopen' },
      { assetId: 'OIL', gate: 2, outcome: 'bought', txHash: '0xbuy' },
    ],
  });
  assert.equal(alice[1]?.verdict, 'skipped-by-filter');
  const bob = decisions.list(BOB.toLowerCase());
  assert.deepEqual(bob.map((d) => d.tweetId), ['2']);
  assert.deepEqual(bob[0]?.assets, [{ assetId: 'OIL', gate: 1, outcome: 'DailyBudgetExceeded' }]);
  assert.equal(decisions.list(ALICE, 1).length, 1);
});

test('poll state and verdicts survive a restart, since they live in the file', () => {
  const db = openDb();
  const polls = new PollStateStore(db);
  polls.set('realDonaldTrump', { sinceId: '5', lastPollAt: 1 });
  polls.set('REALDONALDTRUMP', { lastPostAt: 9 });
  assert.deepEqual(new PollStateStore(db).get('realdonaldtrump'), { sinceId: '5', lastPollAt: 1, lastPostAt: 9 });

  const cache = new VerdictCache(db);
  cache.set('5', { asset: 'OIL', relevant: true, confidence: 0.9, reason: 'oil', by: 'claude-haiku-5-5' });
  assert.deepEqual(new VerdictCache(db).get('5', 'OIL'), {
    asset: 'OIL',
    relevant: true,
    confidence: 0.9,
    reason: 'oil',
    by: 'claude-haiku-5-5',
  });
  assert.equal(cache.get('5', 'ETH'), undefined);
});
