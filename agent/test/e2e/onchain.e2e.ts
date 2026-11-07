// End to end on a local chain: Deploy.s.sol puts the mocks, LocalPyth and the Vault on anvil, a user sets a rule naming
// the agent, and the agent's own engine, keeper and ViemVault drive real transactions through every gate, paying Pyth's
// fee each time. Prices are LocalPyth updates at chain time; real Pyth signatures are tested in
// contracts/test/fork/PythFork.t.sol. Needs anvil and forge on PATH: `npm run test:e2e`.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Address, createPublicClient, createTestClient, createWalletClient, type Hex, http, parseUnits, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { applyRule, type RuleConfig } from '../../src/chain/setup.ts';
import { vaultAbi } from '../../src/chain/vault-abi.ts';
import { VaultRejection } from '../../src/chain/vault.ts';
import { checkPrice, ViemVault } from '../../src/chain/viem-vault.ts';
import type { Candidate, Classification, Classifier } from '../../src/classifier/types.ts';
import { SellKeeper } from '../../src/engine/keeper.ts';
import { TriggerEngine } from '../../src/engine/trigger-engine.ts';
import { EventLog, type LoggedEvent } from '../../src/log.ts';
import { loadProfiles } from '../../src/profiles.ts';
import type { PriceUpdate } from '../../src/pyth/hermes.ts';
import type { PriceSource } from '../../src/pyth/price-source.ts';
import { isNewer, type Post, type PostSource, snowflakeAt, type WatchedAccount } from '../../src/sources/posts.ts';
import { ANVIL_KEYS, advanceChain, chainTime, localPriceUpdate } from '../../scripts/local-chain.ts';

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const DEPLOYMENT = new URL('../../../shared/deployments/e2e-31337.json', import.meta.url);
const KEYS = { deployer: ANVIL_KEYS.deployer, user: ANVIL_KEYS.one, agent: ANVIL_KEYS.two, keeper: ANVIL_KEYS.three };

const hasTool = (name: string) => spawnSync(name, ['--version'], { stdio: 'ignore', shell: false }).status === 0;
const toolsMissing = !hasTool('anvil') || !hasTool('forge');

const profiles = loadProfiles();
const trump: WatchedAccount = { handle: 'realDonaldTrump', label: 'Donald Trump', assets: ['OIL', 'BTC', 'ETH'] };
const usdc = (amount: number) => parseUnits(String(amount), 6);

class StubClassifier implements Classifier {
  readonly name = 'stub';
  async classify(_post: unknown, candidates: Candidate[]): Promise<Classification[]> {
    return candidates.map((candidate) => ({ asset: candidate.asset, relevant: true, confidence: 0.9, reason: 'stub' }));
  }
}

let anvil: ChildProcess | undefined;
let publicClient: PublicClient;
let deployment: { vault: Address; usdc: Address; deployedAtBlock: number; localPyth: boolean };
const clock = { now: 0 };
const usd: Record<string, string> = { OIL: '70.25', ETH: '2000', BTC: '77000' };

const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport: http(RPC) });
const wallet = (key: Hex) => createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(key) });
const advance = async (seconds: number) => {
  clock.now = await advanceChain(testClient, publicClient, seconds);
};

// LocalPyth updates at chain time: the latest one now, and the first one at a post's second
const prices: PriceSource = {
  latest: async (asset) => localPriceUpdate(profiles, asset, usd[asset] as string, clock.now),
  firstAt: async (asset, time) => localPriceUpdate(profiles, asset, usd[asset] as string, time),
};
const at = (asset: string, price: string, time: number): PriceUpdate => localPriceUpdate(profiles, asset, price, time);

const agentVault = () =>
  new ViemVault({
    address: deployment.vault,
    publicClient,
    walletClient: wallet(KEYS.agent),
    profiles,
    watchlist: [trump],
    fromBlock: BigInt(deployment.deployedAtBlock),
  });

const readVault = <Name extends 'balanceOf' | 'getTrigger' | 'getPosition'>(functionName: Name, arg: bigint | Address) =>
  publicClient.readContract({ address: deployment.vault, abi: vaultAbi, functionName, args: [arg] } as never) as Promise<
    Name extends 'balanceOf' ? bigint : Name extends 'getTrigger' ? { status: number } : { isOpen: boolean; amount: bigint }
  >;

