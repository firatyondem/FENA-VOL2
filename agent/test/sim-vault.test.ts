import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveRequestHash, type SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import { SimVault } from '../src/chain/sim-vault.ts';
import { type Rule, VaultRejection } from '../src/chain/vault.ts';
import { getAsset, loadProfiles, priceRequest } from '../src/profiles.ts';
import { DEMO_ETH_RULE, DEMO_OIL_RULE, FIXTURE_AIRNODE_KEY, formatXDate, P0_TIME } from '../scripts/fixture-set.ts';
import { latestTweetRequest, snowflakeAt } from '../src/sources/twitter.ts';
import { readSharedJson } from './helpers.ts';

const profiles = loadProfiles();
const fixtureAirnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
const agent = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const fixture = (file: string) => readSharedJson<SignedResponse>(`fixtures/synthetic/${file}`);

const sellParams = { takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 };

const makeRule = (): Rule => ({
  id: 'r1',
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  agent,
  paused: false,
  accounts: { realDonaldTrump: ['OIL', 'ETH'], elonmusk: ['DOGE'] },
  assets: [
    { asset: 'OIL', budgetShareBps: 5000, ...DEMO_OIL_RULE, ...sellParams },
    { asset: 'ETH', budgetShareBps: 5000, ...DEMO_ETH_RULE, ...sellParams },
  ],
  topics: {},
  maxPerTradeBps: 500,
  dailyLimitBps: 2000,
  cooldownSec: 60,
});

const setup = (caller: `0x${string}` = agent) => {
  const clock = { now: P0_TIME + 60 };
  const vault = new SimVault({
    profiles,
    rules: [makeRule()],
    deposits: { r1: 10_000n * 10n ** 6n },
    caller,
    tweetAirnode: fixtureAirnode,
    priceAirnodes: { ETH: fixtureAirnode, OIL: fixtureAirnode, BTC: fixtureAirnode },
    now: () => clock.now,
  });
  return { vault, clock };
};

const rejectsWith = async (promise: Promise<unknown>, reason: string) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof VaultRejection, String(error));
    assert.equal(error.reason, reason);
    return true;
  });

const openEth = (vault: SimVault, post = 'tweet-trump-venezuela.json') =>
  vault.openTrigger({ ruleId: 'r1', asset: 'ETH', account: 'realDonaldTrump', post: fixture(post), p0: fixture('eth-p0.json') });

test('a valid run opens on the post and P0, then buys at P1', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  const bought = await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));
  // 5% of 10,000 USDC per trade; the ETH share of the 20% daily limit (1,000) is larger
  assert.equal(bought.usdcIn, 500n * 10n ** 6n);
  assert.equal(bought.price, 2070n * 10n ** 18n);
  assert.equal(bought.assetOut, (500n * 10n ** 6n * 10n ** 36n) / (2070n * 10n ** 18n * 10n ** 6n));
  assert.equal(vault.balanceOf('r1'), 9_500n * 10n ** 6n);
  assert.equal(vault.listTriggers()[0]?.status, 'bought');
});

for (const [file, reason] of [
  ['tamper-edited-value.json', 'NotSignedByAirnode'],
  ['tamper-wrong-signer.json', 'NotSignedByAirnode'],
  ['tamper-different-request.json', 'WrongRequestHash'],
  ['tamper-stale.json', 'ResponseTooOld'],
] as const) {
  test(`tamper test ${file} reverts with ${reason} and moves no funds`, async () => {
    const { vault, clock } = setup();
    const { triggerId } = await openEth(vault);
    clock.now = P0_TIME + 320;
    await rejectsWith(vault.confirmTrigger(triggerId, fixture(file)), reason);
    assert.equal(vault.balanceOf('r1'), 10_000n * 10n ** 6n);
    assert.equal(vault.listTriggers()[0]?.status, 'pending');
  });
}

for (const [file, now, reason] of [
  ['eth-p1-flat.json', P0_TIME + 320, 'TrendBelowThreshold'],
  ['eth-p1-spike.json', P0_TIME + 320, 'AboveSpikeCap'],
  ['eth-p1-early.json', P0_TIME + 70, 'BeforeMinimumWait'],
  ['eth-p1-late.json', P0_TIME + 905, 'WindowClosed'],
] as const) {
  test(`Gate 2 refuses ${file} with ${reason}`, async () => {
    const { vault, clock } = setup();
    const { triggerId } = await openEth(vault);
    clock.now = now;
    await rejectsWith(vault.confirmTrigger(triggerId, fixture(file)), reason);
  });
}

test('an old post cannot open a trigger with a new price', async () => {
  const { vault } = setup();
  await rejectsWith(openEth(vault, 'tweet-trump-old.json'), 'PostTooOldForPrice');
});

test('one post triggers a rule once', async () => {
  const { vault } = setup();
  await openEth(vault);
  await rejectsWith(
    vault.openTrigger({
      ruleId: 'r1',
      asset: 'OIL',
      account: 'realDonaldTrump',
      post: fixture('tweet-trump-venezuela.json'),
      p0: fixture('oil-p0.json'),
    }),
    'PostAlreadyUsed'
  );
});

