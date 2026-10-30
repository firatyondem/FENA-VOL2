import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveRequestHash, type SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import { SimVault } from '../src/chain/sim-vault.ts';
import { type Rule, VaultRejection } from '../src/chain/vault.ts';
import { getAsset, loadProfiles, priceRequest } from '../src/profiles.ts';
import { latestTweetRequest, snowflakeAt } from '../src/sources/twitter.ts';
import { DEMO_ETH_RULE, DEMO_OIL_RULE, FIXTURE_AIRNODE_KEY, formatXDate, P0_TIME } from '../scripts/fixture-set.ts';
import { readSharedJson } from './helpers.ts';

const profiles = loadProfiles();
const fixtureAirnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
const agent = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const usdc = (amount: number) => BigInt(amount) * 10n ** 6n;
const fixture = (file: string) => readSharedJson<SignedResponse>(`fixtures/synthetic/${file}`);

const perAsset = { cooldownSec: 60, takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 };

const makeRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  agent,
  paused: false,
  buyAmount: usdc(500),
  maxPerTrade: usdc(500),
  dailyLimit: usdc(2_000),
  accounts: { realDonaldTrump: ['OIL', 'ETH'], elonmusk: ['DOGE'] },
  assets: [
    { asset: 'OIL', budgetShareBps: 5000, ...DEMO_OIL_RULE, ...perAsset },
    { asset: 'ETH', budgetShareBps: 5000, ...DEMO_ETH_RULE, ...perAsset },
  ],
  topics: {},
  ...overrides,
});

const setup = ({ caller = agent, rule = makeRule() }: { caller?: `0x${string}`; rule?: Rule } = {}) => {
  const clock = { now: P0_TIME + 60 };
  const vault = new SimVault({
    profiles,
    rules: [rule],
    deposits: { r1: usdc(10_000) },
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

const open = (vault: SimVault, asset: string, post: SignedResponse, p0: SignedResponse, account = 'realDonaldTrump') =>
  vault.openTrigger({ ruleId: 'r1', asset, account, post, p0 });

const openEth = (vault: SimVault, post = fixture('tweet-trump-venezuela.json')) =>
  open(vault, 'ETH', post, fixture('eth-p0.json'));

// A fresh signed post by Trump created at `createdAt`, and signed prices taken at `at`
const trumpPost = (createdAt: number, sequence: bigint) =>
  signResponse(
    FIXTURE_AIRNODE_KEY,
    deriveRequestHash(latestTweetRequest({ handle: 'realDonaldTrump', pinned: false })),
    createdAt + 10,
    JSON.stringify({
      author: 'realDonaldTrump',
      createdAt: formatXDate(createdAt),
      id: snowflakeAt(createdAt, sequence),
      text: 'New sanctions on Iran start today.',
    })
  );
const priceOf = (asset: string, price: string, at: number) =>
  signResponse(
    FIXTURE_AIRNODE_KEY,
    deriveRequestHash(priceRequest(getAsset(profiles, asset))),
    at + 1,
    `{"price":${price},"updatedAt":${at * 1000}}`
  );

test('a valid run opens on the post and P0, then buys the rule amount at P1', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  const bought = await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));
  assert.equal(bought.usdcIn, usdc(500));
  assert.equal(bought.price, 2070n * 10n ** 18n);
  assert.equal(bought.assetOut, (usdc(500) * 10n ** 36n) / (2070n * 10n ** 18n * 10n ** 6n));
  assert.equal(vault.balanceOf('r1'), usdc(9_500));
  assert.equal(vault.listTriggers()[0]?.status, 'confirmed');
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
    assert.equal(vault.balanceOf('r1'), usdc(10_000));
    assert.equal(vault.listTriggers()[0]?.status, 'open');
  });
}

for (const [file, now, reason] of [
  ['eth-p1-flat.json', P0_TIME + 320, 'TrendTooWeak'],
  ['eth-p1-spike.json', P0_TIME + 320, 'SpikeTooHigh'],
  ['eth-p1-early.json', P0_TIME + 70, 'WaitNotOver'],
  ['eth-p1-late.json', P0_TIME + 905, 'WindowClosed'],
] as const) {
  test(`Gate 2 refuses ${file} with ${reason}`, async () => {
    const { vault, clock } = setup();
    const { triggerId } = await openEth(vault);
    clock.now = now;
    await rejectsWith(vault.confirmTrigger(triggerId, fixture(file)), reason);
  });
}

test('a refused P1 is not used up: a later valid P1 still buys', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  await rejectsWith(vault.confirmTrigger(triggerId, fixture('eth-p1-flat.json')), 'TrendTooWeak');
  await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));
});

test('an old post cannot open a trigger with a new price', async () => {
  const { vault } = setup();
  await rejectsWith(openEth(vault, fixture('tweet-trump-old.json')), 'PriceOutsideTweetWindow');
});

test('a refused P0 does not use up the post', async () => {
  const { vault, clock } = setup();
  clock.now = P0_TIME + 60;
  await rejectsWith(open(vault, 'ETH', fixture('tweet-trump-venezuela.json'), fixture('tamper-wrong-signer.json')), 'NotSignedByAirnode');
  await openEth(vault);
});

test('one post opens one trigger per asset', async () => {
  const { vault } = setup();
  await openEth(vault);
  await rejectsWith(openEth(vault), 'TweetAlreadyUsed');
  await open(vault, 'OIL', fixture('tweet-trump-venezuela.json'), fixture('oil-p0.json'));
  assert.equal(vault.listTriggers().length, 2);
});

