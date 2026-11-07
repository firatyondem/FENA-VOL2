import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimVault } from '../src/chain/sim-vault.ts';
import { type Rule, VaultRejection } from '../src/chain/vault.ts';
import type { PriceUpdate } from '../src/pyth/hermes.ts';
import { snowflakeAt } from '../src/sources/posts.ts';
import { AGENT, makeRule, profiles, ruleAsset, scriptedPrices, T, USER } from './helpers.ts';

const setup = (rule: Rule = makeRule()) => {
  const clock = { now: T + 60 };
  const vault = new SimVault({ profiles, rules: [rule], deposits: { [rule.id]: 10_000n * 10n ** 6n }, caller: AGENT, now: () => clock.now });
  const prices = scriptedPrices(clock, {
    OIL: [
      [-60, '70.25'],
      [300, '71.4'],
      [600, '77.2'],
      [900, '67'],
    ],
    ETH: [[-60, '2000']],
    BTC: [[-60, '77000']],
  });
  const open = (postAt = T, p0: PriceUpdate = prices.updateAt('OIL', T), sequence = 1n) =>
    vault.openTrigger({ ruleId: USER, asset: 'OIL', account: 'realDonaldTrump', postId: snowflakeAt(postAt, sequence), p0 });
  return { clock, vault, prices, open };
};

const reason = async (action: Promise<unknown>) => {
  try {
    await action;
    return 'accepted';
  } catch (error) {
    if (error instanceof VaultRejection) return error.reason;
    throw error;
  }
};

test('opens on the first price after the post and buys on a confirming P1', async () => {
  const { clock, vault, prices, open } = setup();
  const { triggerId } = await open();
  clock.now = T + 300;
  const bought = await vault.confirmTrigger(triggerId, prices.updateAt('OIL', T + 300));
  assert.equal(bought.price, 71_4n * 10n ** 17n);
  const [position] = await vault.listPositions();
  assert.deepEqual(position?.exits, { takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 });
});

test('Gate 1 refuses what the vault refuses, by its error names', async () => {
  const { clock, prices, open } = setup();
  // A price that is not the first after the post: Pyth published one in between
  assert.equal(await reason(open(T, prices.updateAt('OIL', T + 5))), 'PriceNotFirstAfterPost');
  assert.equal(await reason(open(T, prices.updateAt('OIL', T - 1))), 'PriceOutsideTweetWindow');
  assert.equal(await reason(open(T, prices.updateAt('BTC', T))), 'WrongPriceFeed');
  clock.now = T + 1801;
  assert.equal(await reason(open(T)), 'PostOutsideWindow');
});

test('the tamper cases: edited, old, wrong asset and replayed', async () => {
  const { clock, vault, prices, open } = setup();
  const { triggerId } = await open();
  clock.now = T + 300;
  const fresh = prices.updateAt('OIL', T + 300);
  const edited = { updates: [fresh.updates[0]?.slice(0, -2) as `0x${string}`], prices: [] };
  assert.equal(await reason(vault.confirmTrigger(triggerId, edited)), 'InvalidPriceUpdate');
  assert.equal(await reason(vault.confirmTrigger(triggerId, prices.updateAt('OIL', T - 60))), 'PriceTooOld');
  assert.equal(await reason(vault.confirmTrigger(triggerId, prices.updateAt('BTC', T + 300))), 'WrongPriceFeed');
  // A second post in the same second would take the same P0, which is used
  assert.equal(await reason(open(T, prices.updateAt('OIL', T), 2n)), 'PriceAlreadyUsed');
  assert.equal(await reason(vault.confirmTrigger(triggerId, fresh)), 'accepted');
});

test('stop-loss sells at or below the line, and a position keeps the exits it was bought with', async () => {
  const { clock, vault, prices, open } = setup();
  const { triggerId } = await open();
  clock.now = T + 300;
  const { positionId } = await vault.confirmTrigger(triggerId, prices.updateAt('OIL', T + 300));
  // The user turns stop-loss off after the buy
  vault.setRule(makeRule({ assets: [ruleAsset('OIL', { stopLossBps: 0 }), ruleAsset('ETH')] }));
  clock.now = T + 900;
  // 67 is 6.2% below the 71.4 entry, past the 5% line the position was bought with
  assert.equal(await reason(vault.sell(positionId, 'take-profit', prices.updateAt('OIL', T + 900))), 'TakeProfitNotReached');
  const sold = await vault.sell(positionId, 'stop-loss', prices.updateAt('OIL', T + 900));
  assert.equal(sold.price, 67n * 10n ** 18n);
});

test('a P1 of an asset the user took out of the rule is refused, and the trigger expires at once', async () => {
  const { clock, vault, prices, open } = setup();
  const { triggerId } = await open();
  vault.setRule(makeRule({ assets: [ruleAsset('ETH')], accounts: { realDonaldTrump: ['ETH'] } }));
  clock.now = T + 300;
  assert.equal(await reason(vault.confirmTrigger(triggerId, prices.updateAt('OIL', T + 300))), 'AssetNotAllowed');
  await vault.expireTrigger(triggerId);
  assert.equal(vault.listTriggers()[0]?.status, 'expired');
});