test('only the approved agent wallet opens triggers', async () => {
  const { vault } = setup('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
  await rejectsWith(openEth(vault), 'NotRuleAgent');
});

test('a paused rule neither opens nor buys', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  vault.setPaused('r1', true);
  clock.now = P0_TIME + 320;
  await rejectsWith(vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json')), 'RulePaused');
  await rejectsWith(openEth(vault, 'tweet-musk-doge.json'), 'RulePaused');
});

test('an account only triggers the assets linked to it', async () => {
  const { vault } = setup();
  await rejectsWith(
    vault.openTrigger({
      ruleId: 'r1',
      asset: 'ETH',
      account: 'elonmusk',
      post: fixture('tweet-musk-doge.json'),
      p0: fixture('eth-p0.json'),
    }),
    'AccountNotWatched'
  );
});

test('a tweet response for another account is the wrong request', async () => {
  const { vault } = setup();
  await rejectsWith(
    vault.openTrigger({
      ruleId: 'r1',
      asset: 'ETH',
      account: 'realDonaldTrump',
      post: fixture('tweet-musk-doge.json'),
      p0: fixture('eth-p0.json'),
    }),
    'WrongRequestHash'
  );
});

test('a trigger expires only after its window', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 600;
  await rejectsWith(vault.expireTrigger(triggerId), 'WindowStillOpen');
  clock.now = P0_TIME + 601;
  await vault.expireTrigger(triggerId);
  assert.equal(vault.listTriggers()[0]?.status, 'expired');
  await rejectsWith(vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json')), 'TriggerNotPending');
});

const ethPrice = (price: string, at: number) =>
  signResponse(
    FIXTURE_AIRNODE_KEY,
    deriveRequestHash(priceRequest(getAsset(profiles, 'ETH'))),
    at + 1,
    `{"price":${price},"updatedAt":${at * 1000}}`
  );

test('a position sells on take profit, stop loss or stagnation, each checked on a signed price', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  const { positionId } = await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));

  clock.now = P0_TIME + 400;
  await rejectsWith(vault.sell(positionId, 'take-profit', await ethPrice('2200', P0_TIME + 390)), 'SellConditionNotMet');
  await rejectsWith(vault.sell(positionId, 'stop-loss', await ethPrice('2000', P0_TIME + 391)), 'SellConditionNotMet');
  await rejectsWith(vault.sell(positionId, 'stagnation', await ethPrice('2075', P0_TIME + 392)), 'SellConditionNotMet');

  // +8% on 2070 is 2235.6
  const sold = await vault.sell(positionId, 'take-profit', await ethPrice('2235.6', P0_TIME + 395));
  assert.equal(sold.price, 22356n * 10n ** 17n);
  assert.ok(vault.balanceOf('r1') > 10_000n * 10n ** 6n, 'the take profit added to the vault');
  await rejectsWith(vault.sell(positionId, 'manual', await ethPrice('2235.6', P0_TIME + 396)), 'PositionNotOpen');
});

test('the cooldown blocks a second buy, even with a valid trend', async () => {
  const { vault, clock } = setup();
  const [rule] = await vault.listRules();
  assert.ok(rule);
  rule.cooldownSec = 600;
  const first = await openEth(vault);
  clock.now = P0_TIME + 320;
  await vault.confirmTrigger(first.triggerId, fixture('eth-p1-rise.json'));

  // A second, fresh post about oil and its own P0 and P1
  const postTime = P0_TIME + 200;
  const tweetHash = deriveRequestHash(latestTweetRequest({ handle: 'realDonaldTrump', pinned: false }));
  const oilHash = deriveRequestHash(priceRequest(getAsset(profiles, 'OIL')));
  const postData = JSON.stringify({
    author: 'realDonaldTrump',
    createdAt: formatXDate(postTime),
    id: snowflakeAt(postTime, 9n),
    text: 'New sanctions on Iran start today.',
  });
  clock.now = P0_TIME + 330;
  const second = await vault.openTrigger({
    ruleId: 'r1',
    asset: 'OIL',
    account: 'realDonaldTrump',
    post: await signResponse(FIXTURE_AIRNODE_KEY, tweetHash, postTime + 10, postData),
    p0: await signResponse(FIXTURE_AIRNODE_KEY, oilHash, P0_TIME + 251, `{"price":70,"updatedAt":${(P0_TIME + 250) * 1000}}`),
  });
  clock.now = P0_TIME + 405;
  const p1 = await signResponse(FIXTURE_AIRNODE_KEY, oilHash, P0_TIME + 401, `{"price":71.4,"updatedAt":${(P0_TIME + 400) * 1000}}`);
  await rejectsWith(vault.confirmTrigger(second.triggerId, p1), 'CooldownActive');
  assert.equal(vault.balanceOf('r1'), 9_500n * 10n ** 6n, 'only the first buy spent funds');
});
