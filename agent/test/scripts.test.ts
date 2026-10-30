import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttestationError, type SignedResponse, verifySignedResponse } from '../src/airnode/attestation.ts';
import { loadProfiles } from '../src/profiles.ts';
import { buildRequestHashes } from '../scripts/request-hashes.ts';
import { buildTamperSet } from '../scripts/tamper-set.ts';
import { NODARY_ADDRESS, readFixture, readSharedJson } from './helpers.ts';

const profiles = loadProfiles();
const eth = readFixture('nodary-eth-usd-p0.json');
const btc = readFixture('nodary-btc-usd.json');

test('the request hashes match the real Nodary responses and the fixture manifest', () => {
  const watchlist = readSharedJson<{ handle: string; label: string; assets: string[]; pinned: boolean }[]>(
    '../agent/config/watchlist.json'
  );
  const hashes = buildRequestHashes(profiles, watchlist);
  assert.equal(hashes.prices.ETH?.requestHash, eth.requestHash);
  assert.equal(hashes.prices.BTC?.requestHash, btc.requestHash);
  assert.equal(hashes.prices.ETH?.airnode, NODARY_ADDRESS);
  const manifest = readSharedJson<{ requests: Record<string, { requestHash: string }> }>('fixtures/synthetic/manifest.json');
  assert.equal(hashes.posts.realDonaldTrump?.requestHash, manifest.requests['tweet:realDonaldTrump']?.requestHash);
  assert.equal(hashes.posts.elonmusk?.airnode, '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB');
});

test('the live tamper set fails the checks the spec names, on real Nodary data', async () => {
  const cases = await buildTamperSet(eth, btc, eth);
  const reasons = await Promise.all(
    cases.map(async ({ name, response }: { name: string; response: SignedResponse }) => {
      try {
        await verifySignedResponse(response, NODARY_ADDRESS, eth.requestHash);
        return [name, 'verified'];
      } catch (error) {
        return [name, error instanceof AttestationError ? error.reason : 'other'];
      }
    })
  );
  assert.deepEqual(reasons, [
    ['Edited value', 'wrong-signer'],
    // A stale response still has a valid signature; the vault refuses it on age
    ['Stale response', 'verified'],
    ['Different request', 'wrong-request'],
    ['Wrong signer', 'wrong-signer'],
  ]);
  assert.match(cases[0]?.response.data ?? '', /"price":4489.39/);
});
