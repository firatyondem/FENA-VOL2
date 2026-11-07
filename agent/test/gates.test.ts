import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeBps, checkPostAge, checkTrend, checkTweetToP0, risesAbove, risesAtLeast } from '../src/engine/gates.ts';
import type { PricePoint } from '../src/profiles.ts';

const at = (price: bigint, sourceTime: number, prevPublishTime?: number): PricePoint & { prevPublishTime?: number } => ({
  price,
  sourceTime,
  ...(prevPublishTime === undefined ? {} : { prevPublishTime }),
});

const rule = { trendThresholdBps: 300, spikeCapBps: 1200, minWaitSec: 120, maxWindowSec: 600 };
const p0 = at(2000n * 10n ** 18n, 1_000);

test('passes a rise between the threshold and the cap inside the window', () => {
  assert.deepEqual(checkTrend(p0, at(2070n * 10n ** 18n, 1_300), rule), { ok: true });
});

test('accepts exactly the threshold and exactly the cap', () => {
  assert.deepEqual(checkTrend(p0, at(2060n * 10n ** 18n, 1_300), rule), { ok: true });
  assert.deepEqual(checkTrend(p0, at(2240n * 10n ** 18n, 1_300), rule), { ok: true });
});

test('rejects one wei under the threshold and one wei over the cap', () => {
  assert.deepEqual(checkTrend(p0, at(2060n * 10n ** 18n - 1n, 1_300), rule), { ok: false, reason: 'below-threshold' });
  assert.deepEqual(checkTrend(p0, at(2240n * 10n ** 18n + 1n, 1_300), rule), { ok: false, reason: 'above-spike-cap' });
});

test('enforces both ends of the window, inclusive', () => {
  const rise = 2070n * 10n ** 18n;
  assert.deepEqual(checkTrend(p0, at(rise, 1_119), rule), { ok: false, reason: 'before-min-wait' });
  assert.deepEqual(checkTrend(p0, at(rise, 1_120), rule), { ok: true });
  assert.deepEqual(checkTrend(p0, at(rise, 1_600), rule), { ok: true });
  assert.deepEqual(checkTrend(p0, at(rise, 1_601), rule), { ok: false, reason: 'after-max-window' });
});

test('checks the window before the price, so a late pump reads as late', () => {
  assert.deepEqual(checkTrend(p0, at(3000n * 10n ** 18n, 5_000), rule), { ok: false, reason: 'after-max-window' });
});

test('pairs P0 only with a fresh post', () => {
  assert.deepEqual(checkTweetToP0(900, p0, 600), { ok: true });
  assert.deepEqual(checkTweetToP0(400, p0, 600), { ok: true });
  assert.deepEqual(checkTweetToP0(399, p0, 600), { ok: false, reason: 'tweet-too-old-for-p0' });
  assert.deepEqual(checkTweetToP0(1_001, p0, 600), { ok: false, reason: 'p0-before-tweet' });
});

test('compares in integers without rounding', () => {
  assert.ok(risesAtLeast(3n, 4n, 3333));
  assert.ok(!risesAtLeast(3n, 4n, 3334));
  assert.ok(risesAbove(100n, 106n, 500));
  assert.ok(!risesAbove(100n, 105n, 500));
  assert.equal(changeBps(2000n, 2070n), 350);
  assert.equal(changeBps(2000n, 1900n), -500);
});

test('P0 must be the first Pyth price after the post', () => {
  // The previous price came before the post: the first one after it
  assert.deepEqual(checkTweetToP0(1_000, at(1n, 1_002, 999), 600), { ok: true });
  // Another price came between the post and P0
  assert.deepEqual(checkTweetToP0(1_000, at(1n, 1_002, 1_001), 600), { ok: false, reason: 'p0-not-first' });
  assert.deepEqual(checkTweetToP0(1_000, at(1n, 1_000, 1_000), 600), { ok: false, reason: 'p0-not-first' });
});

test('a post is taken while it is at most the maximum age old, and never from the future', () => {
  assert.deepEqual(checkPostAge(1_000, 2_800, 1_800), { ok: true });
  assert.deepEqual(checkPostAge(1_000, 2_801, 1_800), { ok: false, reason: 'post-too-old' });
  assert.deepEqual(checkPostAge(1_001, 1_000, 1_800), { ok: false, reason: 'post-too-old' });
});
