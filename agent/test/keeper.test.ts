import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveRequestHash, type SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import { SimVault } from '../src/chain/sim-vault.ts';
import type { Position, Rule } from '../src/chain/vault.ts';
import { decideSell, SellKeeper, takeProfitTarget } from '../src/engine/keeper.ts';
import { EventLog } from '../src/log.ts';
import { getAsset, loadProfiles, priceRequest } from '../src/profiles.ts';
import { DEMO_ETH_RULE, FIXTURE_AIRNODE_KEY, P0_TIME } from '../scripts/fixture-set.ts';
import { readSharedJson } from './helpers.ts';

const e18 = 10n ** 18n;
const params = { takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 };
const position: Position = {
  id: '1',
  ruleId: 'r1',
  asset: 'ETH',
  amount: e18,
  entryPrice: 2000n * e18,
  entryTime: 1_000,
  open: true,
};

test('take profit at +8% and above', () => {
  assert.equal(decideSell(position, params, 2160n * e18, 1_100), 'take-profit');
  assert.equal(decideSell(position, params, 2160n * e18 - 1n, 1_100), undefined);
  assert.equal(decideSell(position, { ...params, takeProfitBps: 0 }, 9000n * e18, 1_100), undefined, '0 turns it off');
});

test('stop loss at -5% and below, before anything else', () => {
  assert.equal(decideSell(position, params, 1900n * e18, 5_000), 'stop-loss');
  assert.equal(decideSell(position, params, 1900n * e18 + 1n, 1_100), undefined);
  assert.equal(decideSell(position, { ...params, stopLossBps: 0 }, 1n, 1_100), undefined, '0 turns it off');
});

test('stagnation exit only after the delay, measured on the price time, and inside the band', () => {
  assert.equal(decideSell(position, params, 2015n * e18, 1_599), undefined);
  assert.equal(decideSell(position, params, 2015n * e18, 1_600), 'stagnation');
  assert.equal(decideSell(position, params, 1980n * e18, 1_600), 'stagnation');
  assert.equal(decideSell(position, params, 2021n * e18, 1_600), undefined);
  assert.equal(decideSell(position, { ...params, stagnationAfterSec: 0 }, 2000n * e18, 9_999), undefined, '0 turns it off');
});

test('never sells on a price taken before the buy', () => {
  assert.equal(decideSell(position, params, 3000n * e18, 999), undefined);
});

test('only offers the sells the vault lets the keeper make', () => {
  const onchain = ['take-profit', 'stagnation'] as const;
  assert.equal(decideSell(position, params, 1800n * e18, 1_100, onchain), undefined, 'no stop loss on-chain');
  assert.equal(decideSell(position, params, 2200n * e18, 1_100, onchain), 'take-profit');
});

test('the keeper sells a bought position at take profit with a signed price', async () => {
  const profiles = loadProfiles();
  const fixtureAirnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
  const agent = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const clock = { now: P0_TIME + 60 };
  const rule: Rule = {
    id: 'r1',
    owner: agent,
    agent,
    paused: false,
    buyAmount: 500n * 10n ** 6n,
    maxPerTrade: 500n * 10n ** 6n,
    dailyLimit: 2_000n * 10n ** 6n,
    accounts: { realDonaldTrump: ['ETH'] },
    assets: [{ asset: 'ETH', budgetShareBps: 10_000, cooldownSec: 60, ...DEMO_ETH_RULE, ...params }],
    topics: {},
  };
  const vault = new SimVault({
    profiles,
    rules: [rule],
    deposits: { r1: 10_000n * 10n ** 6n },
    caller: agent,
    tweetAirnode: fixtureAirnode,
    priceAirnodes: { ETH: fixtureAirnode },
    now: () => clock.now,
  });
  const fixture = (file: string) => readSharedJson<SignedResponse>(`fixtures/synthetic/${file}`);
  const { triggerId } = await vault.openTrigger({
    ruleId: 'r1',
    asset: 'ETH',
    account: 'realDonaldTrump',
    post: fixture('tweet-trump-venezuela.json'),
    p0: fixture('eth-p0.json'),
  });
  clock.now = P0_TIME + 320;
  await vault.confirmTrigger(triggerId, fixture('eth-p1-rise.json'));

  let price = '2100';
  const log = new EventLog();
  const keeper = new SellKeeper({
    profiles,
    vault,
    log,
    now: () => clock.now,
    fetchPrice: async () =>
      signResponse(
        FIXTURE_AIRNODE_KEY,
        deriveRequestHash(priceRequest(getAsset(profiles, 'ETH'))),
        clock.now,
        `{"price":${price},"updatedAt":${clock.now * 1000}}`
      ),
  });

  clock.now = P0_TIME + 400;
  await keeper.tick();
  assert.equal(log.recent().length, 0, 'no sell at +1.4%');

  price = '2240';
  clock.now = P0_TIME + 460;
  await keeper.tick();
  const [sold] = log.recent();
  assert.equal(sold?.kind, 'position.sold');
  assert.equal(sold?.kind === 'position.sold' && sold.sellKind, 'take-profit');
  assert.ok(vault.balanceOf('r1') > 10_000n * 10n ** 6n);

  await keeper.tick();
  assert.equal(log.recent().length, 1, 'a closed position is not sold again');
});

test('the take-profit target rounds up, as the vault does', () => {
  // 3 wei at +8% is 3.24 wei: the vault wants 4, so 3 must not sell
  const tiny = { ...position, entryPrice: 3n };
  assert.equal(decideSell(tiny, params, 3n, 1_100, ['take-profit']), undefined);
  assert.equal(decideSell(tiny, params, 4n, 1_100, ['take-profit']), 'take-profit');
  assert.equal(takeProfitTarget(2000n * e18, 800), 2160n * e18, 'exact when it divides');
});