before(async () => {
  if (toolsMissing) return;
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  publicClient = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
  for (let attempt = 0; ; attempt++) {
    try {
      await publicClient.getChainId();
      break;
    } catch (error) {
      if (attempt > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const { PYTH: _pyth, ...env } = process.env;
  const deploy = spawnSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC, '--broadcast'], {
    cwd: CONTRACTS,
    encoding: 'utf8',
    env: { ...env, PRIVATE_KEY: KEYS.deployer, DEPLOYMENT_FILE: '../shared/deployments/e2e-31337.json' },
  });
  assert.equal(deploy.status, 0, deploy.stdout + deploy.stderr);
  deployment = JSON.parse(readFileSync(DEPLOYMENT, 'utf8'));
  assert.equal(deployment.localPyth, true, 'a plain anvil chain gets LocalPyth');

  const config = JSON.parse(readFileSync(new URL('../../config/rule.example.json', import.meta.url), 'utf8')) as RuleConfig;
  await applyRule({
    publicClient,
    walletClient: wallet(KEYS.user),
    vault: deployment.vault,
    usdc: deployment.usdc,
    agent: privateKeyToAccount(KEYS.agent).address,
    config: { ...config, accounts: ['realDonaldTrump'], assets: config.assets.filter((asset) => asset.asset !== 'DOGE') },
    watchlist: [trump],
  });
  // The agent pays Pyth's fee; LocalPyth's is 0, so a little ETH for gas is all it needs
  clock.now = await chainTime(publicClient);
});

after(() => {
  anvil?.kill();
});

const user = privateKeyToAccount(KEYS.user).address;
const log = new EventLog({ now: () => clock.now * 1000 });
const kinds = () => log.recent().map((event) => event.kind);
const last = <K extends LoggedEvent['kind']>(kind: K) =>
  log.recent().findLast((event) => event.kind === kind) as Extract<LoggedEvent, { kind: K }> | undefined;

const posts: Post[] = [];
const postSource: PostSource = {
  name: 'e2e',
  fetchNewPosts: async (account, sinceId) => ({
    posts: posts.filter((post) => post.author === account.handle && isNewer(post.id, sinceId)),
    cost: { calls: 1, items: 0, usd: 0 },
  }),
};

const vault = { current: undefined as ViemVault | undefined };
const engine = { current: undefined as TriggerEngine | undefined };
let postTime = 0;

test('the agent finds the rule that names it, with its accounts, topics and stop-loss', { skip: toolsMissing }, async () => {
  vault.current = agentVault();
  const [rule] = await vault.current.listRules();
  assert.ok(rule);
  assert.equal(rule.id, user);
  assert.equal(rule.buyAmount, usdc(500));
  assert.deepEqual(rule.accounts, { realDonaldTrump: ['OIL', 'ETH'] });
  assert.deepEqual(rule.assets.map((asset) => [asset.asset, asset.stopLossBps]), [
    ['OIL', 500],
    ['ETH', 500],
  ]);
  assert.ok(rule.topics.OIL?.includes('Venezuela'));
  assert.equal(await readVault('balanceOf', user), usdc(10_000));
});

test('Gate 1: a relevant post and the first price after it open an on-chain trigger per asset', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  postTime = clock.now - 30;
  posts.push({
    id: snowflakeAt(postTime, 1n),
    author: 'realDonaldTrump',
    text: 'We are coming for Venezuela. Big things are happening!',
    createdAt: postTime,
    isRepost: false,
  });
  engine.current = new TriggerEngine({
    profiles,
    vault: vault.current,
    classifier: new StubClassifier(),
    posts: postSource,
    prices,
    log,
    now: () => clock.now,
  });
  await engine.current.pollAccount(trump);
  const opened = log.recent().filter((event) => event.kind === 'trigger.opened');
  assert.deepEqual(
    opened.map((event) => (event.kind === 'trigger.opened' ? [event.triggerId, event.asset, event.t0] : [])),
    [
      ['1', 'OIL', postTime],
      ['2', 'ETH', postTime],
    ],
    JSON.stringify(log.recent())
  );
  assert.equal((await readVault('getTrigger', 1n)).status, 1, 'open');
  assert.ok(opened.every((event) => event.kind === 'trigger.opened' && event.txHash));
});

