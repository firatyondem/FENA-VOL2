// Posts come from the TwitterAPI.io Airnode as signed userLastTweets responses, so the vault can check that a post is
// real, from a watched account, and new, before the agent's reading of it matters at all.
import type { AirnodeRequest, SignedResponse } from '../airnode/attestation.ts';
import { readString } from '../airnode/projected-json.ts';

export interface WatchedAccount {
  handle: string;
  label: string;
  // The assets this account is linked to; the classifier only checks a post against these
  assets: string[];
  // A pinned tweet sits first in userLastTweets, so the newest post is item 1 instead of 0
  pinned: boolean;
}

export interface Post {
  id: string;
  text: string;
  author: string;
  // Seconds since the epoch, from the signed createdAt
  createdAt: number;
  isRepost: boolean;
  response: SignedResponse;
}

// The projection keeps the signed data small enough for the vault to read: one tweet's id, text, time and author.
export const latestTweetRequest = (account: Pick<WatchedAccount, 'handle' | 'pinned'>): AirnodeRequest => {
  const item = account.pinned ? 1 : 0;
  return {
    operation: 'userLastTweets',
    parameters: { userName: account.handle },
    responseProjection: {
      author: `/data/tweets/${item}/author/userName`,
      createdAt: `/data/tweets/${item}/createdAt`,
      id: `/data/tweets/${item}/id`,
      text: `/data/tweets/${item}/text`,
    },
  };
};

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

// X ids are Snowflakes: the top 42 bits are milliseconds since 2010-11-04T01:42:54.657Z. The vault can take a post's
// creation time from its signed id with integer arithmetic, without parsing the date string on-chain.
export const X_EPOCH_MS = 1288834974657n;

export const snowflakeTime = (id: string): number => {
  if (!/^\d+$/.test(id)) throw new Error(`"${id}" is not a numeric X id`);
  return Number(((BigInt(id) >> 22n) + X_EPOCH_MS) / 1000n);
};

export const snowflakeAt = (seconds: number, sequence = 0n): string =>
  (((BigInt(seconds) * 1000n - X_EPOCH_MS) << 22n) | sequence).toString();

export const readSignedPost = (response: SignedResponse): Post => {
  const text = readString(response.data, 'text');
  return {
    id: readString(response.data, 'id'),
    text,
    author: readString(response.data, 'author'),
    createdAt: parseXDate(readString(response.data, 'createdAt')),
    // A repost carries the original text after "RT @handle:"; it is someone else's post, not the account's own.
    isRepost: /^RT @\w+:/.test(text),
    response,
  };
};
