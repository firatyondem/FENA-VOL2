import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RuleConfig, setRuleArgs } from '../src/chain/setup.ts';
import { replayRule, runTamperBench } from '../src/replay.ts';
import { EventLog } from '../src/log.ts';
import { loadProfiles } from '../src/profiles.ts';
import type { WatchedAccount } from '../src/sources/twitter.ts';
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

test('the example rule passes the checks setRule makes', () => {
  const rule = readSharedJson<RuleConfig>('../agent/config/rule.example.json');
  const watchlist = readSharedJson<WatchedAccount[]>('../agent/config/watchlist.json');
  assert.ok(rule.buyAmountUsdc > 0 && rule.buyAmountUsdc <= rule.maxPerTradeUsdc, 'buy amount within the per-trade limit');
  assert.equal(
    rule.assets.reduce((sum, asset) => sum + asset.budgetShareBps, 0),
    10_000
  );
  for (const asset of rule.assets) {
    const profile = profiles.assets[asset.asset];
    assert.ok(profile, asset.asset);
    assert.ok(asset.trendThresholdBps <= asset.spikeCapBps && asset.minWaitSec <= asset.maxWindowSec, asset.asset);
    // Not looser than what Deploy.s.sol registers: the profile threshold, cap and window, and the demo minimum wait
    assert.ok(asset.trendThresholdBps >= profile.trendThresholdBps, `${asset.asset} threshold`);
    assert.ok(asset.spikeCapBps <= profile.spikeCapBps, `${asset.asset} spike cap`);
    assert.ok(asset.minWaitSec >= (profiles.demoOverrides.minWaitSec ?? 0), `${asset.asset} wait`);
    assert.ok(asset.maxWindowSec <= profile.maxWindowSec, `${asset.asset} window`);
  }
  const [, assetIds, , topics, accounts] = setRuleArgs(rule, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', watchlist);
  assert.equal(assetIds.length, topics.length);
  assert.equal(accounts.length, rule.accounts.length);
});

test('the watchlist links each account to assets that have profiles', () => {
  const watchlist = readSharedJson<{ handle: string; assets: string[] }[]>('../agent/config/watchlist.json');
  assert.deepEqual(
    watchlist.map((account) => account.handle),
    ['realDonaldTrump', 'elonmusk', 'JDVance', 'marcorubio']
  );
  for (const account of watchlist) for (const asset of account.assets) assert.ok(profiles.assets[asset], asset);
});
