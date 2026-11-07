// Where the agent gets Pyth price updates: Hermes in live mode, a scripted price path in the replay and the tests. The
// vault verifies every update itself, so a source can only fail to help, never make the vault buy.
import type { Hex } from 'viem';
import { getAsset, type Profiles } from '../profiles.ts';
import { encodeLocalUpdate, readUpdate } from './accumulator.ts';
import type { HermesClient, PriceUpdate } from './hermes.ts';

export interface PriceSource {
  // The latest update: a P1 or a sell price
  latest(asset: string): Promise<PriceUpdate>;
  // The first update published at or after `time`: the P0 of a post at that second
  firstAt(asset: string, time: number): Promise<PriceUpdate>;
}

// Hermes, with each asset's latest update reused for `cacheMs`, so the keeper, Gate 2 and the website share one fetch
export class HermesPriceSource implements PriceSource {
  private readonly cache = new Map<string, { at: number; update: Promise<PriceUpdate> }>();
  private readonly profiles: Profiles;
  private readonly hermes: HermesClient;
  private readonly cacheMs: number;
  private readonly nowMs: () => number;

  constructor(profiles: Profiles, hermes: HermesClient, cacheMs = 5_000, nowMs: () => number = Date.now) {
    this.profiles = profiles;
    this.hermes = hermes;
    this.cacheMs = cacheMs;
    this.nowMs = nowMs;
  }

  private feed(asset: string): Hex {
    return getAsset(this.profiles, asset).pyth.priceId;
  }

  latest(asset: string): Promise<PriceUpdate> {
    const cached = this.cache.get(asset);
    if (cached && this.nowMs() - cached.at < this.cacheMs) return cached.update;
    const update = this.hermes.latest([this.feed(asset)]);
    update.catch(() => this.cache.delete(asset));
    this.cache.set(asset, { at: this.nowMs(), update });
    return update;
  }

  firstAt(asset: string, time: number): Promise<PriceUpdate> {
    return this.hermes.firstAt([this.feed(asset)], time);
  }
}

// A price path for the replay and the tests: [time, USD with 8 decimals] steps, each published as an unsigned LocalPyth
// update. Pyth publishes a price every second along the path, so the first price after a post comes in the post's
// second.
export class ScriptedPriceSource implements PriceSource {
  private readonly profiles: Profiles;
  private readonly paths: Record<string, [from: number, price: bigint][]>;
  private readonly now: () => number;
  private readonly confBps: bigint;

  constructor(
    profiles: Profiles,
    paths: Record<string, [from: number, price: bigint][]>,
    now: () => number,
    confBps = 5n
  ) {
    this.profiles = profiles;
    this.paths = paths;
    this.now = now;
    this.confBps = confBps;
  }

  private priceAt(asset: string, time: number): bigint {
    const step = (this.paths[asset] ?? []).filter(([from]) => from <= time).at(-1);
    if (!step) throw new Error(`No price for ${asset} at ${time}`);
    return step[1];
  }

  updateAt(asset: string, time: number): PriceUpdate {
    const price = this.priceAt(asset, time);
    const update = encodeLocalUpdate({
      id: getAsset(this.profiles, asset).pyth.priceId,
      price,
      conf: (price * this.confBps) / 10_000n,
      expo: -8,
      publishTime: time,
      prevPublishTime: time - 1,
    });
    return { updates: [update], prices: readUpdate(update) };
  }

  async latest(asset: string): Promise<PriceUpdate> {
    return this.updateAt(asset, this.now());
  }

  async firstAt(asset: string, time: number): Promise<PriceUpdate> {
    return this.updateAt(asset, Math.max(time, this.paths[asset]?.[0]?.[0] ?? time));
  }
}

// USD with 8 decimals, as Pyth writes most feeds: usd8('2070.5') = 207050000000n
export const usd8 = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** 8n + BigInt((fraction + '00000000').slice(0, 8));
};
