// The stage replay: the real engine, classifier and keeper against the SimVault, fed with the signed fixture posts and
// prices signed on the fly by the public fixture key, on a clock that runs faster than real time. It needs no keys and
// no chain, and shows one valid run and the four tamper rejections.
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveRequestHash, type SignedResponse } from './airnode/attestation.ts';
import { signResponse } from './airnode/sign.ts';
import { SimVault } from './chain/sim-vault.ts';
import { type Rule, VaultRejection } from './chain/vault.ts';
import type { Classifier } from './classifier/types.ts';
import { SellKeeper } from './engine/keeper.ts';
import { TriggerEngine } from './engine/trigger-engine.ts';
import type { EventLog } from './log.ts';
import { getAsset, priceRequest, type Profiles } from './profiles.ts';
import type { WatchedAccount } from './sources/twitter.ts';
import { FIXTURE_AIRNODE_KEY, P0_TIME, TWEET_TIME } from '../scripts/fixture-set.ts';

const FIXTURES = new URL('../../shared/fixtures/synthetic/', import.meta.url);
const readFixture = (file: string) => JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as SignedResponse;

export const REPLAY_ACCOUNTS: WatchedAccount[] = [
  { handle: 'realDonaldTrump', label: 'Donald Trump', assets: ['OIL', 'BTC', 'ETH'], pinned: false },
  { handle: 'elonmusk', label: 'Elon Musk', assets: ['DOGE', 'TSLA'], pinned: false },
];

const POSTS: Record<string, string> = {
  realDonaldTrump: 'tweet-trump-venezuela.json',
  elonmusk: 'tweet-musk-doge.json',
};

// Price paths in USD, by seconds after the posts: oil rises past its threshold, then on to take profit
const PRICE_PATH: Record<string, [after: number, price: string][]> = {
  OIL: [
    [0, '70.25'],
    [330, '71.4'],
    // +8.1% on the 71.4 entry: take profit
    [700, '77.2'],
  ],
  ETH: [
    [0, '2000'],
    [330, '2004'],
  ],
  DOGE: [
    [0, '0.07584'],
    [330, '0.0799'],
  ],
  BTC: [[0, '77000']],
};

const priceAt = (asset: string, now: number) => {
  const path = PRICE_PATH[asset] ?? [];
  return path.filter(([after]) => now - TWEET_TIME >= after).at(-1)?.[1];
};

export const replayRule = (profiles: Profiles, agent: `0x${string}`): Rule => {
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
  // 500 USDC a buy, a 2,000 USDC day split 50 / 30 / 20 (spec: 5% per trade and 20% a day of a 10,000 USDC vault)
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

// The spec's four tamper tests against a fresh vault: open a trigger, then try to confirm it with each forgery.
export const runTamperBench = async (profiles: Profiles, log: EventLog) => {
  const airnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
  const clock = { now: P0_TIME + 60 };
  const rule: Rule = { ...replayRule(profiles, airnode), id: 'bench' };
  rule.assets = rule.assets.map((asset) => (asset.asset === 'ETH' ? { ...asset, trendThresholdBps: 300 } : asset));
  const vault = new SimVault({
    profiles,
    rules: [{ ...rule, accounts: { realDonaldTrump: ['ETH'] } }],
    deposits: { bench: 1_000n * 10n ** 6n },
    caller: airnode,
    tweetAirnode: airnode,
    priceAirnodes: { ETH: airnode, BTC: airnode },
    now: () => clock.now,
  });
  const { triggerId } = await vault.openTrigger({
    ruleId: 'bench',
    asset: 'ETH',
    account: 'realDonaldTrump',
    post: readFixture('tweet-trump-venezuela.json'),
    p0: readFixture('eth-p0.json'),
  });
  clock.now = P0_TIME + 320;
  const cases: [name: string, file: string, expected: string][] = [
    ['Edited value', 'tamper-edited-value.json', 'NotSignedByAirnode'],
    ['Stale response', 'tamper-stale.json', 'ResponseTooOld'],
    ['Different request', 'tamper-different-request.json', 'WrongRequestHash'],
    ['Wrong signer', 'tamper-wrong-signer.json', 'NotSignedByAirnode'],
  ];
  for (const [name, file, expected] of cases) {
    let actual = 'accepted';
    try {
      await vault.confirmTrigger(triggerId, readFixture(file));
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
}

export const startReplay = async ({ profiles, log, classifier, speed = 10, tickMs = 250, onClock }: ReplayOptions) => {
  const airnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
  const startedAt = Date.now();
  const origin = TWEET_TIME + 150;
  const now = () => Math.floor(origin + ((Date.now() - startedAt) / 1000) * speed);
  onClock?.(now);

  const rule = replayRule(profiles, airnode);
  const vault = new SimVault({
    profiles,
    rules: [rule],
    deposits: { [rule.id]: 10_000n * 10n ** 6n },
    caller: airnode,
    tweetAirnode: airnode,
    priceAirnodes: Object.fromEntries(Object.keys(PRICE_PATH).map((asset) => [asset, airnode])),
    now,
  });
  const fetchPrice = async (asset: string) => {
    const price = priceAt(asset, now());
    if (!price) throw new Error(`No replay price for ${asset}`);
    const at = now();
    const hash = deriveRequestHash(priceRequest(getAsset(profiles, asset)));
    return signResponse(FIXTURE_AIRNODE_KEY, hash, at, `{"price":${price},"updatedAt":${at * 1000}}`);
  };
  const engine = new TriggerEngine({
    profiles,
    vault,
    classifier,
    log,
    now,
    tweetAirnode: airnode,
    fetchLatestPost: async (account) => readFixture(POSTS[account.handle] as string),
    fetchPrice,
    p1IntervalSec: 30,
  });
  const keeper = new SellKeeper({ profiles, vault, log, now, fetchPrice });

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
  return { now, engine, vault, stop: () => clearInterval(timer) };
};
