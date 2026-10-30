// The spec's four tamper tests, built from real signed Nodary responses so the deployed vault faces genuine data:
// an edited value, a stale response, a valid response for another asset, and data signed with our own key.
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import { ATTACKER_KEY } from './fixture-set.ts';

export interface TamperCase {
  name: string;
  how: string;
  expected: string;
  response: SignedResponse;
}

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
