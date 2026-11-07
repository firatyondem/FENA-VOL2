import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editPrice } from '../scripts/tamper-set.ts';
import { getAsset, readPythPrice } from '../src/profiles.ts';
import {
  encodeLocalUpdate,
  findPrice,
  readAccumulatorUpdate,
  readLocalUpdate,
  readUpdate,
  toPrice18,
} from '../src/pyth/accumulator.ts';
import { HermesClient, hermesResponse, readHermesResponse } from '../src/pyth/hermes.ts';
import { HermesPriceSource, usd8 } from '../src/pyth/price-source.ts';
import { profiles, readPythFixture } from './helpers.ts';

const ETH_FEED = getAsset(profiles, 'ETH').pyth.priceId;
const BTC_FEED = getAsset(profiles, 'BTC').pyth.priceId;

test('reads the price messages of a real signed update', () => {
  const update = readHermesResponse(readPythFixture('eth-p1'));
  assert.equal(update.updates.length, 1);
  const eth = findPrice(update.updates, ETH_FEED);
  assert.ok(eth);
  assert.equal(eth.price, 224464595033n);
  assert.equal(eth.expo, -8);
  assert.equal(eth.publishTime, 1794059218);
  assert.equal(eth.prevPublishTime, 1794059217);
  assert.ok(findPrice(update.updates, BTC_FEED), 'the update carries BTC too');
  assert.equal(findPrice(update.updates, getAsset(profiles, 'DOGE').pyth.priceId), undefined);
});

test('the fixture JSON says what its bytes say', () => {
  const json = readPythFixture('eth-p0');
  const fromBytes = hermesResponse(readHermesResponse(json).updates);
  assert.deepEqual(fromBytes.parsed, json.parsed);
  assert.deepEqual(fromBytes.binary, json.binary);
});

test('reads the asset price with 18 decimals, as the vault does', () => {
  const price = readPythPrice(getAsset(profiles, 'ETH'), readHermesResponse(readPythFixture('eth-p0')));
  assert.equal(price.price, 2236_50466218n * 10n ** 10n);
  assert.equal(price.sourceTime, 1794057378);
  assert.equal(price.prevPublishTime, 1794057377);
  assert.throws(() => readPythPrice(getAsset(profiles, 'DOGE'), readHermesResponse(readPythFixture('eth-p0'))), /no Crypto.DOGE/);
});

test('scales any exponent to 18 decimals', () => {
  assert.equal(toPrice18(207050000000n, -8), 2070_5n * 10n ** 17n);
  assert.equal(toPrice18(5n, 0), 5n * 10n ** 18n);
  assert.equal(toPrice18(12345n, -20), 123n);
  assert.equal(toPrice18(1n, 12), 10n ** 30n);
});

test('a LocalPyth update round-trips', () => {
  const update = encodeLocalUpdate({ id: ETH_FEED, price: usd8('2070.5'), conf: 10n, expo: -8, publishTime: 100, prevPublishTime: 90 });
  const price = readLocalUpdate(update);
  assert.equal(price.price, 207050000000n);
  assert.equal(price.prevPublishTime, 90);
  assert.deepEqual(readUpdate(update), [price]);
});

test('an edited price no longer reads the same, which Pyth refuses', () => {
  const { updates } = readHermesResponse(readPythFixture('eth-p1'));
  const edited = editPrice(updates, ETH_FEED);
  assert.notEqual(edited[0], updates[0]);
  assert.equal(readAccumulatorUpdate(edited[0] as `0x${string}`).find((p) => p.id === ETH_FEED)?.price, 224464595033n ^ 1n);
});

test('Hermes: the key goes in a bearer header, the feeds in the query', async () => {
  const seen: { url: string; auth?: string }[] = [];
  const json = readPythFixture('eth-p1');
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: (init?.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify(json));
  }) as typeof fetch;
  const hermes = new HermesClient({ apiKey: 'k', fetch: fake, baseUrl: 'https://hermes.example/' });
  const latest = await hermes.latest([ETH_FEED]);
  await hermes.firstAt([ETH_FEED], 1794059218.7);
  assert.equal(seen[0]?.auth, 'Bearer k');
  assert.equal(seen[0]?.url, `https://hermes.example/v2/updates/price/latest?ids%5B%5D=${ETH_FEED.slice(2)}&encoding=hex&parsed=true`);
  assert.match(seen[1]?.url ?? '', /\/v2\/updates\/price\/1794059218\?/);
  assert.equal(latest.prices.length, 3);
});

test('Hermes: a missing key says how to fix it', async () => {
  const hermes = new HermesClient({ fetch: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch });
  await assert.rejects(hermes.latest([ETH_FEED]), /401 \(set PYTH_API_KEY/);
});

test('the price source shares one latest update per asset for a few seconds', async () => {
  let calls = 0;
  const clock = { ms: 0 };
  const fake = (async () => {
    calls += 1;
    return new Response(JSON.stringify(readPythFixture('eth-p1')));
  }) as typeof fetch;
  const source = new HermesPriceSource(profiles, new HermesClient({ fetch: fake }), 5_000, () => clock.ms);
  await source.latest('ETH');
  await source.latest('ETH');
  assert.equal(calls, 1);
  clock.ms = 5_000;
  await source.latest('ETH');
  assert.equal(calls, 2);
});
