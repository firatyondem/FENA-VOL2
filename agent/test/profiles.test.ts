import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveRequestHash } from '../src/airnode/attestation.ts';
import {
  getAsset,
  isPriceFresh,
  loadProfiles,
  looserThanProfile,
  parseProfiles,
  priceAirnode,
  priceRequest,
  readSignedPrice,
} from '../src/profiles.ts';
import { NODARY_ADDRESS, readFixture, readSharedJson } from './helpers.ts';

const profiles = loadProfiles();

test('loads every asset of the spec', () => {
  assert.deepEqual(Object.keys(profiles.assets).toSorted(), ['BTC', 'DOGE', 'ETH', 'OIL', 'TSLA']);
  assert.equal(getAsset(profiles, 'OIL').token.symbol, 'tOIL');
  assert.throws(() => getAsset(profiles, 'XAU'), /No asset profile/);
});

test('keeps the spec defaults per asset', () => {
  const eth = getAsset(profiles, 'ETH');
  assert.deepEqual([eth.trendThresholdBps, eth.spikeCapBps, eth.minWaitSec, eth.maxWindowSec], [300, 1200, 1800, 14400]);
  const oil = getAsset(profiles, 'OIL');
  assert.deepEqual([oil.trendThresholdBps, oil.spikeCapBps, oil.minWaitSec, oil.maxWindowSec], [150, 500, 3600, 21600]);
  const doge = getAsset(profiles, 'DOGE');
  assert.ok(doge.spikeCapBps > eth.spikeCapBps && doge.trendThresholdBps > eth.trendThresholdBps, 'DOGE is wider');
});

test('builds the price requests that Nodary signed', () => {
  for (const [key, fixture] of [
    ['ETH', 'nodary-eth-usd-p0.json'],
    ['BTC', 'nodary-btc-usd.json'],
    ['DOGE', 'nodary-doge-usd.json'],
  ] as const) {
    const asset = getAsset(profiles, key);
    assert.equal(deriveRequestHash(priceRequest(asset)), readFixture(fixture).requestHash, key);
    assert.equal(priceAirnode(profiles, asset).address, NODARY_ADDRESS);
  }
});

test('reads a signed price and its source time', () => {
  const response = readFixture('nodary-eth-usd-p0.json');
  const signed = readSignedPrice(profiles, getAsset(profiles, 'ETH'), response);
  assert.equal(signed.price, 2244695000000000000000n);
  assert.equal(signed.sourceTime, 1793381072);
  assert.equal(signed.signedAt, 1793381073);
});

test('treats a price older than the limit as a closed market', () => {
  const signed = readSignedPrice(profiles, getAsset(profiles, 'ETH'), readFixture('nodary-eth-usd-p0.json'));
  assert.ok(isPriceFresh(profiles, signed, signed.signedAt + 60));
  assert.ok(!isPriceFresh(profiles, signed, signed.sourceTime + profiles.maxPriceAgeSec + 1));
});

test('flags rule values looser than the profile', () => {
  const oil = getAsset(profiles, 'OIL');
  assert.deepEqual(looserThanProfile(oil, oil), []);
  assert.deepEqual(looserThanProfile(oil, { ...oil, spikeCapBps: 5000 }), ['spike cap above the profile']);
  assert.deepEqual(looserThanProfile(oil, { ...oil, trendThresholdBps: 200, maxWindowSec: 3700 }), []);
  assert.equal(looserThanProfile(oil, { ...oil, trendThresholdBps: 50, minWaitSec: 60 }).length, 2);
});

test('rejects a profile whose cap does not exceed its threshold', () => {
  const raw = readSharedJson<{ assets: Record<string, Record<string, unknown>> }>('asset-profiles.json');
  const broken = structuredClone(raw);
  broken.assets.ETH = { ...broken.assets.ETH, spikeCapBps: 100 };
  assert.throws(() => parseProfiles(broken), /spike cap must exceed/);
});
