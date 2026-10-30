import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { deriveRequestHash, type SignedResponse } from '../src/airnode/attestation.ts';
import { latestTweetRequest, parseXDate, readSignedPost, snowflakeAt, snowflakeTime } from '../src/sources/twitter.ts';

const unsigned = (data: string): SignedResponse => ({
  airnode: '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB',
  requestHash: '0x00',
  timestamp: '1793381073',
  data,
  signature: '0x00',
});

test('reads the newest tweet, or the one after a pinned tweet', () => {
  assert.equal(latestTweetRequest({ handle: 'elonmusk', pinned: false }).responseProjection?.id, '/data/tweets/0/id');
  assert.equal(latestTweetRequest({ handle: 'elonmusk', pinned: true }).responseProjection?.id, '/data/tweets/1/id');
});

test('hashes the tweet request as the Airnode does', () => {
  const expected = keccak256(
    toHex(
      '["userLastTweets",[["userName","realDonaldTrump"]],[["author","/data/tweets/0/author/userName"],["createdAt","/data/tweets/0/createdAt"],["id","/data/tweets/0/id"],["text","/data/tweets/0/text"]]]'
    )
  );
  assert.equal(deriveRequestHash(latestTweetRequest({ handle: 'realDonaldTrump', pinned: false })), expected);
});

test('parses the X date format, offsets included', () => {
  assert.equal(parseXDate('Tue Dec 10 07:00:30 +0000 2024'), Date.UTC(2024, 11, 10, 7, 0, 30) / 1000);
  assert.equal(parseXDate('Fri Oct 30 18:00:00 +0100 2026'), Date.UTC(2026, 9, 30, 17, 0, 0) / 1000);
  assert.equal(parseXDate('Fri Oct 30 12:30:00 -0530 2026'), Date.UTC(2026, 9, 30, 18, 0, 0) / 1000);
  assert.throws(() => parseXDate('2024-12-10T07:00:30Z'), /not an X date/);
  assert.throws(() => parseXDate('Tue Foo 10 07:00:30 +0000 2024'), /not an X date|unknown month/);
});

test('reads a signed post', () => {
  const post = readSignedPost(
    unsigned(
      '{"author":"realDonaldTrump","createdAt":"Fri Oct 30 17:20:00 +0000 2026","id":"1983000000000000001","text":"We are coming for Venezuela!"}'
    )
  );
  assert.equal(post.id, '1983000000000000001');
  assert.equal(post.author, 'realDonaldTrump');
  assert.equal(post.createdAt, Date.UTC(2026, 9, 30, 17, 20, 0) / 1000);
  assert.equal(post.isRepost, false);
});

test('marks a repost', () => {
  const post = readSignedPost(
    unsigned('{"author":"elonmusk","createdAt":"Fri Oct 30 17:20:00 +0000 2026","id":"1","text":"RT @dogeofficial: much wow"}')
  );
  assert.equal(post.isRepost, true);
});

test('reads the creation time from an X id', () => {
  // The Snowflake epoch itself, and one millisecond-tick after 2^22 ids
  assert.equal(snowflakeTime('0'), 1288834974);
  assert.equal(snowflakeTime((1000n << 22n).toString()), 1288834975);
  // An id from October 2024 lands in October 2024
  const seconds = snowflakeTime('1846987139428634858');
  assert.equal(new Date(seconds * 1000).toISOString().slice(0, 7), '2024-10');
  assert.throws(() => snowflakeTime('12ab'), /not a numeric X id/);
});

test('builds ids whose time round-trips', () => {
  const seconds = Date.UTC(2026, 9, 30, 17, 20, 0) / 1000;
  assert.equal(snowflakeTime(snowflakeAt(seconds, 7n)), seconds);
});
