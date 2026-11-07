// TwitterAPI.io (https://docs.twitterapi.io): billed per tweet returned, about $0.15 per 1,000 ($0.00015 a tweet); an
// empty page is billed as one item. Auth: X-API-Key. The agent searches `from:<handle> since_id:<id>`, which the
// advanced search documents, so a quiet account costs one item per poll.
import { type FetchResult, newPosts, type PostSource, ProviderError, type ProviderTweet, type WatchedAccount } from './posts.ts';

export const TWITTERAPI_IO_URL = 'https://api.twitterapi.io';
export const TWITTERAPI_IO_USD_PER_TWEET = 0.00015;

export interface TwitterApiIoOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  usdPerTweet?: number;
  // Items billed for a page with fewer tweets, at least
  minItemsPerCall?: number;
}

export class TwitterApiIoSource implements PostSource {
  readonly name = 'twitterapi.io';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly usdPerTweet: number;
  private readonly minItemsPerCall: number;

  constructor({
    apiKey,
    baseUrl = TWITTERAPI_IO_URL,
    fetch: fetchImpl = fetch,
    usdPerTweet = TWITTERAPI_IO_USD_PER_TWEET,
    minItemsPerCall = 1,
  }: TwitterApiIoOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.usdPerTweet = usdPerTweet;
    this.minItemsPerCall = minItemsPerCall;
  }

  async fetchNewPosts(account: WatchedAccount, sinceId?: string): Promise<FetchResult> {
    const query = `from:${account.handle}${sinceId ? ` since_id:${sinceId}` : ''} -filter:replies`;
    const url = `${this.baseUrl}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`;
    const response = await this.fetchImpl(url, { headers: { 'X-API-Key': this.apiKey, accept: 'application/json' } });
    if (!response.ok) throw new ProviderError('TwitterAPI.io', response.status, await response.text());
    const body = (await response.json()) as { tweets?: ProviderTweet[] };
    const tweets = body.tweets ?? [];
    const items = Math.max(tweets.length, this.minItemsPerCall);
    return {
      posts: newPosts(tweets, account.handle, sinceId),
      cost: { calls: 1, items: tweets.length, usd: items * this.usdPerTweet },
    };
  }
}
