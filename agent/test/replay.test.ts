import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayRule, runTamperBench } from '../src/replay.ts';
import { EventLog } from '../src/log.ts';
import { loadProfiles } from '../src/profiles.ts';
import { readSharedJson } from './helpers.ts';

const profiles = loadProfiles();

test('the tamper bench shows the four rejections the spec asks for', async () => {
  const log = new EventLog();
  await runTamperBench(profiles, log);
  const results = log.recent().map((event) => (event.kind === 'tamper.result' ? [event.name, event.actual, event.passed] : []));
  assert.deepEqual(results, [
    ['Edited value', 'NotSignedByAirnode', true],
    ['Stale response', 'ResponseTooOld', true],
    ['Different request', 'WrongRequestHash', true],
    ['Wrong signer', 'NotSignedByAirnode', true],
  ]);
});

test('the replay rule splits the daily budget across its assets in priority order', () => {
  const rule = replayRule(profiles, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  assert.deepEqual(
    rule.assets.map((asset) => asset.asset),
    ['OIL', 'ETH', 'DOGE']
  );
  assert.equal(
    rule.assets.reduce((sum, asset) => sum + asset.budgetShareBps, 0),
    10_000
  );
  assert.ok(rule.assets.every((asset) => asset.minWaitSec === 120 && asset.maxWindowSec === 600), 'demo windows');
});

test('the example rule file lists only assets with a profile and a full budget split', () => {
  const [rule] = readSharedJson<{ assets: { asset: string; budgetShareBps: number }[] }[]>('../agent/config/rules.example.json');
  assert.ok(rule);
  for (const { asset } of rule.assets) assert.ok(profiles.assets[asset], asset);
  assert.equal(
    rule.assets.reduce((sum, asset) => sum + asset.budgetShareBps, 0),
    10_000
  );
});

test('the watchlist links each account to assets that have profiles', () => {
  const watchlist = readSharedJson<{ handle: string; assets: string[] }[]>('../agent/config/watchlist.json');
  assert.deepEqual(
    watchlist.map((account) => account.handle),
    ['realDonaldTrump', 'elonmusk', 'JDVance', 'marcorubio']
  );
  for (const account of watchlist) for (const asset of account.assets) assert.ok(profiles.assets[asset], asset);
});
