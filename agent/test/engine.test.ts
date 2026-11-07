import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { SimVault } from '../src/chain/sim-vault.ts';
import type { Rule } from '../src/chain/vault.ts';
import { TieredClassifier } from '../src/classifier/tiered.ts';
import type { Classifier } from '../src/classifier/types.ts';
import { ledgerRecorder } from '../src/engine/costs.ts';
import { TriggerEngine } from '../src/engine/trigger-engine.ts';
import { EventLog, type LoggedEvent } from '../src/log.ts';
import { openDb } from '../src/store/db.ts';
import { DecisionLog } from '../src/store/decisions.ts';
import { CostLedger } from '../src/store/ledger.ts';
import { PollStateStore } from '../src/store/poll-state.ts';
import { AGENT, FakePosts, makeRule, post, profiles, ruleAsset, scriptedPrices, StubClassifier, T, trump, USER } from './helpers.ts';

const BOB: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const VENEZUELA = 'We are coming for Venezuela. Big things are happening!';

const setup = ({ rules = [makeRule()], classifier = new StubClassifier({ OIL: [true, 0.9] }) as Classifier } = {}) => {
  const clock = { now: T + 60 };
  const db = openDb();
  const log = new EventLog();
  const vault = new SimVault({
    profiles,
    rules,
    deposits: Object.fromEntries(rules.map((rule) => [rule.id, 10_000n * 10n ** 6n])),
    caller: AGENT,
    now: () => clock.now,
  });
  const prices = scriptedPrices(clock, {
    OIL: [
      [-60, '70.25'],
      [300, '71.4'],
    ],
    ETH: [
      [-60, '2000'],
      [1200, '2070'],
    ],
  });
  const posts = new FakePosts(clock, [post(VENEZUELA)]);
  const decisions = new DecisionLog(db, () => clock.now * 1000);
  const ledger = new CostLedger(db, () => clock.now * 1000);
  const pollState = new PollStateStore(db);
  const engine = new TriggerEngine({
    profiles,
    vault,
    classifier,
    posts,
    prices,
    log,
    now: () => clock.now,
    p1IntervalSec: 0,
    decisions,
    costs: ledgerRecorder({ ledger }),
    pollState,
  });
  const kinds = () => log.recent().map((event: LoggedEvent) => event.kind);
  return { clock, vault, prices, posts, engine, log, decisions, ledger, pollState, kinds };
};

test('a relevant post opens a trigger on its first price, and a confirming P1 buys', async () => {
  const { clock, engine, vault, decisions, ledger } = setup();
  await engine.pollAccount(trump);
  const [trigger] = vault.listTriggers();
  assert.equal(trigger?.asset, 'OIL');
  assert.equal(trigger?.t0, T, 'P0 is the price of the post’s second');

  clock.now = T + 300;
  await engine.checkPending();
  assert.equal(vault.listTriggers()[0]?.status, 'confirmed');
  const [decision] = decisions.list(USER);
  assert.equal(decision?.verdict, 'relevant');
  assert.deepEqual(
    decision?.assets.map(({ assetId, gate, outcome }) => [assetId, gate, outcome]),
    [
      ['OIL', 1, 'opened'],
      ['OIL', 2, 'bought'],
    ]
  );
  assert.equal(ledger.report(USER, 1).days[0]?.posts, 1);
});

test('one poll serves every rule that watches the account, and its cost is split', async () => {
  const bob = makeRule({ id: BOB, owner: BOB });
  const classifier = new StubClassifier({ OIL: [true, 0.9] });
  const { engine, posts, vault, ledger } = setup({ rules: [makeRule(), bob], classifier });
  await engine.pollAccount(trump);
  assert.equal(posts.calls.length, 1, 'one paid call for both users');
  assert.equal(vault.listTriggers().length, 2, 'a trigger for each user');
  assert.equal(ledger.report(USER, 1).days[0]?.posts, 0.5);
  assert.equal(ledger.report(BOB, 1).days[0]?.posts, 0.5);
  assert.equal(classifier.calls, 1, 'the post is classified once');
});

test('the next poll asks only for newer posts, from the stored ID', async () => {
  const { clock, engine, posts, pollState } = setup();
  await engine.pollAccount(trump);
  assert.equal(pollState.get('realDonaldTrump').sinceId, post(VENEZUELA).id);
  clock.now += 60;
  await engine.pollAccount(trump);
  assert.deepEqual(posts.calls.at(-1), { handle: 'realDonaldTrump', sinceId: post(VENEZUELA).id });
});

test('a post the classifier could not read is tried again on the next poll', async () => {
  const classifier = new StubClassifier({ OIL: [true, 0.9] });
  classifier.outages = 1;
  const { clock, engine, vault } = setup({ classifier });
  await engine.pollAccount(trump);
  assert.equal(vault.listTriggers().length, 0);
  clock.now += 60;
  await engine.pollAccount(trump);
  assert.equal(vault.listTriggers().length, 1);
  assert.equal(classifier.calls, 2);
});

