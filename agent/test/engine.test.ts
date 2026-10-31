import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignedResponse } from '../src/airnode/attestation.ts';
import { SimVault } from '../src/chain/sim-vault.ts';
import type { Rule } from '../src/chain/vault.ts';
import type { Candidate, Classification, Classifier } from '../src/classifier/types.ts';
import { TriggerEngine } from '../src/engine/trigger-engine.ts';
import { EventLog, type LoggedEvent } from '../src/log.ts';
import { loadProfiles } from '../src/profiles.ts';
import type { WatchedAccount } from '../src/sources/twitter.ts';
import { DEMO_ETH_RULE, DEMO_OIL_RULE, FIXTURE_AIRNODE_KEY, P0_TIME } from '../scripts/fixture-set.ts';
import { readSharedJson } from './helpers.ts';

const profiles = loadProfiles();
const fixtureAirnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
const agentWallet = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const fixture = (file: string) => readSharedJson<SignedResponse>(`fixtures/synthetic/${file}`);
const trump: WatchedAccount = { handle: 'realDonaldTrump', label: 'Donald Trump', assets: ['OIL', 'BTC', 'ETH'], pinned: false };
const sell = { cooldownSec: 60, takeProfitBps: 800, stopLossBps: 500, stagnationBandBps: 100, stagnationAfterSec: 600 };

// Answers with fixed results, so the engine is tested without a model
class StubClassifier implements Classifier {
  readonly name = 'stub';
  calls = 0;
  // Calls that fail as an unreachable API would, before the answers come
  outages = 0;
  private readonly answers: Record<string, [boolean, number]>;

  constructor(answers: Record<string, [boolean, number]>) {
    this.answers = answers;
  }

  async classify(_post: unknown, candidates: Candidate[]): Promise<Classification[]> {
    this.calls += 1;
    if (this.outages > 0) {
      this.outages -= 1;
      throw new Error('503 overloaded');
    }
    return candidates
      .filter((candidate) => this.answers[candidate.asset])
      .map((candidate) => {
        const [relevant, confidence] = this.answers[candidate.asset] as [boolean, number];
        return { asset: candidate.asset, relevant, confidence, reason: 'stub' };
      });
  }
}

interface Scenario {
  post?: string;
  prices?: Record<string, string>;
  answers?: Record<string, [boolean, number]>;
  oilAirnode?: `0x${string}`;
}

const setup = ({
  post = 'tweet-trump-venezuela.json',
  prices = {},
  answers = { ETH: [true, 0.9] },
  oilAirnode = fixtureAirnode,
}: Scenario = {}) => {
  const clock = { now: P0_TIME + 60 };
  const state = {
    post,
    prices: { ETH: 'eth-p0.json', OIL: 'oil-p0.json', ...prices } as Record<string, string>,
    // Price fetches that fail as an unreachable Airnode would, per asset
    priceOutages: {} as Record<string, number>,
  };
  const rule: Rule = {
    id: 'r1',
    owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    agent: agentWallet,
    paused: false,
    accounts: { realDonaldTrump: ['OIL', 'ETH'] },
    assets: [
      { asset: 'OIL', budgetShareBps: 5000, ...DEMO_OIL_RULE, ...sell },
      { asset: 'ETH', budgetShareBps: 5000, ...DEMO_ETH_RULE, ...sell },
    ],
    topics: {},
    buyAmount: 500n * 10n ** 6n,
    maxPerTrade: 500n * 10n ** 6n,
    dailyLimit: 2_000n * 10n ** 6n,
  };
  const vault = new SimVault({
    profiles,
    rules: [rule],
    deposits: { r1: 10_000n * 10n ** 6n },
    caller: agentWallet,
    tweetAirnode: fixtureAirnode,
    priceAirnodes: { ETH: fixtureAirnode, OIL: oilAirnode },
    now: () => clock.now,
  });
  const log = new EventLog({ now: () => clock.now * 1000 });
  const classifier = new StubClassifier(answers);
  // A new engine on the same vault, log and sources: what the agent is after a restart
  const makeEngine = () => new TriggerEngine({
    profiles,
    vault,
    classifier,
    log,
    now: () => clock.now,
    tweetAirnode: fixtureAirnode,
    fetchLatestPost: async () => fixture(state.post),
    fetchPrice: async (asset) => {
      if ((state.priceOutages[asset] ?? 0) > 0) {
        state.priceOutages[asset] = (state.priceOutages[asset] ?? 0) - 1;
        throw new Error('fetch failed');
      }
      return fixture(state.prices[asset] as string);
    },
  });
  const engine = makeEngine();
  const kinds = () => log.recent().map((event) => event.kind);
  const last = <K extends LoggedEvent['kind']>(kind: K) =>
    log.recent().findLast((event) => event.kind === kind) as Extract<LoggedEvent, { kind: K }> | undefined;
  return { clock, state, vault, log, engine, classifier, kinds, last, rule, restart: makeEngine };
};

