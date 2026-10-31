// Shared by the end-to-end test and the local stage driver: anvil's public test accounts, its clock, and posts and
// prices signed at chain time by the public fixture key, built exactly like the synthetic fixtures.
import type { Hex, PublicClient, TestClient } from 'viem';
import { deriveRequestHash, type SignedResponse } from '../src/airnode/attestation.ts';
import { signResponse } from '../src/airnode/sign.ts';
import { getAsset, priceRequest, type Profiles } from '../src/profiles.ts';
import { latestTweetRequest, snowflakeAt } from '../src/sources/twitter.ts';
import { FIXTURE_AIRNODE_KEY, formatXDate } from './fixture-set.ts';

// anvil's first four default accounts: public, test-only keys
export const ANVIL_KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  one: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  two: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  three: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const satisfies Record<string, Hex>;

export const chainTime = async (publicClient: PublicClient) => Number((await publicClient.getBlock()).timestamp);

// Moves anvil's clock forward and mines a block, so the next transaction sees the new time
export const advanceChain = async (testClient: TestClient, publicClient: PublicClient, seconds: number) => {
  if (seconds > 0) await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
  return chainTime(publicClient);
};

export interface FixturePost {
  handle: string;
  // Seconds; the Snowflake id encodes it, as a real X id does
  createdAt: number;
  // Seconds; when the "Airnode" signed the response
  signedAt: number;
  text: string;
  sequence?: bigint;
  pinned?: boolean;
  key?: Hex;
}

export const signFixturePost = ({ handle, createdAt, signedAt, text, sequence = 1n, pinned = false, key = FIXTURE_AIRNODE_KEY }: FixturePost) =>
  signResponse(
    key,
    deriveRequestHash(latestTweetRequest({ handle, pinned })),
    signedAt,
    JSON.stringify({ author: handle, createdAt: formatXDate(createdAt), id: snowflakeAt(createdAt, sequence), text })
  );

// A price taken and signed at `at`, in the projection every asset's request uses (updatedAt in milliseconds)
export const signFixturePrice = (
  profiles: Profiles,
  asset: string,
  price: string,
  at: number,
  key: Hex = FIXTURE_AIRNODE_KEY,
  requestAsset: string = asset
): Promise<SignedResponse> =>
  signResponse(
    key,
    deriveRequestHash(priceRequest(getAsset(profiles, requestAsset))),
    at,
    `{"price":${price},"updatedAt":${at * 1000}}`
  );
