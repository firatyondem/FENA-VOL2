import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { GetXApiSource } from '../src/sources/getxapi.ts';
import { accountIdOf, newPosts, parseXDate, snowflakeAt, snowflakeTime } from '../src/sources/posts.ts';
import { TwitterApiIoSource } from '../src/sources/twitterapi-io.ts';
import { trump } from './helpers.ts';

const T = Date.UTC(2026, 9, 30, 17, 20, 0) / 1000;
const tweet = (sequence: bigint, text: string, extra: Record<string, unknown> = {}) => ({
  id: snowflakeAt(T, sequence),
  text,
  createdAt: 'Fri Oct 30 17:20:00 +0000 2026',
  author: { userName: 'realDonaldTrump' },
  ...extra,
});

const fakeFetch = (body: unknown, seen: { url: string; headers: Record<string, string> }[], status = 200) =>
  (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

test('the vault knows an account by keccak256 of its lower-case handle', () => {
  assert.equal(accountIdOf('realDonaldTrump'), keccak256(toHex('realdonaldtrump')));
});

test('parses the X date format, offsets included', () => {
  assert.equal(parseXDate('Tue Dec 10 07:00:30 +0000 2024'), Date.UTC(2024, 11, 10, 7, 0, 30) / 1000);
  assert.equal(parseXDate('Fri Oct 30 18:00:00 +0100 2026'), Date.UTC(2026, 9, 30, 17, 0, 0) / 1000);
  assert.equal(parseXDate('Fri Oct 30 12:30:00 -0530 2026'), Date.UTC(2026, 9, 30, 18, 0, 0) / 1000);
  assert.throws(() => parseXDate('2024-12-10T07:00:30Z'), /not an X date/);
});

test('reads the creation time from an X id, as the vault does', () => {
  assert.equal(snowflakeTime('0'), 1288834974);
  assert.equal(new Date(snowflakeTime('1846987139428634858') * 1000).toISOString().slice(0, 7), '2024-10');
  assert.equal(snowflakeTime(snowflakeAt(T, 7n)), T);
  assert.throws(() => snowflakeTime('12ab'), /not a numeric X id/);
});

test('keeps only posts newer than the last one seen, oldest first, without replies or doubles', () => {
  const tweets = [tweet(3n, 'third'), tweet(1n, 'first'), tweet(2n, 'second'), tweet(3n, 'third'), tweet(4n, 'reply', { isReply: true })];
  assert.deepEqual(
    newPosts(tweets, 'realDonaldTrump', snowflakeAt(T, 1n)).map((post) => post.text),
    ['second', 'third']
  );
  // The first poll of an account takes only its newest post
  assert.deepEqual(newPosts(tweets, 'realDonaldTrump').map((post) => post.text), ['third']);
});

test('marks a repost', () => {
  const [repost] = newPosts([tweet(1n, 'RT @dogeofficial: much wow')], 'elonmusk');
  assert.equal(repost?.isRepost, true);
  const [quoted] = newPosts([tweet(2n, 'look', { retweeted_tweet: { id: '1' } })], 'elonmusk');
  assert.equal(quoted?.isRepost, true);
});

test('GetXAPI: one search for posts after the last ID, billed per call', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const source = new GetXApiSource({ apiKey: 'gx', fetch: fakeFetch({ tweets: [tweet(2n, 'new')] }, seen) });
  const { posts, cost } = await source.fetchNewPosts(trump, snowflakeAt(T, 1n));
  assert.equal(seen[0]?.headers.authorization, 'Bearer gx');
  const url = new URL(seen[0]?.url ?? '');
  assert.equal(url.pathname, '/twitter/tweet/advanced_search');
  assert.equal(url.searchParams.get('q'), `from:realDonaldTrump since_id:${snowflakeAt(T, 1n)} -filter:replies`);
  assert.equal(url.searchParams.get('product'), 'Latest');
  assert.deepEqual(posts.map((post) => post.text), ['new']);
  assert.deepEqual(cost, { calls: 1, items: 1, usd: 0.001 });
});

test('TwitterAPI.io: billed per post, an empty page as one', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const source = new TwitterApiIoSource({ apiKey: 'ta', fetch: fakeFetch({ tweets: [] }, seen) });
  const { posts, cost } = await source.fetchNewPosts(trump, snowflakeAt(T, 1n));
  assert.equal(seen[0]?.headers['X-API-Key'], 'ta');
  const url = new URL(seen[0]?.url ?? '');
  assert.equal(url.searchParams.get('query'), `from:realDonaldTrump since_id:${snowflakeAt(T, 1n)} -filter:replies`);
  assert.equal(url.searchParams.get('queryType'), 'Latest');
  assert.deepEqual(posts, []);
  assert.equal(cost.usd, 0.00015);

  const three = new TwitterApiIoSource({
    apiKey: 'ta',
    fetch: fakeFetch({ tweets: [tweet(2n, 'a'), tweet(3n, 'b'), tweet(4n, 'c')] }, []),
  });
  assert.equal((await three.fetchNewPosts(trump, snowflakeAt(T, 1n))).cost.usd.toFixed(5), '0.00045');
});

test('a provider error carries its status', async () => {
  const source = new GetXApiSource({ apiKey: 'gx', fetch: fakeFetch({ error: 'no credits' }, [], 402) });
  await assert.rejects(source.fetchNewPosts(trump), /GetXAPI answered 402/);
});