test('a relevant post opens a trigger, waits for the window and buys at P1', async () => {
  const { clock, state, vault, engine, kinds, last } = setup();
  await engine.pollAccount(trump);
  assert.deepEqual(kinds(), ['post.seen', 'post.classified', 'trigger.opened']);
  const opened = last('trigger.opened');
  assert.equal(opened?.asset, 'ETH');
  assert.equal(opened?.p0, '2000');
  assert.equal(opened?.opensAt, P0_TIME + 120);
  assert.equal(opened?.closesAt, P0_TIME + 600);

  clock.now = P0_TIME + 100;
  await engine.checkPending();
  assert.equal(kinds().length, 3, 'nothing happens before the minimum wait');

  clock.now = P0_TIME + 320;
  state.prices.ETH = 'eth-p1-rise.json';
  await engine.checkPending();
  assert.deepEqual(kinds().slice(3), ['trigger.checked', 'trigger.bought']);
  assert.equal(last('trigger.checked')?.changeBps, 350);
  assert.equal(last('trigger.bought')?.usdcIn, '500');
  assert.equal(last('trigger.bought')?.price, '2070');
  assert.equal(engine.pendingTriggers().length, 0);
  assert.equal((await vault.listPositions()).length, 1);
});

test('a post is classified once, however often it is polled', async () => {
  const { engine, classifier, kinds } = setup();
  await engine.pollAccount(trump);
  await engine.pollAccount(trump);
  assert.equal(classifier.calls, 1);
  assert.equal(kinds().filter((kind) => kind === 'post.seen').length, 1);
});

test('a post about several assets opens a trigger for each, in the rule priority order', async () => {
  // ETH scores higher, but the user put oil first
  const { engine, log } = setup({ answers: { OIL: [true, 0.8], ETH: [true, 0.95] } });
  await engine.pollAccount(trump);
  const triggerEvents = log.recent().filter((event) => event.kind.startsWith('trigger.'));
  assert.deepEqual(
    triggerEvents.map((event) => [event.kind, 'asset' in event ? event.asset : '']),
    [
      ['trigger.opened', 'OIL'],
      ['trigger.opened', 'ETH'],
    ]
  );
});

test('an asset the vault refuses does not stop the next one', async () => {
  // The vault expects oil prices from another Airnode, so the fixture's oil P0 is refused
  const { engine, log } = setup({
    answers: { OIL: [true, 0.8], ETH: [true, 0.95] },
    oilAirnode: '0x9aAD9AF9D2d0B9429F6e1C18FA733F41926BC678',
  });
  await engine.pollAccount(trump);
  const triggerEvents = log.recent().filter((event) => event.kind.startsWith('trigger.'));
  assert.deepEqual(
    triggerEvents.map((event) => [event.kind, 'asset' in event ? event.asset : '']),
    [
      ['trigger.rejected', 'OIL'],
      ['trigger.opened', 'ETH'],
    ]
  );
  assert.equal((triggerEvents[0] as { reason: string }).reason, 'NotSignedByAirnode');
});

