// The agent's copy of the vault's Gate 1 timing checks and Gate 2 trend check. The vault decides; the agent runs the
// same arithmetic first so it only spends gas on a submission the vault can accept, and can explain each outcome.
import type { PricePoint } from '../profiles.ts';

export interface TrendRule {
  trendThresholdBps: number;
  spikeCapBps: number;
  minWaitSec: number;
  maxWindowSec: number;
}

export type GateFailure =
  | 'post-too-old'
  | 'tweet-too-old-for-p0'
  | 'p0-before-tweet'
  | 'p0-not-first'
  | 'before-min-wait'
  | 'after-max-window'
  | 'below-threshold'
  | 'above-spike-cap';

export type GateResult = { ok: true } | { ok: false; reason: GateFailure };

const pass: GateResult = { ok: true };
const fail = (reason: GateFailure): GateResult => ({ ok: false, reason });

// Gate 1: posts are not signed, so the vault takes a post only while it is at most `maxPostAgeSec` old.
export const checkPostAge = (tweetCreatedAt: number, nowSec: number, maxPostAgeSec: number): GateResult =>
  tweetCreatedAt > nowSec || nowSec - tweetCreatedAt > maxPostAgeSec ? fail('post-too-old') : pass;

// Gate 1: P0 must be the first Pyth price published at or after the post, at most `maxTweetToP0Sec` after it, so an
// old post cannot be paired with a new price and the agent cannot pick a favourable one.
export const checkTweetToP0 = (
  tweetCreatedAt: number,
  p0: PricePoint & { prevPublishTime?: number },
  maxTweetToP0Sec: number
): GateResult => {
  if (p0.sourceTime < tweetCreatedAt) return fail('p0-before-tweet');
  if (p0.sourceTime - tweetCreatedAt > maxTweetToP0Sec) return fail('tweet-too-old-for-p0');
  if (p0.prevPublishTime !== undefined && p0.prevPublishTime >= tweetCreatedAt) return fail('p0-not-first');
  return pass;
};

// P1 >= P0 * (1 + threshold) without overflow or rounding: compare P1 * 10000 with P0 * (10000 + bps).
export const risesAtLeast = (p0: bigint, p1: bigint, bps: number) => p1 * 10_000n >= p0 * BigInt(10_000 + bps);
export const risesAbove = (p0: bigint, p1: bigint, bps: number) => p1 * 10_000n > p0 * BigInt(10_000 + bps);

export const changeBps = (p0: bigint, p1: bigint) => Number(((p1 - p0) * 10_000n) / p0);

// Gate 2: minimum wait <= t1 - t0 <= maximum window, P1 >= P0 * (1 + threshold) and P1 <= P0 * (1 + spike cap).
export const checkTrend = (p0: PricePoint, p1: PricePoint, rule: TrendRule): GateResult => {
  const elapsed = p1.sourceTime - p0.sourceTime;
  if (elapsed < rule.minWaitSec) return fail('before-min-wait');
  if (elapsed > rule.maxWindowSec) return fail('after-max-window');
  if (risesAbove(p0.price, p1.price, rule.spikeCapBps)) return fail('above-spike-cap');
  if (!risesAtLeast(p0.price, p1.price, rule.trendThresholdBps)) return fail('below-threshold');
  return pass;
};

export const describeGateFailure: Record<GateFailure, string> = {
  'post-too-old': 'the post is too old for the vault to take',
  'p0-not-first': 'P0 is not the first Pyth price after the post',
  'tweet-too-old-for-p0': 'P0 came too long after the post, so an old post cannot ride a new price',
  'p0-before-tweet': 'P0 predates the post',
  'before-min-wait': 'P1 came before the minimum wait',
  'after-max-window': 'the window closed before the trend confirmed',
  'below-threshold': 'the price did not rise enough',
  'above-spike-cap': 'the rise is above the spike cap, a possible trap or bad data',
};

// Vault.sol's error for each failed gate, so the agent's own refusals read like the vault's
export const GATE_ERRORS: Record<GateFailure, string> = {
  'post-too-old': 'PostOutsideWindow',
  'tweet-too-old-for-p0': 'PriceOutsideTweetWindow',
  'p0-before-tweet': 'PriceOutsideTweetWindow',
  'p0-not-first': 'PriceNotFirstAfterPost',
  'before-min-wait': 'WaitNotOver',
  'after-max-window': 'WindowClosed',
  'below-threshold': 'TrendTooWeak',
  'above-spike-cap': 'SpikeTooHigh',
};
