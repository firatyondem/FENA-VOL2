// The spec's four tamper tests, built from real signed Nodary responses so the deployed vault faces genuine data:
// an edited value, a stale response, a valid response for another asset, and data signed with our own key.
import { readFileSync } from 'node:fs';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import type { TamperCase } from '../src/console/server.ts';
import { ATTACKER_KEY } from './fixture-set.ts';

export type { TamperCase };

// A genuine Nodary signature from long ago, past the vault's age limit
export const readStaleEth = () =>
  JSON.parse(readFileSync(new URL('../../shared/fixtures/nodary-eth-usd.json', import.meta.url), 'utf8')) as SignedResponse;

export const buildTamperSet = async (
  freshEth: SignedResponse,
  freshBtc: SignedResponse,
  staleEth: SignedResponse
): Promise<TamperCase[]> => [
  {
    name: 'Edited value',
    how: 'Raised the price in a real signed ETH/USD response',
    expected: 'NotSignedByAirnode',
    response: { ...freshEth, data: freshEth.data.replace(/"price":([\d.]+)/, (_, price) => `"price":${Number(price) * 2}`) },
  },
  {
    name: 'Stale response',
    how: 'Submitted an old real ETH/USD response',
    expected: 'ResponseTooOld',
    response: staleEth,
  },
  {
    name: 'Different request',
    how: 'Submitted a valid BTC/USD response where ETH/USD is expected',
    expected: 'WrongRequestHash',
    response: freshBtc,
  },
  {
    name: 'Wrong signer',
    how: 'Signed real ETH/USD data with our own key',
    expected: 'NotSignedByAirnode',
    response: await signResponse(ATTACKER_KEY, freshEth.requestHash, Number(freshEth.timestamp), freshEth.data),
  },
];

// The judges' sequence: first the real response, which the vault must accept, then the four forgeries of it
export const buildJudgeSet = async (
  freshEth: SignedResponse,
  freshBtc: SignedResponse,
  staleEth: SignedResponse
): Promise<TamperCase[]> => [
  { name: 'Real, fresh response', how: 'A fresh signed ETH/USD response, unchanged', expected: 'accepted', response: freshEth },
  ...(await buildTamperSet(freshEth, freshBtc, staleEth)),
];

export const fetchJudgeSet = async (fetchPrice: (asset: string) => Promise<SignedResponse>) =>
  buildJudgeSet(await fetchPrice('ETH'), await fetchPrice('BTC'), readStaleEth());
