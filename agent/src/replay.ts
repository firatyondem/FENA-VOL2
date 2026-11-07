// The stage replay: the real engine, classifier and keeper against the SimVault, fed with scripted posts and Pyth price
// paths on a clock that runs faster than real time. It needs no keys and no chain, and shows one valid run and the four
// tamper rejections. The updates are LocalPyth's unsigned ones; the deployed vault has the real Pyth contract check
// signatures (contracts/test/fork/PythFork.t.sol runs real ones).
import type { Address } from 'viem';
import { SimVault } from './chain/sim-vault.ts';
import { type Rule, VaultRejection } from './chain/vault.ts';
import type { Classifier } from './classifier/types.ts';
import type { CostRecorder } from './engine/costs.ts';
import { SellKeeper } from './engine/keeper.ts';
import { TriggerEngine } from './engine/trigger-engine.ts';
import type { EventLog } from './log.ts';
import { getAsset, type Profiles } from './profiles.ts';
import type { PriceUpdate } from './pyth/hermes.ts';
import { ScriptedPriceSource, usd8 } from './pyth/price-source.ts';
import { isNewer, type Post, type PostSource, snowflakeAt, type WatchedAccount } from './sources/posts.ts';
import type { DecisionLog } from './store/decisions.ts';

// 2026-10-30T17:20:00Z, when both replay posts go out
export const TWEET_TIME = 1793380800;
const REPLAY_AGENT: Address = '0x00000000000000000000000000000000000fe4a0';

export const REPLAY_ACCOUNTS: WatchedAccount[] = [
  { handle: 'realDonaldTrump', label: 'Donald Trump', assets: ['OIL', 'BTC', 'ETH'] },
  { handle: 'elonmusk', label: 'Elon Musk', assets: ['DOGE', 'TSLA'] },
];

export const REPLAY_POSTS: Post[] = [
  {
    id: snowflakeAt(TWEET_TIME, 1n),
    author: 'realDonaldTrump',
    text: 'We are coming for Venezuela. Big things are happening!',
    createdAt: TWEET_TIME,
    isRepost: false,
  },
  {
    id: snowflakeAt(TWEET_TIME, 2n),
    author: 'elonmusk',
    text: 'Ðogecoin is the people’s crypto',
    createdAt: TWEET_TIME,
    isRepost: false,
  },
];

// Price paths in USD, by seconds after the posts: oil rises past its threshold, then on to take profit
const PRICE_PATH: Record<string, [after: number, price: string][]> = {
  OIL: [
    [-60, '70.25'],
    [330, '71.4'],
    // +8.1% on the 71.4 entry: take profit
    [700, '77.2'],
  ],
  ETH: [
    [-60, '2000'],
    [330, '2004'],
  ],
  DOGE: [
    [-60, '0.07584'],
    [330, '0.0799'],
  ],
  BTC: [[-60, '77000']],
};

const pricePaths = () =>
  Object.fromEntries(
    Object.entries(PRICE_PATH).map(([asset, path]) => [
      asset,
      path.map(([after, price]) => [TWEET_TIME + after, usd8(price)] as [number, bigint]),
    ])
  );

// The scripted posts, each visible once its time has come
export class ScriptedPostSource implements PostSource {
  readonly name = 'replay';
  private readonly posts: readonly Post[];
  private readonly now: () => number;

  constructor(posts: readonly Post[], now: () => number) {
    this.posts = posts;
    this.now = now;
  }

  async fetchNewPosts(account: WatchedAccount, sinceId?: string) {
    const posts = this.posts.filter(
      (post) => post.author === account.handle && post.createdAt <= this.now() && isNewer(post.id, sinceId)
    );
    return { posts, cost: { calls: 1, items: posts.length, usd: 0 } };
  }
}

export const replayRule = (profiles: Profiles, agent: Address): Rule => {
  const sell = { takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 };
  const demo = (asset: string, budgetShareBps: number) => {
    const profile = getAsset(profiles, asset);
    return {
      asset,
      budgetShareBps,
      trendThresholdBps: profile.trendThresholdBps,
      spikeCapBps: profile.spikeCapBps,
      minWaitSec: profiles.demoOverrides.minWaitSec ?? 120,
      maxWindowSec: profiles.demoOverrides.maxWindowSec ?? 600,
      cooldownSec: profiles.demoOverrides.cooldownSec ?? 60,
      ...sell,
    };
  };
  // 500 USDC a buy, a 2,000 USDC day split 50 / 30 / 20 (5% per trade and 20% a day of a 10,000 USDC vault)
  return {
    id: 'demo-1',
    owner: agent,
    agent,
    paused: false,
    buyAmount: 500n * 10n ** 6n,
    maxPerTrade: 500n * 10n ** 6n,
    dailyLimit: 2_000n * 10n ** 6n,
    accounts: { realDonaldTrump: ['OIL', 'ETH'], elonmusk: ['DOGE'] },
    assets: [demo('OIL', 5000), demo('ETH', 3000), demo('DOGE', 2000)],
    topics: {},
  };
};

