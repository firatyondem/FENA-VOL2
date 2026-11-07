import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTamperSet } from '../scripts/tamper-set.ts';
import { getAsset } from '../src/profiles.ts';
import { findPrice } from '../src/pyth/accumulator.ts';
import { type PriceUpdate, readHermesResponse } from '../src/pyth/hermes.ts';
import type { PriceSource } from '../src/pyth/price-source.ts';
import { profiles, readPythFixture, scriptedPrices, T } from './helpers.ts';

const ETH_FEED = getAsset(profiles, 'ETH').pyth.priceId;
const P1_TIME = 1794059218;

// Real signed updates: the latest ETH price is eth-p1, an hour earlier is eth-p0, and BTC comes from a scripted feed
const realPrices = (): PriceSource => {
  const btc = scriptedPrices({ now: T }, { BTC: [[0, '77000']] });
  return {
    latest: async (asset: string): Promise<PriceUpdate> =>
      asset === 'ETH' ? readHermesResponse(readPythFixture('eth-p1')) : btc.updateAt('BTC', T),
    firstAt: async () => readHermesResponse(readPythFixture('eth-p0')),
  };
};

test('the tamper set holds a genuine price and the three forgeries checkPrice can name', async () => {
  const cases = await buildTamperSet(profiles, realPrices(), 'ETH', P1_TIME + 10);
  assert.deepEqual(
    cases.map(({ name, expected }) => [name, expected]),
    [
      ['Genuine', 'accepted'],
      ['Edited price', 'InvalidPriceUpdate'],
      ['Old price', 'PriceTooOld'],
      ['Wrong asset', 'WrongPriceFeed'],
    ]
  );
  const [genuine, edited, old, wrong] = cases;
  assert.equal(findPrice(genuine?.update ?? [], ETH_FEED)?.publishTime, P1_TIME);

  // One byte of the ETH price changed, nothing else
  const a = Buffer.from((genuine?.update[0] ?? '0x').slice(2), 'hex');
  const b = Buffer.from((edited?.update[0] ?? '0x').slice(2), 'hex');
  assert.equal(a.length, b.length);
  assert.equal([...a].filter((byte, index) => byte !== b[index]).length, 1);
  assert.notEqual(findPrice(edited?.update ?? [], ETH_FEED)?.price, findPrice(genuine?.update ?? [], ETH_FEED)?.price);

  // Older than the vault's five minutes
  assert.ok(P1_TIME + 10 - (findPrice(old?.update ?? [], ETH_FEED)?.publishTime ?? 0) > profiles.maxPriceAgeSec);
  // No ETH price at all
  assert.equal(findPrice(wrong?.update ?? [], ETH_FEED), undefined);
});
