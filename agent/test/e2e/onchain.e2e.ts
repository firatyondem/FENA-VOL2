// End to end on a local chain: Deploy.s.sol puts the mocks and Person A's Vault on anvil, a user sets a rule naming the
// agent, and the agent's own engine, keeper and ViemVault drive real transactions through every gate. Responses are
// signed at chain time by the public fixture key, which the deploy registers as the Airnode.
// Needs anvil and forge on PATH: `npm run test:e2e`.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  parseUnits,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { applyRule, type RuleConfig } from '../../src/chain/setup.ts';
import { vaultAbi } from '../../src/chain/vault-abi.ts';
import { VaultRejection } from '../../src/chain/vault.ts';
import { ViemVault } from '../../src/chain/viem-vault.ts';
import type { Candidate, Classification, Classifier } from '../../src/classifier/types.ts';
import { SellKeeper } from '../../src/engine/keeper.ts';
import { TriggerEngine } from '../../src/engine/trigger-engine.ts';
import { EventLog, type LoggedEvent } from '../../src/log.ts';
import { loadProfiles } from '../../src/profiles.ts';
import type { WatchedAccount } from '../../src/sources/twitter.ts';
import { ATTACKER_KEY, FIXTURE_AIRNODE_KEY } from '../../scripts/fixture-set.ts';
import { ANVIL_KEYS, advanceChain, chainTime, signFixturePost, signFixturePrice } from '../../scripts/local-chain.ts';

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const DEPLOYMENT = new URL('../../../shared/deployments/e2e-31337.json', import.meta.url);
const KEYS = { deployer: ANVIL_KEYS.deployer, user: ANVIL_KEYS.one, agent: ANVIL_KEYS.two, keeper: ANVIL_KEYS.three };

const hasTool = (name: string) => spawnSync(name, ['--version'], { stdio: 'ignore', shell: false }).status === 0;
const toolsMissing = !hasTool('anvil') || !hasTool('forge');

const profiles = loadProfiles();
const trump: WatchedAccount = { handle: 'realDonaldTrump', label: 'Donald Trump', assets: ['OIL', 'BTC', 'ETH'], pinned: false };
const fixtureAirnode = privateKeyToAccount(FIXTURE_AIRNODE_KEY).address;
const usdc = (amount: number) => parseUnits(String(amount), 6);

class StubClassifier implements Classifier {
  readonly name = 'stub';
  async classify(_post: unknown, candidates: Candidate[]): Promise<Classification[]> {
    return candidates.map((candidate) => ({ asset: candidate.asset, relevant: true, confidence: 0.9, reason: 'stub' }));
  }
}

let anvil: ChildProcess | undefined;
let publicClient: PublicClient;
let deployment: { vault: Address; usdc: Address; deployedAtBlock: number };
const clock = { now: 0 };
const prices: Record<string, string> = { OIL: '70.25', ETH: '2000' };

const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport: http(RPC) });
const wallet = (key: Hex) => createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(key) });

const syncClock = async () => {
  clock.now = await chainTime(publicClient);
};
const advance = async (seconds: number) => {
  clock.now = await advanceChain(testClient, publicClient, seconds);
};

const signedPrice = (asset: string, price: string, at: number, key: Hex = FIXTURE_AIRNODE_KEY, requestAsset = asset) =>
  signFixturePrice(profiles, asset, price, at, key, requestAsset);

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
  const deploy = spawnSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC, '--broadcast'], {
    cwd: CONTRACTS,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRIVATE_KEY: KEYS.deployer,
      FIXTURE_AIRNODES: 'true',
      DEPLOYMENT_FILE: '../shared/deployments/e2e-31337.json',
    },
  });
  assert.equal(deploy.status, 0, deploy.stdout + deploy.stderr);
  deployment = JSON.parse(readFileSync(DEPLOYMENT, 'utf8'));

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
  await syncClock();
});

after(() => {
  anvil?.kill();
});

const user = privateKeyToAccount(KEYS.user).address;
const log = new EventLog({ now: () => clock.now * 1000 });
const kinds = () => log.recent().map((event) => event.kind);
const last = <K extends LoggedEvent['kind']>(kind: K) =>
  log.recent().findLast((event) => event.kind === kind) as Extract<LoggedEvent, { kind: K }> | undefined;
let postTime = 0;

const fetchPrice = (asset: string) => signedPrice(asset, prices[asset] as string, clock.now);
const makeEngine = (vault: ViemVault) =>
  new TriggerEngine({
    profiles,
    vault,
    classifier: new StubClassifier(),
    log,
    now: () => clock.now,
    tweetAirnode: fixtureAirnode,
    fetchLatestPost: async () =>
      signFixturePost({
        handle: 'realDonaldTrump',
        createdAt: postTime,
        signedAt: clock.now,
        text: 'We are coming for Venezuela. Big things are happening!',
      }),
    fetchPrice,
  });