test('a low-confidence answer opens nothing', async () => {
  const { engine, kinds } = setup({ answers: { ETH: [true, 0.4] } });
  await engine.pollAccount(trump);
  assert.deepEqual(kinds(), ['post.seen', 'post.classified']);
});

test('an old post is skipped before the model runs', async () => {
  const { engine, classifier, last } = setup({ post: 'tweet-trump-old.json' });
  await engine.pollAccount(trump);
  assert.equal(classifier.calls, 0);
  assert.equal(last('post.skipped')?.reason, 'older than the P0 window');
});

test('a tampered post response is dropped before it reaches the vault', async () => {
  const { engine, classifier, kinds } = setup({ post: 'tamper-wrong-signer.json' });
  await engine.pollAccount(trump);
  assert.equal(classifier.calls, 0);
  assert.deepEqual(kinds(), ['error']);
});

test('a flat price keeps the trigger waiting, then it expires', async () => {
  const { clock, state, engine, last } = setup({ prices: {} });
  await engine.pollAccount(trump);
  clock.now = P0_TIME + 320;
  state.prices.ETH = 'eth-p1-flat.json';
  await engine.checkPending();
  assert.equal(last('trigger.checked')?.verdict, 'the price did not rise enough');
  assert.equal(engine.pendingTriggers().length, 1);

  clock.now = P0_TIME + 601;
  await engine.checkPending();
  assert.equal(last('trigger.expired')?.asset, 'ETH');
  assert.equal(engine.pendingTriggers().length, 0);
});

test('each transaction event carries its hash and the gas it cost the agent', async () => {
  const { clock, state, vault, engine, last } = setup({ prices: {} });
  // The SimVault sends nothing; stand in for a chain that reports each transaction's hash and gas
  const open = vault.openTrigger.bind(vault);
  vault.openTrigger = async (input) => ({ ...(await open(input)), txHash: '0x01', gasWei: 300_000_000_000_000n });
  const expire = vault.expireTrigger.bind(vault);
  vault.expireTrigger = async (triggerId) => {
    await expire(triggerId);
    return { txHash: '0x02', gasWei: 50_000_000_000_000n };
  };
  await engine.pollAccount(trump);
  assert.equal(last('trigger.opened')?.txHash, '0x01');
  assert.equal(last('trigger.opened')?.gasEth, '0.0003');

  clock.now = P0_TIME + 601;
  state.prices.ETH = 'eth-p1-flat.json';
  await engine.checkPending();
  assert.equal(last('trigger.expired')?.txHash, '0x02');
  assert.equal(last('trigger.expired')?.gasEth, '0.00005');
});

test('after a restart the open trigger is recovered from the vault and still buys', async () => {
  const { clock, state, vault, engine, last, restart } = setup();
  await engine.pollAccount(trump);
  const triggerId = last('trigger.opened')?.triggerId as string;

  // The process dies: a new engine knows nothing until it reads the vault
  const restarted = restart();
  assert.equal(restarted.pendingTriggers().length, 0);
  assert.deepEqual(restarted.restorePending(await vault.listOpenTriggers(), await vault.listRules()), [triggerId]);
  assert.deepEqual(last('agent.recovered')?.openTriggers, [triggerId]);
  const [pending] = restarted.pendingTriggers();
  assert.equal(pending?.p0.price, 2000n * 10n ** 18n);
  assert.equal(pending?.asset, 'ETH');

  clock.now = P0_TIME + 320;
  state.prices.ETH = 'eth-p1-rise.json';
  await restarted.checkPending();
  assert.equal(last('trigger.bought')?.triggerId, triggerId);
  assert.equal(restarted.pendingTriggers().length, 0);
  // Restoring again finds nothing open
  assert.deepEqual(restarted.restorePending(await vault.listOpenTriggers(), await vault.listRules()), []);
});

