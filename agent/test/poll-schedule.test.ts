import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollsPerDay, pollUsdPerDay } from '../scripts/wallets.ts';
import { DEFAULT_POLL_SCHEDULE, inMarketHours, isPollDue, pollIntervalSec, readPollSchedule } from '../src/engine/poll-schedule.ts';

const s = DEFAULT_POLL_SCHEDULE;
// Friday 2026-11-06, 10:00 in New York (EST, UTC-5)
const MARKET = Date.UTC(2026, 10, 6, 15, 0);
// The same Friday, 23:00 in New York
const NIGHT = Date.UTC(2026, 10, 7, 4, 0);
// Saturday noon in New York
const WEEKEND = Date.UTC(2026, 10, 7, 17, 0);

test('market hours are weekdays 09:30 to 16:00 in New York', () => {
  assert.equal(inMarketHours(MARKET, s), true);
  assert.equal(inMarketHours(NIGHT, s), false);
  assert.equal(inMarketHours(WEEKEND, s), false);
  assert.equal(inMarketHours(Date.UTC(2026, 10, 6, 14, 29), s), false, '09:29');
  assert.equal(inMarketHours(Date.UTC(2026, 10, 6, 14, 30), s), true, '09:30');
  assert.equal(inMarketHours(Date.UTC(2026, 10, 6, 21, 0), s), false, '16:00');
});

test('polls often in market hours and right after a post, rarely at night and after a long silence', () => {
  assert.equal(pollIntervalSec(s, MARKET, {}), 60);
  assert.equal(pollIntervalSec(s, NIGHT, { lastPostAt: NIGHT / 1000 - 600 }), 60, 'ten minutes after a post');
  assert.equal(pollIntervalSec(s, NIGHT, { lastPostAt: NIGHT / 1000 - 3600 }), 600, 'an hour after a post');
  assert.equal(pollIntervalSec(s, NIGHT, { lastPostAt: NIGHT / 1000 - 7 * 3600 }), 900, 'a long silence');
  assert.equal(pollIntervalSec(s, WEEKEND, {}), 900, 'never posted');
});

test('an account is due when its interval has passed since its last poll', () => {
  assert.equal(isPollDue(s, MARKET, {}), true, 'never polled');
  assert.equal(isPollDue(s, MARKET, { lastPollAt: MARKET - 59_000 }), false);
  assert.equal(isPollDue(s, MARKET, { lastPollAt: MARKET - 60_000 }), true);
  assert.equal(isPollDue(s, NIGHT, { lastPollAt: NIGHT - 300_000 }), false);
});

test('the schedule is configurable', () => {
  const custom = readPollSchedule({ POLL_ACTIVE_SEC: '30', POLL_IDLE_SEC: '1800', POLL_MARKET_HOURS: '04:00-20:00' });
  assert.equal(custom.activeSec, 30);
  assert.equal(custom.idleSec, 1800);
  assert.equal(inMarketHours(Date.UTC(2026, 10, 6, 10, 0), custom), true, '05:00 in New York');
});

test('a quiet account costs well under a dollar a day to watch', () => {
  // 5 weekdays x 6.5 h at one a minute, the rest every 15 minutes, averaged over the week
  assert.equal(Math.round(pollsPerDay(s)), 356);
  assert.ok(pollUsdPerDay('getxapi', 1, s) < 0.4);
  assert.ok(pollUsdPerDay('twitterapi.io', 1, s) < 0.06);
});
