import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAsset, isPriceCertain, isPriceFresh, looserThanProfile, parseProfiles, readPythPrice } from '../src/profiles.ts';
import { readHermesResponse } from '../src/pyth/hermes.ts';
import { profiles, readPythFixture, readSharedJson } from './helpers.ts';

test('loads every asset with a Pyth feed: crypto, a stock, an ETF and oil', () => {
  assert.deepEqual(Object.keys(profiles.assets).toSorted(), ['BTC', 'DOGE', 'ETH', 'OIL', 'SPY', 'TSLA']);
  assert.equal(getAsset(profiles, 'OIL').token.symbol, 'tOIL');
  assert.equal(getAsset(profiles, 'ETH').pyth.priceId, '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace');
  assert.equal(getAsset(profiles, 'TSLA').pyth.symbol, 'Equity.US.TSLA/USD');
  assert.equal(getAsset(profiles, 'SPY').market, 'exchange-hours');
  assert.throws(() => getAsset(profiles, 'XAU'), /No asset profile/);
});

test('names Base Sepolia’s Pyth contract and the vault’s limits', () => {
  assert.equal(profiles.pyth.contracts['84532'], '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729');
  assert.equal(profiles.maxPostAgeSec, 1800);
  assert.equal(profiles.maxTweetToP0Sec, 600);
  assert.equal(profiles.maxStopLossBps, 2000);
});

test('keeps the spec defaults per asset', () => {
  const eth = getAsset(profiles, 'ETH');
  assert.deepEqual([eth.trendThresholdBps, eth.spikeCapBps, eth.minWaitSec, eth.maxWindowSec], [300, 1200, 1800, 14400]);
  const oil = getAsset(profiles, 'OIL');
  assert.deepEqual([oil.trendThresholdBps, oil.spikeCapBps, oil.minWaitSec, oil.maxWindowSec], [150, 500, 3600, 21600]);
  const doge = getAsset(profiles, 'DOGE');
  assert.ok(doge.spikeCapBps > eth.spikeCapBps && doge.trendThresholdBps > eth.trendThresholdBps, 'DOGE is wider');
});

test('a real price is fresh for five minutes and certain enough', () => {
  const price = readPythPrice(getAsset(profiles, 'ETH'), readHermesResponse(readPythFixture('eth-p1')));
  assert.ok(isPriceFresh(profiles, price, price.sourceTime + 300));
  assert.ok(!isPriceFresh(profiles, price, price.sourceTime + 301));
  // ETH's confidence is about 0.08% of the price, inside the 1% limit
  assert.ok(isPriceCertain(profiles, price));
  assert.ok(!isPriceCertain(profiles, { ...price, conf: price.price / 50n }));
});

test('flags rule values looser than the profile', () => {
  const oil = getAsset(profiles, 'OIL');
  assert.deepEqual(looserThanProfile(oil, oil), []);
  assert.deepEqual(looserThanProfile(oil, { ...oil, spikeCapBps: 5000 }), ['spike cap above the profile']);
  assert.equal(looserThanProfile(oil, { ...oil, trendThresholdBps: 50, minWaitSec: 60 }).length, 2);
});

test('rejects a broken profile file', () => {
  const raw = readSharedJson<{ assets: Record<string, Record<string, unknown>> }>('asset-profiles.json');
  const cap = structuredClone(raw);
  cap.assets.ETH = { ...cap.assets.ETH, spikeCapBps: 100 };
  assert.throws(() => parseProfiles(cap), /spike cap must exceed/);
  const feed = structuredClone(raw);
  feed.assets.ETH = { ...feed.assets.ETH, pyth: { priceId: 'ETH/USD' } };
  assert.throws(() => parseProfiles(feed), /must be a feed ID/);
});