test('a trigger recovered after its window closed expires in the first cycle', async () => {
  const { clock, vault, engine, last, restart } = setup();
  await engine.pollAccount(trump);
  const triggerId = last('trigger.opened')?.triggerId as string;
  clock.now = P0_TIME + 700;
  const restarted = restart();
  restarted.restorePending(await vault.listOpenTriggers(), await vault.listRules());
  await restarted.checkPending();
  assert.equal(last('trigger.expired')?.triggerId, triggerId);
  assert.equal((await vault.listOpenTriggers()).length, 0);
});

test('a recovered trigger whose asset left the rule gets no window, so Gate 2 expires it at once', async () => {
  const { vault, engine, last, restart, rule } = setup();
  await engine.pollAccount(trump);
  const triggerId = last('trigger.opened')?.triggerId as string;
  const restarted = restart();
  const withoutEth = { ...rule, assets: rule.assets.filter((asset) => asset.asset !== 'ETH') };
  restarted.restorePending(await vault.listOpenTriggers(), [withoutEth]);
  assert.equal(restarted.pendingTriggers()[0]?.params.maxWindowSec, 0);
  // Well inside the old window, the first Gate 2 pass already tries to expire it, as the vault would allow
  const expiries: string[] = [];
  vault.expireTrigger = async (id) => void expiries.push(id);
  await restarted.checkPending();
  assert.deepEqual(expiries, [triggerId]);
  assert.equal(restarted.pendingTriggers().length, 0);
});

test('a spike above the cap is never submitted', async () => {
  const { clock, state, engine, vault, kinds } = setup();
  await engine.pollAccount(trump);
  clock.now = P0_TIME + 320;
  state.prices.ETH = 'eth-p1-spike.json';
  await engine.checkPending();
  clock.now = P0_TIME + 400;
  state.prices.ETH = 'eth-p1-rise.json';
  await engine.checkPending();
  assert.ok(!kinds().includes('trigger.bought'));
  assert.equal(vault.balanceOf('r1'), 10_000n * 10n ** 6n);
});

test('P1 is fetched at most once per interval', async () => {
  const { clock, state, engine, kinds } = setup();
  await engine.pollAccount(trump);
  state.prices.ETH = 'eth-p1-flat.json';
  clock.now = P0_TIME + 320;
  await engine.checkPending();
  clock.now = P0_TIME + 330;
  await engine.checkPending();
  assert.equal(kinds().filter((kind) => kind === 'trigger.checked').length, 1);
});

test('a classifier outage is retried on the next poll, so the post is not lost', async () => {
  const { engine, classifier, kinds } = setup();
  classifier.outages = 1;
  await engine.pollAccount(trump);
  assert.deepEqual(kinds(), ['post.seen', 'error']);
  await engine.pollAccount(trump);
  assert.deepEqual(kinds(), ['post.seen', 'error', 'post.classified', 'trigger.opened']);
  assert.equal(classifier.calls, 2);
});

test('a failed P0 fetch is retried without reopening the assets that opened', async () => {
  const { engine, classifier, state, log } = setup({ answers: { OIL: [true, 0.8], ETH: [true, 0.95] } });
  state.priceOutages.OIL = 1;
  await engine.pollAccount(trump);
  await engine.pollAccount(trump);
  await engine.pollAccount(trump);
  const triggerEvents = log.recent().filter((event) => event.kind.startsWith('trigger.'));
  assert.deepEqual(
    triggerEvents.map((event) => [event.kind, 'asset' in event ? event.asset : '']),
    [
      ['trigger.opened', 'ETH'],
      ['trigger.opened', 'OIL'],
    ]
  );
  assert.equal(classifier.calls, 1, 'the answer is kept, not asked again');
});

test('a refusal by the vault is final, not retried', async () => {
  const { engine, classifier, log } = setup({
    answers: { OIL: [true, 0.8] },
    oilAirnode: '0x9aAD9AF9D2d0B9429F6e1C18FA733F41926BC678',
  });
  await engine.pollAccount(trump);
  const before = log.recent().length;
  await engine.pollAccount(trump);
  assert.equal(log.recent().length, before);
  assert.equal(classifier.calls, 1);
});