test('a post that names none of the topics never reaches a model', async () => {
  const model = new StubClassifier({ OIL: [true, 0.9] });
  const { engine, posts, vault, decisions } = setup({ classifier: new TieredClassifier({ small: model }) });
  posts.posts = [post('Happy Thanksgiving to all!')];
  await engine.pollAccount(trump);
  assert.equal(model.calls, 0);
  assert.equal(vault.listTriggers().length, 0);
  assert.equal(decisions.list(USER)[0]?.verdict, 'skipped-by-filter');
});

test('a post too old for the vault is skipped before any model call', async () => {
  const classifier = new StubClassifier({ OIL: [true, 0.9] });
  const { clock, engine, decisions } = setup({ classifier });
  clock.now = T + 1801;
  await engine.pollAccount(trump);
  assert.equal(classifier.calls, 0);
  assert.equal(decisions.list(USER)[0]?.verdict, 'skipped-by-filter');
});

test('a closed market: no Pyth price within ten minutes of the post, so no gas is spent', async () => {
  const { engine, vault, decisions, posts } = setup();
  // A post a quarter of an hour before the oil path starts
  posts.posts = [post(VENEZUELA, 1n, T - 900)];
  await engine.pollAccount(trump);
  assert.equal(vault.listTriggers().length, 0);
  assert.equal(decisions.list(USER)[0]?.assets[0]?.outcome, 'PriceOutsideTweetWindow');
});

// A8: the agent picks up a changed rule within one poll, ends the old rule's triggers cleanly, and the next post uses
// the new rule
test('set rule, open trigger, change rule, next post uses the new rule', async () => {
  const classifier = new StubClassifier({ OIL: [true, 0.9], ETH: [true, 0.9] });
  const oilOnly = makeRule({ accounts: { realDonaldTrump: ['OIL'] }, assets: [ruleAsset('OIL')] });
  const { clock, engine, vault, posts, decisions } = setup({ rules: [oilOnly], classifier });
  // 1. The rule watches Trump for oil; his post opens an oil trigger.
  await engine.pollAccount(trump);
  assert.deepEqual(vault.listTriggers().map((trigger) => trigger.asset), ['OIL']);

  // 2. The user replaces the rule: ETH only, with a 20-minute wait.
  const changed: Rule = makeRule({
    accounts: { realDonaldTrump: ['ETH'] },
    assets: [ruleAsset('ETH', { minWaitSec: 1200, maxWindowSec: 1800 })],
  });
  vault.setRule(changed);

  // 3. The old oil trigger ends cleanly: its asset left the rule, so it expires on the next pass.
  clock.now = T + 300;
  await engine.checkPending();
  assert.equal(vault.listTriggers()[0]?.status, 'expired');
  assert.equal(decisions.list(USER)[0]?.assets.find((asset) => asset.gate === 2)?.outcome, 'expired');

  // 4. The next post opens under the new rule: ETH, not oil, with the new wait.
  posts.posts.push(post('America will be the crypto capital of the planet!', 2n, T + 300));
  await engine.pollAccount(trump);
  const eth = vault.listTriggers().find((trigger) => trigger.asset === 'ETH');
  assert.ok(eth, 'an ETH trigger');
  assert.equal(vault.listTriggers().filter((trigger) => trigger.asset === 'OIL').length, 1, 'no new oil trigger');
  const pending = engine.pendingTriggers().find((trigger) => trigger.triggerId === eth.id);
  assert.equal(pending?.params.minWaitSec, 1200);

  // 5. Gate 2 waits the new rule's 20 minutes, then buys.
  clock.now = T + 300 + 600;
  await engine.checkPending();
  assert.equal(eth.status, 'open');
  clock.now = T + 300 + 1200;
  await engine.checkPending();
  assert.equal(vault.listTriggers().find((trigger) => trigger.id === eth.id)?.status, 'confirmed');
});

test('a changed window applies to an open trigger at once', async () => {
  const { clock, engine, vault } = setup();
  await engine.pollAccount(trump);
  vault.setRule(makeRule({ assets: [ruleAsset('OIL', { minWaitSec: 400 }), ruleAsset('ETH')] }));
  clock.now = T + 300;
  await engine.checkPending();
  assert.equal(vault.listTriggers()[0]?.status, 'open', 'the new 400-second wait holds it back');
  assert.equal(engine.pendingTriggers()[0]?.params.minWaitSec, 400);
});

test('after a restart the open triggers come back from the vault', async () => {
  const { engine, vault } = setup();
  await engine.pollAccount(trump);
  const fresh = setup();
  const restored = fresh.engine.restorePending(await vault.listOpenTriggers(), await vault.listRules());
  assert.deepEqual(restored, ['1']);
  assert.equal(fresh.engine.pendingTriggers()[0]?.p0.sourceTime, T);
});
