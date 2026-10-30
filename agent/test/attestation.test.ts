import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import {
  AttestationError,
  deriveRequestHash,
  toSubmission,
  verifySignedResponse,
} from '../src/airnode/attestation.ts';
import { NODARY_ADDRESS, readFixture } from './helpers.ts';

const ethRequest = {
  operation: 'latestFeeds',
  parameters: { name: 'ETH/USD' },
  responseProjection: { price: '/ETH~1USD/value', updatedAt: '/ETH~1USD/timestamp' },
};

const ethResponse = readFixture('nodary-eth-usd.json');
const btcResponse = readFixture('nodary-btc-usd.json');

test('derives the request hash that Nodary signed for ETH/USD', () => {
  assert.equal(deriveRequestHash(ethRequest), ethResponse.requestHash);
});

test('derives the same hash whatever the order of the projection fields', () => {
  const reversed = { price: ethRequest.responseProjection.price, updatedAt: ethRequest.responseProjection.updatedAt };
  const swapped = { updatedAt: reversed.updatedAt, price: reversed.price };
  assert.equal(deriveRequestHash({ ...ethRequest, responseProjection: swapped }), ethResponse.requestHash);
});

test('sorts keys in UTF-8 byte order at every depth', () => {
  const expected = keccak256(toHex('["op",[["a",[["B",1],["b",2]]],["withLocation",true],["withflights",false]]]'));
  const parameters = { withflights: false, withLocation: true, a: { b: 2, B: 1 } };
  assert.equal(deriveRequestHash({ operation: 'op', parameters }), expected);
});

test('leaves the projection out of the hash when there is none', () => {
  assert.equal(deriveRequestHash({ operation: 'op', parameters: {} }), keccak256(toHex('["op",[]]')));
});

test('accepts a real signed Nodary response', async () => {
  await verifySignedResponse(ethResponse, NODARY_ADDRESS, ethResponse.requestHash);
  await verifySignedResponse(btcResponse, NODARY_ADDRESS, btcResponse.requestHash);
});

test('rejects an edited value, because the signature no longer recovers to the Airnode', async () => {
  const edited = { ...ethResponse, data: ethResponse.data.replace(/"price":[\d.]+/, '"price":1') };
  await assert.rejects(verifySignedResponse(edited, NODARY_ADDRESS, ethResponse.requestHash), (error) => {
    assert.ok(error instanceof AttestationError);
    assert.equal(error.reason, 'wrong-signer');
    return true;
  });
});

test('rejects a valid response for another asset as the wrong request', async () => {
  await assert.rejects(verifySignedResponse(btcResponse, NODARY_ADDRESS, ethResponse.requestHash), (error) => {
    assert.ok(error instanceof AttestationError);
    assert.equal(error.reason, 'wrong-request');
    return true;
  });
});

test('rejects a response whose hash was relabelled, since it recovers over the expected hash', async () => {
  const relabelled = { ...btcResponse, requestHash: ethResponse.requestHash };
  await assert.rejects(verifySignedResponse(relabelled, NODARY_ADDRESS, ethResponse.requestHash), {
    name: 'AttestationError',
  });
});

test('rejects a response from another Airnode', async () => {
  const otherAirnode = '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB';
  await assert.rejects(verifySignedResponse(ethResponse, otherAirnode, ethResponse.requestHash), (error) => {
    assert.ok(error instanceof AttestationError);
    assert.equal(error.reason, 'wrong-signer');
    return true;
  });
});

test('rejects a timestamp that is not whole seconds', async () => {
  await assert.rejects(
    verifySignedResponse({ ...ethResponse, timestamp: '1.5' }, NODARY_ADDRESS, ethResponse.requestHash),
    (error) => error instanceof AttestationError && error.reason === 'malformed'
  );
});

test('submits the signed data as its exact bytes', () => {
  const submission = toSubmission(ethResponse);
  assert.equal(submission.timestamp, BigInt(ethResponse.timestamp));
  assert.equal(Buffer.from(submission.data.slice(2), 'hex').toString('utf8'), ethResponse.data);
  assert.equal(submission.signature, ethResponse.signature);
});