// The tamper test against a fresh vault: open a trigger, then try to confirm it with an edited, an old and another
// asset's price, and open a second trigger with the first one's P0.
export const runTamperBench = async (profiles: Profiles, log: EventLog) => {
  const clock = { now: TWEET_TIME + 60 };
  const rule: Rule = { ...replayRule(profiles, REPLAY_AGENT), id: 'bench', accounts: { realDonaldTrump: ['ETH'] } };
  const vault = new SimVault({
    profiles,
    rules: [rule],
    deposits: { bench: 1_000n * 10n ** 6n },
    caller: REPLAY_AGENT,
    now: () => clock.now,
  });
  const prices = new ScriptedPriceSource(profiles, pricePaths(), () => clock.now);
  const p0 = prices.updateAt('ETH', TWEET_TIME);
  const post = (sequence: bigint) => snowflakeAt(TWEET_TIME, sequence);
  const { triggerId } = await vault.openTrigger({ ruleId: 'bench', asset: 'ETH', account: 'realDonaldTrump', postId: post(1n), p0 });
  clock.now = TWEET_TIME + 330;

  const edited: PriceUpdate = { updates: [prices.updateAt('ETH', clock.now).updates[0]?.slice(0, -2) as `0x${string}`], prices: [] };
  const cases: [name: string, expected: string, attempt: () => Promise<unknown>][] = [
    ['Edited price', 'InvalidPriceUpdate', () => vault.confirmTrigger(triggerId, edited)],
    ['Old price', 'PriceTooOld', () => vault.confirmTrigger(triggerId, prices.updateAt('ETH', clock.now - 360))],
    ['Wrong asset', 'WrongPriceFeed', () => vault.confirmTrigger(triggerId, prices.updateAt('BTC', clock.now))],
    [
      'Replayed price',
      'PriceAlreadyUsed',
      () => vault.openTrigger({ ruleId: 'bench', asset: 'ETH', account: 'realDonaldTrump', postId: post(2n), p0 }),
    ],
  ];
  for (const [name, expected, attempt] of cases) {
    let actual = 'accepted';
    try {
      await attempt();
    } catch (error) {
      actual = error instanceof VaultRejection ? error.reason : String(error);
    }
    log.append({ kind: 'tamper.result', name, expected, actual, passed: actual === expected });
  }
};

export interface ReplayOptions {
  profiles: Profiles;
  log: EventLog;
  classifier: Classifier;
  // Agent seconds per real second
  speed?: number;
  tickMs?: number;
  // Receives the replay clock before the first event, so the log can stamp events with it
  onClock?: (now: () => number) => void;
  decisions?: DecisionLog;
  costs?: CostRecorder;
}

export const startReplay = async ({
  profiles,
  log,
  classifier,
  speed = 10,
  tickMs = 250,
  onClock,
  decisions,
  costs,
}: ReplayOptions) => {
  const startedAt = Date.now();
  const origin = TWEET_TIME + 150;
  const now = () => Math.floor(origin + ((Date.now() - startedAt) / 1000) * speed);
  onClock?.(now);

  const rule = replayRule(profiles, REPLAY_AGENT);
  const vault = new SimVault({
    profiles,
    rules: [rule],
    deposits: { [rule.id]: 10_000n * 10n ** 6n },
    caller: REPLAY_AGENT,
    now,
  });
  const prices = new ScriptedPriceSource(profiles, pricePaths(), now);
  const posts = new ScriptedPostSource(REPLAY_POSTS, now);
  const engine = new TriggerEngine({
    profiles,
    vault,
    classifier,
    posts,
    prices,
    log,
    now,
    p1IntervalSec: 30,
    ...(decisions ? { decisions } : {}),
    ...(costs ? { costs } : {}),
  });
  const keeper = new SellKeeper({ profiles, vault, log, now, prices, ...(costs ? { costs } : {}) });

  log.append({
    kind: 'agent.started',
    mode: 'replay',
    vault: `SimVault (rule ${rule.id}, 10,000 USDC)`,
    classifier: classifier.name,
    accounts: REPLAY_ACCOUNTS.map((account) => account.handle),
  });
  await runTamperBench(profiles, log);
  for (const account of REPLAY_ACCOUNTS) await engine.pollAccount(account);

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await engine.checkPending();
      await keeper.tick();
    } finally {
      busy = false;
    }
  }, tickMs);
  return { now, engine, vault, prices, stop: () => clearInterval(timer) };
};