const vault = { current: undefined as ViemVault | undefined };
const engine = { current: undefined as TriggerEngine | undefined };

test('the agent finds the rule that names it, with its accounts and topics', { skip: toolsMissing }, async () => {
  vault.current = agentVault();
  const [rule] = await vault.current.listRules();
  assert.ok(rule);
  assert.equal(rule.id, user);
  assert.equal(rule.buyAmount, usdc(500));
  assert.deepEqual(rule.accounts, { realDonaldTrump: ['OIL', 'ETH'] });
  assert.deepEqual(rule.assets.map((asset) => asset.asset), ['OIL', 'ETH']);
  assert.ok(rule.topics.OIL?.includes('Venezuela'));
  assert.equal(await readVault('balanceOf', user), usdc(10_000));
});

test('Gate 1: a relevant post with a fresh P0 opens an on-chain trigger per asset', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  postTime = clock.now - 30;
  engine.current = makeEngine(vault.current);
  await engine.current.pollAccount(trump);
  const opened = log.recent().filter((event) => event.kind === 'trigger.opened');
  assert.deepEqual(
    opened.map((event) => (event.kind === 'trigger.opened' ? [event.triggerId, event.asset] : [])),
    [
      ['1', 'OIL'],
      ['2', 'ETH'],
    ],
    JSON.stringify(log.recent())
  );
  assert.equal((await readVault('getTrigger', 1n)).status, 1, 'open');
  assert.ok(opened.every((event) => event.kind === 'trigger.opened' && event.txHash));
});

test('the four tamper tests revert on the real vault', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  await advance(130);
  const valid = await signedPrice('ETH', '2070', clock.now);
  const forgeries: [string, Promise<typeof valid> | typeof valid, string][] = [
    ['edited value', { ...valid, data: valid.data.replace('"price":2070', '"price":2170') }, 'NotSignedByAirnode'],
    ['stale response', signedPrice('ETH', '2070', clock.now - 400), 'ResponseTooOld'],
    ['different request', signedPrice('ETH', '2070', clock.now, FIXTURE_AIRNODE_KEY, 'BTC'), 'WrongRequestHash'],
    ['wrong signer', signedPrice('ETH', '2070', clock.now, ATTACKER_KEY), 'NotSignedByAirnode'],
  ];
  for (const [name, forgery, reason] of forgeries) {
    await assert.rejects(
      vault.current.confirmTrigger('2', await forgery),
      (error) => error instanceof VaultRejection && error.reason === reason,
      name
    );
  }
  assert.equal(await readVault('balanceOf', user), usdc(10_000), 'no funds moved');
});

test('Gate 2 refuses a weak trend and a spike on-chain', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  await assert.rejects(vault.current.confirmTrigger('2', await signedPrice('ETH', '2004', clock.now)), {
    reason: 'TrendTooWeak',
  });
  await assert.rejects(vault.current.confirmTrigger('2', await signedPrice('ETH', '2300', clock.now)), {
    reason: 'SpikeTooHigh',
  });
});

test('Gate 2: the engine brings P1 and the vault buys at exactly that price', { skip: toolsMissing }, async () => {
  assert.ok(engine.current);
  prices.OIL = '71.4';
  prices.ETH = '2004';
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

test('a restarted agent finds the open position from the chain', { skip: toolsMissing }, async () => {
  const [position] = await agentVault().listPositions();
  assert.equal(position?.id, '1');
  assert.equal(position?.asset, 'OIL');
  assert.equal(position?.open, true);
});

test('the keeper takes profit on-chain with a signed price', { skip: toolsMissing }, async () => {
  assert.ok(vault.current);
  await advance(60);
  prices.OIL = '77.2';
  await new SellKeeper({ profiles, vault: vault.current, log, now: () => clock.now, fetchPrice }).tick();
  const sold = last('position.sold');
  assert.equal(sold?.sellKind, 'take-profit', JSON.stringify(log.recent().slice(-3)));
  assert.equal((await readVault('getPosition', 1n)).isOpen, false);
  assert.ok((await readVault('balanceOf', user)) > usdc(10_000), 'the profit is in the user balance');
});

test('a trigger whose window closed expires on-chain', { skip: toolsMissing }, async () => {
  assert.ok(engine.current);
  await advance(600);
  await engine.current.checkPending();
  assert.equal(last('trigger.expired')?.asset, 'ETH');
  assert.equal((await readVault('getTrigger', 2n)).status, 3, 'expired');
  assert.ok(!kinds().includes('error'), JSON.stringify(log.recent().filter((event) => event.kind === 'error')));
});
