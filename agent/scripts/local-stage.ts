// Plays the agent on a local anvil chain, for rehearsals and for testing the frontend's live mode: scripted posts and
// prices signed at chain time by the public fixture key, sent from anvil account 1 (the sandbox's agent wallet), with
// anvil's clock moved forward instead of waiting. Needs a deploy with FIXTURE_AIRNODES=true.
//   npm run local-stage -- open --user <address> --asset ETH [--account realDonaldTrump] [--price 2000] [--text "..."]
//   npm run local-stage -- confirm --trigger <id> --move 3.5
//   npm run local-stage -- sell --position <id> --move 9 --reason takeprofit|stagnation|manual
//   npm run local-stage -- expire --trigger <id>
// --move 0.5 shows TrendTooWeak, --move 30 shows SpikeTooHigh; a fall needs the = form, --move=-2. Every revert prints
// the vault's error name.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { formatFixedPoint } from '../src/airnode/projected-json.ts';
import { vaultAbi } from '../src/chain/vault-abi.ts';
import { type SellKind, VaultRejection } from '../src/chain/vault.ts';
import { assetIdOf, ViemVault } from '../src/chain/viem-vault.ts';
import { loadProfiles } from '../src/profiles.ts';
import { ANVIL_KEYS, advanceChain, chainNow, signFixturePost, signFixturePrice } from './local-chain.ts';

// Starting prices for P0 when --price is not given, close to the markets' late-October levels
const DEFAULT_PRICES: Record<string, string> = { ETH: '2000', BTC: '77000', DOGE: '0.075845', OIL: '70.25', TSLA: '420' };
const DEFAULT_TEXTS: Record<string, string> = {
  ETH: 'America will be the crypto capital of the planet!',
  BTC: 'A strategic bitcoin reserve is coming.',
  DOGE: 'Ðogecoin is the people’s crypto',
  OIL: 'We are coming for Venezuela. Big things are happening!',
  TSLA: 'The EV mandate is over.',
};
const SELL_REASONS: Record<string, SellKind> = { takeprofit: 'take-profit', stagnation: 'stagnation', manual: 'manual' };
const TRIGGER_STATUS = ['none', 'open', 'confirmed', 'expired'];

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: 'string' },
    asset: { type: 'string' },
    account: { type: 'string', default: 'realDonaldTrump' },
    price: { type: 'string' },
    text: { type: 'string' },
    trigger: { type: 'string' },
    position: { type: 'string' },
    move: { type: 'string', default: '0' },
    reason: { type: 'string', default: 'takeprofit' },
    rpc: { type: 'string', default: process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545' },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const profiles = loadProfiles();
const deployment = JSON.parse(
  readFileSync(new URL('../../shared/deployments/31337.json', import.meta.url), 'utf8')
) as { vault: Address; fixtureAirnodes: boolean };
if (!deployment.fixtureAirnodes) {
  fail('shared/deployments/31337.json was not deployed with FIXTURE_AIRNODES=true, so fixture-signed data would revert');
}

const transport = http(values.rpc);
const publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;
const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport });
const agentWallet = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(ANVIL_KEYS.one) });
const vaultFor = (walletClient = agentWallet) =>
  new ViemVault({ address: deployment.vault, publicClient, walletClient, profiles, watchlist: [] });
const assetKeys = new Map(Object.keys(profiles.assets).map((key) => [assetIdOf(key).toLowerCase(), key]));
const keyOf = (assetId: Hex) => assetKeys.get(assetId.toLowerCase()) ?? fail(`Unknown asset id ${assetId}`);
const iso = (seconds: number | bigint) => new Date(Number(seconds) * 1000).toISOString();

// price * (1 + move %), with the move in whole basis points, as 18-decimal fixed point
const moved = (price: bigint, movePct: string) => {
  const bps = Math.round(Number(movePct) * 100);
  if (!Number.isFinite(bps) || bps <= -10_000) fail(`--move ${movePct} is not a usable percentage`);
  return (price * BigInt(10_000 + bps)) / 10_000n;
};

const read = <T>(functionName: string, args: readonly unknown[]) =>
  publicClient.readContract({ address: deployment.vault, abi: vaultAbi, functionName, args } as never) as Promise<T>;
type Trigger = { user: Address; assetId: Hex; p0: bigint; t0: bigint; status: number };
type Position = { user: Address; assetId: Hex; amount: bigint; entryPrice: bigint; openedAt: bigint; isOpen: boolean };
type AssetRule = { minWait: number; maxWindow: number; stagnationDelay: number };
const assetRule = async (user: Address, assetId: Hex) => (await read<[boolean, AssetRule]>('getAssetRule', [user, assetId]))[1];

// Waits on anvil's clock until `target`, if it is not there yet
const advanceTo = async (target: number) => {
  const now = await chainNow(testClient, publicClient);
  return advanceChain(testClient, publicClient, Math.max(0, target - now));
};