test('only the approved agent wallet opens triggers', async () => {
  const { vault } = setup({ caller: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' });
  await rejectsWith(openEth(vault), 'NotAgent');
});

test('a paused rule neither opens nor buys', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  vault.setPaused('r1', true);
  clock.now = P0_TIME + 320;
  await rejectsWith(vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json')), 'RuleIsPaused');
  await rejectsWith(open(vault, 'OIL', fixture('tweet-trump-venezuela.json'), fixture('oil-p0.json')), 'RuleIsPaused');
});

test('only watched accounts and allowed assets open triggers', async () => {
  const { vault } = setup();
  await rejectsWith(open(vault, 'ETH', fixture('tweet-musk-doge.json'), fixture('eth-p0.json'), 'JDVance'), 'AccountNotWatched');
  await rejectsWith(open(vault, 'BTC', fixture('tweet-trump-venezuela.json'), fixture('eth-p0.json')), 'AssetNotAllowed');
});

test('a post response for another account is the wrong request', async () => {
  const { vault } = setup();
  await rejectsWith(openEth(vault, fixture('tweet-musk-doge.json')), 'WrongRequestHash');
});

test('a trigger expires only after its window', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 600;
  await rejectsWith(vault.expireTrigger(triggerId), 'WindowNotClosed');
  clock.now = P0_TIME + 601;
  await vault.expireTrigger(triggerId);
  assert.equal(vault.listTriggers()[0]?.status, 'expired');
  await rejectsWith(vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json')), 'TriggerNotOpen');
});

test('sells check take profit, stagnation and the stop loss on a price taken after the buy', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  const { positionId } = await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));

  clock.now = P0_TIME + 400;
  await rejectsWith(vault.sell(positionId, 'take-profit', await priceOf('ETH', '2235', P0_TIME + 310)), 'PriceBeforeBuy');
  await rejectsWith(vault.sell(positionId, 'take-profit', await priceOf('ETH', '2235', P0_TIME + 390)), 'TakeProfitNotReached');
  await rejectsWith(vault.sell(positionId, 'stagnation', await priceOf('ETH', '2075', P0_TIME + 391)), 'StagnationDelayNotOver');
  await rejectsWith(vault.sell(positionId, 'stop-loss', await priceOf('ETH', '2000', P0_TIME + 392)), 'StopLossNotReached');

  // +8% on 2070 is 2235.6
  const sold = await vault.sell(positionId, 'take-profit', await priceOf('ETH', '2235.6', P0_TIME + 395));
  assert.equal(sold.price, 22356n * 10n ** 17n);
  assert.ok(vault.balanceOf('r1') > usdc(10_000), 'the take profit added to the vault');
  await rejectsWith(vault.sell(positionId, 'manual', await priceOf('ETH', '2235.6', P0_TIME + 396)), 'PositionNotOpen');
});

test('the stagnation exit sells inside the band after the delay', async () => {
  const { vault, clock } = setup();
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  const { positionId } = await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));
  clock.now = P0_TIME + 925;
  await rejectsWith(vault.sell(positionId, 'stagnation', await priceOf('ETH', '2100', P0_TIME + 921)), 'PriceOutsideStagnationBand');
  await vault.sell(positionId, 'stagnation', await priceOf('ETH', '2080', P0_TIME + 922));
});

test('the cooldown holds back a second buy of the same asset, not of another', async () => {
  const { vault, clock } = setup({ rule: makeRule() });
  const [rule] = await vault.listRules();
  assert.ok(rule);
  rule.assets = rule.assets.map((asset) => ({ ...asset, cooldownSec: 600 }));
  const first = await openEth(vault);
  clock.now = P0_TIME + 320;
  await vault.confirmTrigger(first.triggerId, fixture('eth-p1-rise.json'));

  clock.now = P0_TIME + 330;
  const post = await trumpPost(P0_TIME + 200, 9n);
  const eth = await open(vault, 'ETH', post, await priceOf('ETH', '2070', P0_TIME + 250));
  const oil = await open(vault, 'OIL', post, await priceOf('OIL', '70', P0_TIME + 250));
  clock.now = P0_TIME + 405;
  await rejectsWith(vault.confirmTrigger(eth.triggerId, await priceOf('ETH', '2140', P0_TIME + 400)), 'CooldownActive');
  await vault.confirmTrigger(oil.triggerId, await priceOf('OIL', '71.4', P0_TIME + 400));
  assert.equal(vault.balanceOf('r1'), usdc(9_000), 'the ETH buy and the OIL buy');
});

test('each asset spends only its share of the daily limit', async () => {
  const { vault, clock } = setup({ rule: makeRule({ buyAmount: usdc(600), maxPerTrade: usdc(600) }) });
  const [rule] = await vault.listRules();
  assert.ok(rule);
  rule.assets = rule.assets.map((asset) => ({ ...asset, cooldownSec: 0 }));
  const first = await openEth(vault);
  clock.now = P0_TIME + 320;
  await vault.confirmTrigger(first.triggerId, fixture('eth-p1-rise.json'));

  // ETH's share is 50% of 2,000: 600 fits once, 1,200 does not
  clock.now = P0_TIME + 330;
  const second = await open(vault, 'ETH', await trumpPost(P0_TIME + 200, 9n), await priceOf('ETH', '2070', P0_TIME + 250));
  clock.now = P0_TIME + 405;
  await rejectsWith(vault.confirmTrigger(second.triggerId, await priceOf('ETH', '2140', P0_TIME + 400)), 'DailyBudgetExceeded');
});

test('a buy amount above the per-trade limit is refused', async () => {
  const { vault, clock } = setup({ rule: makeRule({ buyAmount: usdc(700) }) });
  const { triggerId } = await openEth(vault);
  clock.now = P0_TIME + 320;
  await rejectsWith(vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json')), 'PerTradeLimitExceeded');
});
