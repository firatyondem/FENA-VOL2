// Pyth's Hermes API: signed price updates for the vault. Since 2026-08-26 Hermes needs an API key, sent as a bearer
// token, so the agent fetches updates for the website too (GET /api/price-update) and the key never reaches a browser.
import type { Hex } from 'viem';
import { type PythPrice, readUpdate } from './accumulator.ts';

export const DEFAULT_HERMES_URL = 'https://hermes.pyth.network';

// Hermes's JSON, as GET /v2/updates/price/... returns it with encoding=hex and parsed=true
export interface HermesPriceJson {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

export interface HermesParsedJson {
  // Without 0x, as Hermes writes it
  id: string;
  price: HermesPriceJson;
  ema_price: HermesPriceJson;
  metadata: { prev_publish_time: number; slot?: number; proof_available_time?: number };
}

export interface HermesResponseJson {
  // Each entry is hex without 0x
  binary: { encoding: 'hex'; data: string[] };
  parsed?: HermesParsedJson[];
}

// What the vault takes, with the prices the agent reads from it
export interface PriceUpdate {
  // The `bytes[]` argument of openTrigger, confirmTrigger, sell and checkPrice
  updates: Hex[];
  // Read from the bytes themselves, never from Hermes's parsed JSON
  prices: PythPrice[];
}

const strip = (hex: string) => (hex.startsWith('0x') ? hex.slice(2) : hex);
const with0x = (hex: string): Hex => (hex.startsWith('0x') ? (hex as Hex) : (`0x${hex}` as Hex));

const priceJson = (price: bigint, conf: bigint, expo: number, publishTime: number): HermesPriceJson => ({
  price: price.toString(),
  conf: conf.toString(),
  expo,
  publish_time: publishTime,
});

// Hermes's response for `updates`, built from the bytes
export const hermesResponse = (updates: readonly Hex[]): HermesResponseJson => ({
  binary: { encoding: 'hex', data: updates.map(strip) },
  parsed: updates.flatMap(readUpdate).map((p) => ({
    id: strip(p.id),
    price: priceJson(p.price, p.conf, p.expo, p.publishTime),
    ema_price: priceJson(p.emaPrice, p.emaConf, p.expo, p.publishTime),
    metadata: { prev_publish_time: p.prevPublishTime },
  })),
});

export const readHermesResponse = (json: HermesResponseJson): PriceUpdate => {
  if (json?.binary?.encoding !== 'hex' || !Array.isArray(json.binary.data)) throw new Error('not a Hermes hex response');
  const updates = json.binary.data.map(with0x);
  return { updates, prices: updates.flatMap(readUpdate) };
};

export class HermesError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HermesError';
    this.status = status;
  }
}

export interface HermesClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl = DEFAULT_HERMES_URL, apiKey, fetch: fetchImpl = fetch }: HermesClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  // The latest update for each feed: a P1 or a sell price
  latest(feedIds: readonly Hex[]): Promise<PriceUpdate> {
    return this.get('latest', feedIds);
  }

  // The first update published at or after `publishTime`: a P0 for a post at that second
  firstAt(feedIds: readonly Hex[], publishTime: number): Promise<PriceUpdate> {
    return this.get(String(Math.floor(publishTime)), feedIds);
  }

  private async get(at: string, feedIds: readonly Hex[]): Promise<PriceUpdate> {
    const query = feedIds.map((id) => `ids%5B%5D=${strip(id)}`).join('&');
    const url = `${this.baseUrl}/v2/updates/price/${at}?${query}&encoding=hex&parsed=true`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      const hint = response.status === 401 ? ' (set PYTH_API_KEY: Hermes needs a key since 2026-08-26)' : '';
      throw new HermesError(response.status, `Hermes ${response.status}${hint}: ${body}`);
    }
    return readHermesResponse((await response.json()) as HermesResponseJson);
  }
}
