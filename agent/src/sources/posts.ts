// Posts of the watched accounts, from a paid X data provider. Posts are no longer signed, so the vault cannot prove a post
// is real: a fake post can at most open a price check, and the vault buys only if later Pyth prices confirm the move.
import { keccak256, toHex } from 'viem';

export interface WatchedAccount {
  handle: string;
  label: string;
  // The assets this account is linked to; the classifier only checks a post against these
  assets: string[];
  // Kept for the watchlist file's shape; search-based sources never see a pinned post
  pinned?: boolean;
}

export interface Post {
  id: string;
  text: string;
  author: string;
  // Seconds since the epoch, from the snowflake ID, which is what the vault reads
  createdAt: number;
  isRepost: boolean;
}

// What one fetch cost: the provider bills per call or per post returned
export interface FetchCost {
  calls: number;
  items: number;
  usd: number;
}

export interface FetchResult {
  // Oldest first, only posts newer than `sinceId`
  posts: Post[];
  cost: FetchCost;
}

export interface PostSource {
  readonly name: string;
  // The account's posts newer than `sinceId`; without it, only the newest one
  fetchNewPosts(account: WatchedAccount, sinceId?: string): Promise<FetchResult>;
}

// The vault's account ID: keccak256 of the lower-case handle (Deploy.s.sol's accountId)
export const accountIdOf = (handle: string) => keccak256(toHex(handle.toLowerCase()));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const X_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/;

// X writes times as "Tue Dec 10 07:00:30 +0000 2024". Parsed by hand, since Date.parse of this form is not standard.
export const parseXDate = (text: string): number => {
  const match = X_DATE.exec(text);
  if (!match) throw new Error(`"${text}" is not an X date`);
  const [, monthName, day, hours, minutes, seconds, sign, offsetHours, offsetMinutes, year] = match;
  const month = MONTHS.indexOf(monthName ?? '');
  if (month < 0) throw new Error(`"${text}" has an unknown month`);
  const utc = Date.UTC(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)) / 1000;
  const offset = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60;
  return sign === '+' ? utc - offset : utc + offset;
};

// X ids are Snowflakes: the top 42 bits are milliseconds since 2010-11-04T01:42:54.657Z. The vault takes a post's time
// from its ID with integer arithmetic.
export const X_EPOCH_MS = 1288834974657n;

export const snowflakeTime = (id: string): number => {
  if (!/^\d+$/.test(id)) throw new Error(`"${id}" is not a numeric X id`);
  return Number(((BigInt(id) >> 22n) + X_EPOCH_MS) / 1000n);
};

export const snowflakeAt = (seconds: number, sequence = 0n): string =>
  (((BigInt(seconds) * 1000n - X_EPOCH_MS) << 22n) | sequence).toString();

export const isNewer = (id: string, sinceId: string | undefined) => !sinceId || BigInt(id) > BigInt(sinceId);

// The fields both providers share: id, text, createdAt, author.userName, and a retweeted_tweet or "RT @" prefix
export interface ProviderTweet {
  id?: string;
  text?: string;
  createdAt?: string;
  author?: { userName?: string };
  retweeted_tweet?: unknown;
  isReply?: boolean;
}

export const toPost = (tweet: ProviderTweet, handle: string): Post | undefined => {
  if (!tweet.id || !/^\d+$/.test(tweet.id) || typeof tweet.text !== 'string') return undefined;
  return {
    id: tweet.id,
    text: tweet.text,
    author: tweet.author?.userName ?? handle,
    createdAt: snowflakeTime(tweet.id),
    // A repost carries someone else's post; the account did not write it.
    isRepost: Boolean(tweet.retweeted_tweet) || /^RT @\w+:/.test(tweet.text),
  };
};

// Oldest first, newer than sinceId, one per ID, without replies; with no sinceId only the newest
export const newPosts = (tweets: readonly ProviderTweet[], handle: string, sinceId?: string): Post[] => {
  const seen = new Set<string>();
  const posts = tweets
    .filter((tweet) => !tweet.isReply)
    .flatMap((tweet) => toPost(tweet, handle) ?? [])
    .filter((post) => isNewer(post.id, sinceId) && !seen.has(post.id) && seen.add(post.id))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return sinceId ? posts : posts.slice(-1);
};

export class ProviderError extends Error {
  readonly status: number;

  constructor(provider: string, status: number, body: string) {
    super(`${provider} answered ${status}: ${body.slice(0, 200)}`);
    this.name = 'ProviderError';
    this.status = status;
  }
}
