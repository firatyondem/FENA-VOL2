import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildReport,
  liveEvents,
  parseDuration,
  readEvents,
  renderMarkdown,
  renderSummary,
  selectRun,
  txLink,
} from '../scripts/run-report.ts';

// A replay, then a live session of about two hours with one restart, and a torn last line as after a hard kill
const events = readEvents(readFileSync(new URL('./fixtures/events.jsonl', import.meta.url), 'utf8'));
// 2026-10-31T14:00:00Z, one second after the last event
const NOW = 1_793_455_200_000;

test('durations read as milliseconds, and a bad one is refused', () => {
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('90m'), 5_400_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.throws(() => parseDuration('two hours'), /--since takes a duration/);
});

test('a torn last line is skipped, and only live runs count', () => {
  assert.equal(events.length, 26);
  const live = liveEvents(events);
  assert.equal(live.length, 24);
  assert.ok(!live.some((event) => event.kind === 'trigger.bought' && event.triggerId === '9'), 'the replay buy is left out');
});

test('by default the report covers the latest supervised session, restarts included; --since narrows it', () => {
  assert.equal(selectRun(events, { nowMs: NOW }).length, 24);
  const lastHour = selectRun(events, { nowMs: NOW, sinceMs: parseDuration('1h') });
  assert.equal(lastHour[0]?.kind, 'agent.started');
  assert.equal(lastHour.length, 9);
});

test('the report adds up the run: window, uptime, restarts, cycles and totals', () => {
  const report = buildReport(selectRun(events, { nowMs: NOW }));
  assert.equal(report.from, 1_793_448_000_000);
  assert.equal(report.to, 1_793_455_199_000);
  // 12:00:00 to 12:59:30, then 13:05:00 to 13:59:59: the five-minute gap is the restart
  assert.equal(report.uptimeMs, 3_570_000 + 3_299_000);
  assert.equal(report.restarts, 1);
  assert.equal(report.cyclesRun, 5);
  assert.equal(report.cyclesSkipped, 1);
  const { ausd, eth, ...counts } = report.totals;
  assert.equal(ausd, 30_000n);
  assert.equal(eth, 15_000_000_000_000n);
  assert.deepEqual(counts, {
    cycles: 5,
    polls: 2,
    posts: 1,
    triggers: 1,
    bought: 1,
    rejected: { TrendTooWeak: 1 },
    expired: 1,
    sold: 1,
    payments: 2,
    errors: 1,
  });
  assert.deepEqual(
    report.hours.map((hour) => [hour.hour, hour.cycles, hour.polls, hour.bought, hour.sold, hour.errors]),
    [
      ['2026-10-31T12:00', 3, 1, 0, 0, 1],
      ['2026-10-31T13:00', 2, 1, 1, 1, 0],
    ]
  );
  assert.equal(report.settings?.pollIntervalSec, 60);
  assert.deepEqual(report.recovered.map((restore) => restore.openTriggers), [[], ['1']]);
});

test('every agent transaction is listed with its gas, and modes and sources with their times', () => {
  const report = buildReport(selectRun(events, { nowMs: NOW }));
  assert.deepEqual(
    report.transactions.map((tx) => [tx.what, tx.asset, tx.gasEth]),
    [
      ['openTrigger #1 (post 2116371002815414273 @demo)', 'ETH', '0.000003'],
      ['confirmTrigger #1, bought position #1', 'ETH', '0.000004'],
      ['sell #1 (take-profit)', 'ETH', '0.000005'],
      ['expireTrigger #2', 'BTC', '0.000002'],
    ]
  );
  assert.deepEqual(
    report.modes.map((change) => change.mode),
    ['normal', 'saving']
  );
  assert.deepEqual(
    report.sources.map((source) => source.text),
    ['nodary degraded after 3 failures in a row, next try 12:41:00 UTC', 'nodary recovered']
  );
});

test('the markdown links each transaction to basescan and keeps the settings', () => {
  const markdown = renderMarkdown(buildReport(selectRun(events, { nowMs: NOW })));
  assert.match(markdown, /^# Run report/);
  assert.match(markdown, /- Uptime: 1 h 54 min, restarts: 1/);
  assert.ok(markdown.includes(`(${txLink(`0x${'aa'.repeat(32)}`)})`));
  assert.ok(markdown.includes('https://sepolia.basescan.org/tx/0xdddddddd'));
  assert.match(markdown, /\| 2026-10-31T12:00 \| 3 \| 1 \| 1 \| 1 \| 0 \| TrendTooWeak ×1 \| 0 \| 0 \| 0.01 \| 0 \| 1 \|/);
  assert.match(markdown, /\*\*saving\*\*: aUSD budget at 80% or more/);
  assert.match(markdown, /- rpcHost: base-sepolia.g.alchemy.com/);
  assert.match(markdown, /restart recovered 1 open trigger\(s\) \(#1\)/);
});

test('the summary fits a terminal, and an empty window says so', () => {
  const summary = renderSummary(buildReport(selectRun(events, { nowMs: NOW })));
  assert.deepEqual(summary.split('\n').length, 5);
  assert.match(summary, /^Run 2026-10-31 12:00:00 UTC → 2026-10-31 13:59:59 UTC: up 1 h 54 min, 1 restart\(s\)/);
  assert.match(summary, /4 agent transactions, 2 data payments; spent 0.03 aUSD and 0.000015 ETH/);
  const empty = buildReport(selectRun(events, { nowMs: NOW + 86_400_000, sinceMs: parseDuration('1h') }));
  assert.equal(renderSummary(empty), 'No live run in the log for this window.');
  assert.match(renderMarkdown(empty), /No live run in the log for this window/);
});