test('the tamper cases revert on the real vault, each with its name', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  await advance(130);
  const fresh = at('ETH', '2070', clock.now);
  const edited: PriceUpdate = { updates: [fresh.updates[0]?.slice(0, -2) as Hex], prices: [] };
  const cases: [string, PriceUpdate, string][] = [
    ['edited price', edited, 'InvalidPriceUpdate'],
    ['old price', at('ETH', '2070', clock.now - 400), 'PriceTooOld'],
    ['wrong asset', at('BTC', '80000', clock.now), 'WrongPriceFeed'],
  ];
  for (const [name, update, reason] of cases) {
    await assert.rejects(
      vault.current.confirmTrigger('2', update),
      (error) => error instanceof VaultRejection && error.reason === reason,
      name
    );
    await assert.rejects(
      checkPrice(publicClient, deployment.vault, 'ETH', update),
      (error) => error instanceof VaultRejection && error.reason === reason,
      `${name} through checkPrice`
    );
  }
  // A replayed P0: a second post in the same second would take the same first price, but it is used
  await assert.rejects(
    vault.current.openTrigger({
      ruleId: user,
      asset: 'ETH',
      account: 'realDonaldTrump',
      postId: snowflakeAt(postTime, 2n),
      p0: at('ETH', '2000', postTime),
    }),
    { reason: 'PriceAlreadyUsed' }
  );
  const { price } = await checkPrice(publicClient, deployment.vault, 'ETH', fresh);
  assert.equal(price, parseUnits('2070', 18));
  assert.equal(await readVault('balanceOf', user), usdc(10_000), 'no funds moved');
});

test('Gate 2 refuses a weak trend and a spike on-chain', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  await assert.rejects(vault.current.confirmTrigger('2', at('ETH', '2004', clock.now)), { reason: 'TrendTooWeak' });
  await assert.rejects(vault.current.confirmTrigger('2', at('ETH', '2300', clock.now)), { reason: 'SpikeTooHigh' });
});

test('Gate 2: the engine brings P1 and the vault buys at exactly that price', { skip: toolsMissing }, async () => {
  assert.ok(engine.current);
  await advance(1);
  usd.OIL = '71.4';
  usd.ETH = '2004';
  await engine.current.checkPending();
  const bought = last('trigger.bought');
  assert.equal(bought?.asset, 'OIL', JSON.stringify(log.recent().slice(-4)));
  assert.equal(bought?.price, '71.4');
  assert.equal(bought?.usdcIn, '500');
  assert.equal(await readVault('balanceOf', user), usdc(9_500));
  const position = await readVault('getPosition', 1n);
  assert.ok(position.isOpen);
  assert.equal(position.amount, (usdc(500) * 10n ** 36n) / (714n * 10n ** 17n * 10n ** 6n));
  assert.equal(last('trigger.checked')?.verdict, 'the price did not rise enough', 'ETH waits');
});

test('a restarted agent finds the open position and its exits from the chain', { skip: toolsMissing }, async () => {
  const [position] = await agentVault().listPositions();
  assert.equal(position?.id, '1');
  assert.equal(position?.asset, 'OIL');
  assert.equal(position?.open, true);
  assert.equal(position?.exits.stopLossBps, 500);
});

test('the keeper stops the loss on-chain', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  await advance(60);
  // 67 is 6.2% under the 71.4 entry, past the 5% stop-loss
  usd.OIL = '67';
  await new SellKeeper({ profiles, vault: vault.current, log, now: () => clock.now, prices }).tick();
  const sold = last('position.sold');
  assert.equal(sold?.sellKind, 'stop-loss', JSON.stringify(log.recent().slice(-3)));
  assert.equal((await readVault('getPosition', 1n)).isOpen, false);
  assert.ok((await readVault('balanceOf', user)) < usdc(10_000), 'the loss is in the user balance');
});

test('a trigger whose window closed expires on-chain', { skip: toolsMissing }, async () => {
  assert.ok(engine.current);
  await advance(600);
  await engine.current.checkPending();
  assert.equal(last('trigger.expired')?.asset, 'ETH');
  assert.equal((await readVault('getTrigger', 2n)).status, 3, 'expired');
  assert.ok(!kinds().includes('error'), JSON.stringify(log.recent().filter((event) => event.kind === 'error')));
});
