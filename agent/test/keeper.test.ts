import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimVault } from '../src/chain/sim-vault.ts';
import type { PositionExits } from '../src/chain/vault.ts';
import { decideSell, SellKeeper, takeProfitTarget } from '../src/engine/keeper.ts';
import { EventLog } from '../src/log.ts';
import { snowflakeAt } from '../src/sources/posts.ts';
import { AGENT, makeRule, profiles, scriptedPrices, T, USER } from './helpers.ts';

const E = 10n ** 18n;
const exits: PositionExits = { takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 };
const position = { entryPrice: 100n * E, entryTime: 1_000 };

test('the take-profit target rounds up, as the vault does', () => {
  assert.equal(takeProfitTarget(100n * E, 800), 108n * E);
  assert.equal(takeProfitTarget(3n, 1), 4n);
});

test('decides like the vault: stop-loss, then take-profit, then stagnation', () => {
  assert.equal(decideSell(position, exits, 95n * E, 1_100), 'stop-loss', 'exactly at the line');
  assert.equal(decideSell(position, exits, 95n * E + 1n, 1_100), undefined, 'just above it');
  assert.equal(decideSell(position, exits, 108n * E, 1_100), 'take-profit');
  assert.equal(decideSell(position, exits, 100n * E, 1_599), undefined, 'before the stagnation delay');
  assert.equal(decideSell(position, exits, 101n * E, 1_600), 'stagnation');
  assert.equal(decideSell(position, exits, 50n * E, 999), undefined, 'a price from before the buy');
  assert.equal(decideSell(position, { ...exits, stopLossBps: 0 }, 1n, 1_100), undefined, 'stop-loss off');
  assert.equal(decideSell(position, exits, 90n * E, 1_100, ['take-profit']), undefined, 'not a sell this vault allows');
});

test('the keeper sells a falling position for stop-loss, by the exits it was bought with', async () => {
  const clock = { now: T + 60 };
  const vault = new SimVault({ profiles, rules: [makeRule()], deposits: { [USER]: 10_000n * 10n ** 6n }, caller: AGENT, now: () => clock.now });
  const prices = scriptedPrices(clock, {
    OIL: [
      [-60, '70.25'],
      [300, '71.4'],
      [400, '67'],
    ],
  });
  const { triggerId } = await vault.openTrigger({
    ruleId: USER,
    asset: 'OIL',
    account: 'realDonaldTrump',
    postId: snowflakeAt(T, 1n),
    p0: prices.updateAt('OIL', T),
  });
  clock.now = T + 300;
  await vault.confirmTrigger(triggerId, prices.updateAt('OIL', T + 300));
  const log = new EventLog();
  const keeper = new SellKeeper({ profiles, vault, prices, log, now: () => clock.now });

  await keeper.tick();
  assert.equal((await vault.listPositions())[0]?.open, true, '71.4 is no exit');
  // 67 is 6.2% below the 71.4 entry, past the 5% stop-loss
  clock.now = T + 400;
  await keeper.tick();
  assert.equal((await vault.listPositions())[0]?.open, false);
  const sold = log.recent().find((event) => event.kind === 'position.sold');
  assert.equal(sold?.kind === 'position.sold' && sold.sellKind, 'stop-loss');
  assert.equal(sold?.kind === 'position.sold' && sold.price, '67');
});
