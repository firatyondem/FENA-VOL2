// GetXAPI (https://docs.getxapi.com): $0.001 per call, about 20 tweets a page, so about $0.05 per 1,000 tweets.
// Auth: Authorization: Bearer <key>. The agent searches `from:<handle> since_id:<id>`; GetXAPI documents only the
// `since:` date operator, and `since_id:` is X's own search operator, so the agent also drops anything not newer itself.
import { type FetchResult, newPosts, type PostSource, ProviderError, type ProviderTweet, type WatchedAccount } from './posts.ts';

export const GETXAPI_URL = 'https://api.getxapi.com';
export const GETXAPI_USD_PER_CALL = 0.001;

export interface GetXApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  usdPerCall?: number;
}

export class GetXApiSource implements PostSource {
  readonly name = 'getxapi';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly usdPerCall: number;

  constructor({ apiKey, baseUrl = GETXAPI_URL, fetch: fetchImpl = fetch, usdPerCall = GETXAPI_USD_PER_CALL }: GetXApiOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.usdPerCall = usdPerCall;
  }

  async fetchNewPosts(account: WatchedAccount, sinceId?: string): Promise<FetchResult> {
    const query = `from:${account.handle}${sinceId ? ` since_id:${sinceId}` : ''} -filter:replies`;
    const url = `${this.baseUrl}/twitter/tweet/advanced_search?q=${encodeURIComponent(query)}&product=Latest`;
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
    });
    if (!response.ok) throw new ProviderError('GetXAPI', response.status, await response.text());
    const body = (await response.json()) as { tweets?: ProviderTweet[] };
    const tweets = body.tweets ?? [];
    return {
      posts: newPosts(tweets, account.handle, sinceId),
      cost: { calls: 1, items: tweets.length, usd: this.usdPerCall },
    };
  }
}
