import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AirnodeHttpError, fetchSignedResponse } from '../src/airnode/client.ts';
import { readFixture } from './helpers.ts';

const request = { operation: 'latestFeeds', parameters: { name: 'ETH/USD' } };

const fakeFetch =
  (status: number, body: unknown, seen: Request[] = []): typeof fetch =>
  async (input, init) => {
    seen.push(new Request(input, init));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };

test('posts the request as JSON and returns the signed response', async () => {
  const signed = readFixture('nodary-eth-usd-p0.json');
  const seen: Request[] = [];
  const response = await fetchSignedResponse('https://airnode.example/', request, fakeFetch(200, signed, seen));
  assert.deepEqual(response, signed);
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[0]?.headers.get('content-type'), 'application/json');
  assert.deepEqual(await seen[0]?.json(), request);
});

test('explains a 402 from a priced operation', async () => {
  await assert.rejects(
    fetchSignedResponse('https://airnode.example/', request, fakeFetch(402, { error: 'Payment required' })),
    (error) => error instanceof AirnodeHttpError && error.status === 402 && /PAYER_PRIVATE_KEY/.test(error.message)
  );
});

test('passes on other errors with their body', async () => {
  await assert.rejects(
    fetchSignedResponse('https://airnode.example/', request, fakeFetch(502, '{"error":"upstream"}')),
    (error) => error instanceof AirnodeHttpError && error.status === 502 && /upstream/.test(error.message)
  );
});

test('rejects a 200 that is not a signed response', async () => {
  await assert.rejects(
    fetchSignedResponse('https://airnode.example/', request, fakeFetch(200, { data: '{}' })),
    /without a signed response/
  );
});
