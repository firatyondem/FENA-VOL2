// shared/asset-profiles.json: each asset's Pyth feed and the limits a rule may tighten, read once at start-up.
import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { findPrice, toPrice18 } from './pyth/accumulator.ts';
import type { PriceUpdate } from './pyth/hermes.ts';

export type Market = '24/7' | '24/5' | '23/5' | 'exchange-hours';

export interface AssetProfile {
  key: string;
  name: string;
  token: { symbol: string; name: string; decimals: number };
  market: Market;
  trendThresholdBps: number;
  spikeCapBps: number;
  minWaitSec: number;
  maxWindowSec: number;
  pyth: { priceId: Hex; symbol: string };
  suggestedTopics: string[];
}

export interface Profiles {
  priceDecimals: number;
  usdcDecimals: number;
  maxPriceAgeSec: number;
  maxTweetToP0Sec: number;
  // Posts are not signed, so the vault refuses a post older than this when the trigger opens (Vault.MAX_POST_AGE)
  maxPostAgeSec: number;
  maxConfBps: number;
  maxStopLossBps: number;
  ruleDefaults: Record<string, number>;
  demoOverrides: Record<string, number>;
  pyth: { contracts: Record<string, Address>; hermesUrl: string };
  assets: Record<string, AssetProfile>;
}

export const DEFAULT_PROFILES_URL = new URL('../../shared/asset-profiles.json', import.meta.url);

const requireNumber = (value: unknown, where: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${where} must be a number`);
  return value;
};

// Checks the shape once at start-up, so a typo in the shared file fails loudly instead of mid-trigger.
export const parseProfiles = (raw: unknown): Profiles => {
  const file = raw as Profiles & { assets: Record<string, Omit<AssetProfile, 'key'>> };
  for (const field of ['priceDecimals', 'maxPriceAgeSec', 'maxTweetToP0Sec', 'maxPostAgeSec', 'maxConfBps'] as const) {
    requireNumber(file[field], field);
  }
  const assets: Record<string, AssetProfile> = {};
  for (const [key, asset] of Object.entries(file.assets ?? {})) {
    for (const field of ['trendThresholdBps', 'spikeCapBps', 'minWaitSec', 'maxWindowSec'] as const) {
      requireNumber(asset[field], `${key}.${field}`);
    }
    if (asset.spikeCapBps <= asset.trendThresholdBps) throw new Error(`${key}: the spike cap must exceed the threshold`);
    if (asset.maxWindowSec <= asset.minWaitSec) throw new Error(`${key}: the window must end after the minimum wait`);
    if (!/^0x[0-9a-f]{64}$/.test(asset.pyth?.priceId ?? '')) throw new Error(`${key}: pyth.priceId must be a feed ID`);
    assets[key] = { ...asset, key };
  }
  return { ...file, assets };
};

export const loadProfiles = (url: URL = DEFAULT_PROFILES_URL): Profiles =>
  parseProfiles(JSON.parse(readFileSync(url, 'utf8')));

export const getAsset = (profiles: Profiles, key: string): AssetProfile => {
  const asset = profiles.assets[key];
  if (!asset) throw new Error(`No asset profile for ${key}`);
  return asset;
};

// What the gates need of a price: the value with 18 decimals and when Pyth published it. A trigger restored after a
// restart has only these, read from the vault.
export interface PricePoint {
  price: bigint;
  sourceTime: number;
}

export interface SignedPrice extends PricePoint {
  asset: string;
  // Pyth's confidence interval, with 18 decimals
  conf: bigint;
  // When Pyth published the feed's price before this one: P0 must have no price between the post and itself
  prevPublishTime: number;
  // The bytes the vault takes
  update: PriceUpdate;
}

// The asset's price in a Pyth update, as the vault reads it
export const readPythPrice = (asset: AssetProfile, update: PriceUpdate): SignedPrice => {
  const price = findPrice(update.updates, asset.pyth.priceId);
  if (!price) throw new Error(`The update has no ${asset.pyth.symbol} price`);
  return {
    asset: asset.key,
    price: price.price > 0n ? toPrice18(price.price, price.expo) : 0n,
    conf: toPrice18(price.conf, price.expo),
    sourceTime: price.publishTime,
    prevPublishTime: price.prevPublishTime,
    update,
  };
};

// The vault's market-hours rule: a closed market publishes no new prices, so a stale P1 or sell price blocks the trade.
export const isPriceFresh = (profiles: Profiles, price: PricePoint, nowSec: number) =>
  nowSec - price.sourceTime <= profiles.maxPriceAgeSec;

// The vault's confidence rule: conf / price at most maxConfBps
export const isPriceCertain = (profiles: Profiles, price: SignedPrice) =>
  price.price > 0n && price.conf * 10_000n <= price.price * BigInt(profiles.maxConfBps);

export interface RuleWindow {
  trendThresholdBps: number;
  spikeCapBps: number;
  minWaitSec: number;
  maxWindowSec: number;
}

// Users may make a profile stricter, never looser: a higher threshold, a lower cap, a longer wait, a shorter window.
export const looserThanProfile = (asset: AssetProfile, rule: RuleWindow): string[] => {
  const problems: string[] = [];
  if (rule.trendThresholdBps < asset.trendThresholdBps) problems.push('trend threshold below the profile');
  if (rule.spikeCapBps > asset.spikeCapBps) problems.push('spike cap above the profile');
  if (rule.minWaitSec < asset.minWaitSec) problems.push('minimum wait shorter than the profile');
  if (rule.maxWindowSec > asset.maxWindowSec) problems.push('window longer than the profile');
  return problems;
};
