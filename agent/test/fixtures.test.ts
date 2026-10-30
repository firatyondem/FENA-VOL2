import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Address, Hex } from 'viem';
import { AttestationError, verifySignedResponse } from '../src/airnode/attestation.ts';
import { checkTrend, checkTweetToP0, type GateFailure } from '../src/engine/gates.ts';
import { getAsset, loadProfiles, readSignedPrice } from '../src/profiles.ts';
import { readSignedPost, snowflakeTime } from '../src/sources/twitter.ts';
import { buildFixtureSet, type Expectation, serialize } from '../scripts/fixture-set.ts';
import { readSharedJson } from './helpers.ts';

interface Manifest {
  fixtureAirnode: { address: Address };
  times: { maxTweetToP0Sec: number };
  rules: Record<string, { trendThresholdBps: number; spikeCapBps: number; minWaitSec: number; maxWindowSec: number }>;
  requests: Record<string, { requestHash: Hex }>;
  cases: { file: string; role: string; request: string; expect: Expectation }[];
}

const profiles = loadProfiles();
const manifest = readSharedJson<Manifest>('fixtures/synthetic/manifest.json');
const fixture = (file: string) => readSharedJson<Parameters<typeof readSignedPost>[0]>(`fixtures/synthetic/${file}`);
const airnode = manifest.fixtureAirnode.address;
// Each price case is submitted where its asset's ETH or OIL request is expected; the BTC case is the wrong request.
const submittedFor = (request: string) => (request === 'price:BTC' ? 'price:ETH' : request);
const assetOf = (request: string) => submittedFor(request).split(':')[1] as string;

const attestationReasons: Partial<Record<Expectation, AttestationError['reason']>> = {
  'reject: signature invalid': 'wrong-signer',
  'reject: unexpected signer': 'wrong-signer',
  'reject: wrong request hash': 'wrong-request',
};

const gateReasons: Partial<Record<Expectation, GateFailure>> = {
  'reject: below trend threshold': 'below-threshold',
  'reject: above spike cap': 'above-spike-cap',
  'reject: before minimum wait': 'before-min-wait',
  'reject: after maximum window': 'after-max-window',
  'reject: too old / outside window': 'before-min-wait',
  'reject: tweet too old for P0': 'tweet-too-old-for-p0',
};

test('the committed fixtures are exactly what the generator writes', async () => {
  const { manifest: generated, cases } = await buildFixtureSet(profiles);
  const directory = new URL('../../shared/fixtures/synthetic/', import.meta.url);
  assert.equal(readFileSync(new URL('manifest.json', directory), 'utf8'), serialize(generated));
  for (const { file, response } of cases) {
    assert.equal(readFileSync(new URL(file, directory), 'utf8'), serialize(response), file);
  }
});

for (const entry of manifest.cases) {
  test(`${entry.file}: ${entry.expect}`, async () => {
    const response = fixture(entry.file);
    const expectedHash = manifest.requests[submittedFor(entry.request)]?.requestHash as Hex;
    const attestationReason = attestationReasons[entry.expect];
    if (attestationReason) {
      await assert.rejects(
        verifySignedResponse(response, airnode, expectedHash),
        (error) => error instanceof AttestationError && error.reason === attestationReason
      );
      return;
    }
    await verifySignedResponse(response, airnode, expectedHash);

    if (entry.role === 'tweet') {
      const post = readSignedPost(response);
      assert.equal(snowflakeTime(post.id), post.createdAt, 'the id carries the creation time');
      const p0 = readSignedPrice(profiles, getAsset(profiles, 'ETH'), fixture('eth-p0.json'));
      const result = checkTweetToP0(post.createdAt, p0, manifest.times.maxTweetToP0Sec);
      assert.deepEqual(result, entry.expect === 'accept' ? { ok: true } : { ok: false, reason: gateReasons[entry.expect] });
      return;
    }
    if (entry.role === 'p1') {
      const asset = getAsset(profiles, assetOf(entry.request));
      const p0 = readSignedPrice(profiles, asset, fixture(`${asset.key.toLowerCase()}-p0.json`));
      const p1 = readSignedPrice(profiles, asset, response);
      const result = checkTrend(p0, p1, manifest.rules[asset.key] as Manifest['rules'][string]);
      assert.deepEqual(result, entry.expect === 'accept' ? { ok: true } : { ok: false, reason: gateReasons[entry.expect] });
    }
  });
}
