import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import type { AirnodeRequest, SignedResponse } from './airnode/attestation.ts';
import { readUint } from './airnode/projected-json.ts';

export type Market = '24/7' | '24/5' | 'exchange-hours';

export interface PriceSource {
  airnode: string;
  operation: string;
  parameters: Record<string, unknown>;
  responseProjection: Record<string, string>;
  timeField: string;
  timeUnit: 'ms' | 's';
}

export interface AssetProfile {
  key: string;
  name: string;
  token: { symbol: string; name: string; decimals: number };
  market: Market;
  trendThresholdBps: number;
  spikeCapBps: number;
  minWaitSec: number;
  maxWindowSec: number;
  price: PriceSource;
  suggestedTopics: string[];
}

export interface AirnodeEndpoint {
  url: string;
  address: Address;
}

export interface Profiles {
  priceDecimals: number;
  usdcDecimals: number;
  maxPriceAgeSec: number;
  maxTweetToP0Sec: number;
  ruleDefaults: Record<string, number>;
  demoOverrides: Record<string, number>;
  airnodes: Record<string, AirnodeEndpoint>;
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
  requireNumber(file.priceDecimals, 'priceDecimals');
  requireNumber(file.maxPriceAgeSec, 'maxPriceAgeSec');
  requireNumber(file.maxTweetToP0Sec, 'maxTweetToP0Sec');
  const assets: Record<string, AssetProfile> = {};
  for (const [key, asset] of Object.entries(file.assets ?? {})) {
    for (const field of ['trendThresholdBps', 'spikeCapBps', 'minWaitSec', 'maxWindowSec'] as const) {
      requireNumber(asset[field], `${key}.${field}`);
    }
    if (asset.spikeCapBps <= asset.trendThresholdBps) throw new Error(`${key}: the spike cap must exceed the threshold`);
    if (asset.maxWindowSec <= asset.minWaitSec) throw new Error(`${key}: the window must end after the minimum wait`);
    if (!file.airnodes?.[asset.price?.airnode]) throw new Error(`${key}: unknown Airnode ${asset.price?.airnode}`);
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

export const priceRequest = (asset: AssetProfile): AirnodeRequest => ({
  operation: asset.price.operation,
  parameters: asset.price.parameters,
  responseProjection: asset.price.responseProjection,
});

export const priceAirnode = (profiles: Profiles, asset: AssetProfile): AirnodeEndpoint => {
  const endpoint = profiles.airnodes[asset.price.airnode];
  if (!endpoint) throw new Error(`Unknown Airnode ${asset.price.airnode}`);
  return endpoint;
};

export interface SignedPrice {
  asset: string;
  // USD per whole asset token, with `priceDecimals` decimals
  price: bigint;
  // When the data source took the price, in seconds
  sourceTime: number;
  // When the Airnode signed the response, in seconds
  signedAt: number;
  response: SignedResponse;
}

export const readSignedPrice = (profiles: Profiles, asset: AssetProfile, response: SignedResponse): SignedPrice => {
  const price = readUint(response.data, 'price', profiles.priceDecimals);
  const rawTime = readUint(response.data, asset.price.timeField, 0);
  const sourceTime = Number(asset.price.timeUnit === 'ms' ? rawTime / 1000n : rawTime);
  return { asset: asset.key, price, sourceTime, signedAt: Number(response.timestamp), response };
};

// The spec's market-hours rule: a closed market has no fresh trades, so a stale source time blocks the trade.
export const isPriceFresh = (profiles: Profiles, price: SignedPrice, nowSec: number) =>
  nowSec - price.sourceTime <= profiles.maxPriceAgeSec && nowSec - price.signedAt <= profiles.maxPriceAgeSec;

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