const run = async (action: () => Promise<string>) => {
  try {
    console.log(await action());
  } catch (error) {
    if (error instanceof VaultRejection) {
      console.log(`Reverted: ${error.reason}`);
      process.exit(2);
    }
    throw error;
  }
};

const open = async () => {
  const input = values.user ?? fail('open needs --user <address>');
  const user: Address = isAddress(input) ? input : fail(`--user ${input} is not an address`);
  const asset = (values.asset ?? fail('open needs --asset')).toUpperCase();
  const price = values.price ?? DEFAULT_PRICES[asset] ?? fail(`No default price for ${asset}; pass --price`);
  const now = await chainNow(testClient, publicClient);
  // The post's id encodes a minute ago, and P0 is taken now: inside the vault's 10-minute post-to-P0 window
  const post = await signFixturePost({
    handle: values.account,
    createdAt: now - 60,
    signedAt: now,
    text: values.text ?? DEFAULT_TEXTS[asset] ?? 'Big things are happening!',
    sequence: BigInt(now % 4096),
  });
  const p0 = await signFixturePrice(profiles, asset, price, now);
  const { triggerId } = await vaultFor().openTrigger({ ruleId: user, asset, account: values.account, post, p0 });
  const rule = await assetRule(user, assetIdOf(asset));
  return [
    `Opened trigger ${triggerId} for ${asset} after @${values.account}: P0 ${price} at ${iso(now)}`,
    `  P1 accepted from ${iso(now + rule.minWait)} to ${iso(now + rule.maxWindow)}`,
  ].join('\n');
};

const confirm = async () => {
  const id = values.trigger ?? fail('confirm needs --trigger <id>');
  const trigger = await read<Trigger>('getTrigger', [BigInt(id)]);
  if (trigger.status !== 1) fail(`Trigger ${id} is ${TRIGGER_STATUS[trigger.status] ?? trigger.status}, not open`);
  const asset = keyOf(trigger.assetId);
  const rule = await assetRule(trigger.user, trigger.assetId);
  const now = await advanceTo(Number(trigger.t0) + rule.minWait + 5);
  const p1 = moved(trigger.p0, values.move);
  const response = await signFixturePrice(profiles, asset, formatFixedPoint(p1, 18), now);
  const bought = await vaultFor().confirmTrigger(id, response);
  return [
    `Confirmed trigger ${id}: ${asset} ${formatFixedPoint(trigger.p0, 18)} -> ${formatFixedPoint(p1, 18)} (${values.move}%)`,
    `  Position ${bought.positionId}: ${formatFixedPoint(bought.assetOut, 18)} ${asset} for ${formatFixedPoint(bought.usdcIn, 6)} mUSDC`,
  ].join('\n');
};

const sell = async () => {
  const id = values.position ?? fail('sell needs --position <id>');
  const kind = SELL_REASONS[values.reason.toLowerCase()] ?? fail('--reason is takeprofit, stagnation or manual');
  const position = await read<Position>('getPosition', [BigInt(id)]);
  if (!position.isOpen) fail(`Position ${id} is not open`);
  const asset = keyOf(position.assetId);
  let now = await chainNow(testClient, publicClient);
  if (kind === 'stagnation') {
    const rule = await assetRule(position.user, position.assetId);
    now = await advanceTo(Number(position.openedAt) + rule.stagnationDelay + 5);
  }
  const price = moved(position.entryPrice, values.move);
  const response = await signFixturePrice(profiles, asset, formatFixedPoint(price, 18), now);
  // Only the owner sells by hand: anvil lets the driver send as them
  let wallet = agentWallet;
  if (kind === 'manual') {
    await testClient.impersonateAccount({ address: position.user });
    wallet = createWalletClient({ chain: foundry, transport, account: position.user }) as never;
  }
  try {
    const sold = await vaultFor(wallet).sell(id, kind, response);
    return `Sold position ${id} (${values.reason}) at ${formatFixedPoint(price, 18)}: ${formatFixedPoint(sold.usdcOut, 6)} mUSDC back to the vault balance`;
  } finally {
    if (kind === 'manual') await testClient.stopImpersonatingAccount({ address: position.user });
  }
};

const expire = async () => {
  const id = values.trigger ?? fail('expire needs --trigger <id>');
  const trigger = await read<Trigger>('getTrigger', [BigInt(id)]);
  const rule = await assetRule(trigger.user, trigger.assetId);
  await advanceTo(Number(trigger.t0) + rule.maxWindow + 5);
  await vaultFor().expireTrigger(id);
  return `Expired trigger ${id}; nothing was bought`;
};

const commands: Record<string, () => Promise<string>> = { open, confirm, sell, expire };
const command = commands[positionals[0] ?? ''] ?? fail(`Usage: npm run local-stage -- <${Object.keys(commands).join('|')}> [options]`);
await run(command);
