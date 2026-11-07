// Shared by the end-to-end test and the local stage driver: anvil's public test accounts, its clock, and posts and Pyth
// prices at chain time. On a plain anvil chain the deploy script installs LocalPyth, which takes unsigned updates.
import type { Hex, PublicClient, TestClient } from 'viem';
import { getAsset, type Profiles } from '../src/profiles.ts';
import { encodeLocalUpdate, readUpdate } from '../src/pyth/accumulator.ts';
import type { PriceUpdate } from '../src/pyth/hermes.ts';
import { usd8 } from '../src/pyth/price-source.ts';
import { type Post, snowflakeAt } from '../src/sources/posts.ts';

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

// The time the next transaction will see. An idle anvil's latest block can be minutes old, and a price published at that
// time would already be stale when mined, so this mines a block first.
export const chainNow = (testClient: TestClient, publicClient: PublicClient) => advanceChain(testClient, publicClient, 0);

export interface LocalPost {
  handle: string;
  // Seconds; the Snowflake id encodes it, as a real X id does
  createdAt: number;
  text: string;
  sequence?: bigint;
}

export const localPost = ({ handle, createdAt, text, sequence = 1n }: LocalPost): Post => ({
  id: snowflakeAt(createdAt, sequence),
  author: handle,
  text,
  createdAt,
  isRepost: false,
});

// A LocalPyth price of `asset` in USD (such as "2070.5"), published at `at`, the first since `prevPublishTime`
export const localPriceUpdate = (
  profiles: Profiles,
  asset: string,
  price: string,
  at: number,
  prevPublishTime = at - 1
): PriceUpdate => {
  const update = encodeLocalUpdate({
    id: getAsset(profiles, asset).pyth.priceId,
    price: usd8(price),
    conf: 0n,
    expo: -8,
    publishTime: at,
    prevPublishTime,
  });
  return { updates: [update], prices: readUpdate(update) };
};
