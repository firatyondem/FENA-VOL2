import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import type { Rule, RuleAsset } from '../src/chain/vault.ts';
import type { Candidate, Classification, Classifier } from '../src/classifier/types.ts';
import { loadProfiles } from '../src/profiles.ts';
import type { HermesResponseJson } from '../src/pyth/hermes.ts';
import { ScriptedPriceSource, usd8 } from '../src/pyth/price-source.ts';
import { isNewer, type Post, type PostSource, snowflakeAt, type WatchedAccount } from '../src/sources/posts.ts';

const sharedUrl = new URL('../../shared/', import.meta.url);

export const readSharedJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(new URL(relativePath, sharedUrl), 'utf8')) as T;

// A real Hermes response saved from Base Sepolia: eth-p0, eth-p1 or eth-later
export const readPythFixture = (name: string) => readSharedJson<HermesResponseJson>(`fixtures/pyth/${name}.json`);

export const profiles = loadProfiles();

export const AGENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const USER: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
// 2026-10-30T17:20:00Z
export const T = 1793380800;

export const trump: WatchedAccount = { handle: 'realDonaldTrump', label: 'Donald Trump', assets: ['OIL', 'BTC', 'ETH'] };

export const ruleAsset = (asset: string, overrides: Partial<RuleAsset> = {}): RuleAsset => ({
  asset,
  budgetShareBps: 5000,
  trendThresholdBps: asset === 'OIL' ? 150 : 300,
  spikeCapBps: asset === 'OIL' ? 500 : 1200,
  minWaitSec: 120,
  maxWindowSec: 600,
  cooldownSec: 60,
  takeProfitBps: 800,
  stagnationBandBps: 100,
  stagnationAfterSec: 600,
  stopLossBps: 500,
  ...overrides,
});

export const makeRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: USER,
  owner: USER,
  agent: AGENT,
  paused: false,
  buyAmount: 500n * 10n ** 6n,
  maxPerTrade: 500n * 10n ** 6n,
  dailyLimit: 2_000n * 10n ** 6n,
  accounts: { realDonaldTrump: ['OIL', 'ETH'] },
  assets: [ruleAsset('OIL'), ruleAsset('ETH')],
  topics: {},
  ...overrides,
});

// Price paths from `T` on, in USD
export const scriptedPrices = (clock: { now: number }, paths: Record<string, [after: number, usd: string][]>) =>
  new ScriptedPriceSource(
    profiles,
    Object.fromEntries(
      Object.entries(paths).map(([asset, path]) => [asset, path.map(([after, usd]) => [T + after, usd8(usd)] as [number, bigint])])
    ),
    () => clock.now
  );

export const post = (text: string, sequence = 1n, createdAt = T, author = 'realDonaldTrump'): Post => ({
  id: snowflakeAt(createdAt, sequence),
  text,
  author,
  createdAt,
  isRepost: false,
});

// A post source that counts its calls and can fail like an unreachable provider
export class FakePosts implements PostSource {
  readonly name = 'fake';
  calls: { handle: string; sinceId?: string }[] = [];
  outages = 0;
  posts: Post[];
  private readonly clock: { now: number };

  constructor(clock: { now: number }, posts: Post[] = []) {
    this.clock = clock;
    this.posts = posts;
  }

  async fetchNewPosts(account: WatchedAccount, sinceId?: string) {
    this.calls.push({ handle: account.handle, ...(sinceId ? { sinceId } : {}) });
    if (this.outages > 0) {
      this.outages -= 1;
      throw new Error('503 from the post provider');
    }
    const posts = this.posts.filter(
      (entry) => entry.author === account.handle && entry.createdAt <= this.clock.now && isNewer(entry.id, sinceId)
    );
    return { posts, cost: { calls: 1, items: posts.length, usd: 0.001 } };
  }
}

// Answers with fixed results, so the engine is tested without a model
export class StubClassifier implements Classifier {
  readonly name = 'stub';
  calls = 0;
  outages = 0;
  private readonly answers: Record<string, [boolean, number]>;

  constructor(answers: Record<string, [boolean, number]>) {
    this.answers = answers;
  }

  async classify(_post: unknown, candidates: Candidate[]): Promise<Classification[]> {
    this.calls += 1;
    if (this.outages > 0) {
      this.outages -= 1;
      throw new Error('503 overloaded');
    }
    return candidates
      .filter((candidate) => this.answers[candidate.asset])
      .map((candidate) => {
        const [relevant, confidence] = this.answers[candidate.asset] as [boolean, number];
        return { asset: candidate.asset, relevant, confidence, reason: 'stub' };
      });
  }
}
