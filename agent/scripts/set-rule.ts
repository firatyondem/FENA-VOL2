// Sets up a user for the demo: mints and deposits mock USDC and sets their rule with this agent's wallet.
// Run with USER_PRIVATE_KEY, RPC_URL and AGENT_PRIVATE_KEY (or AGENT_ADDRESS) in agent/.env: `npm run set-rule`.
import { readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, type Hex, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { applyRule, type RuleConfig } from '../src/chain/setup.ts';
import type { WatchedAccount } from '../src/sources/twitter.ts';

const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;
const { RPC_URL, USER_PRIVATE_KEY, AGENT_PRIVATE_KEY, AGENT_ADDRESS, RULE_FILE } = process.env;
if (!RPC_URL || !USER_PRIVATE_KEY) throw new Error('Set RPC_URL and USER_PRIVATE_KEY');
const agent = AGENT_ADDRESS ?? (AGENT_PRIVATE_KEY ? privateKeyToAccount(AGENT_PRIVATE_KEY as Hex).address : undefined);
if (!agent || !isAddress(agent)) throw new Error('Set AGENT_ADDRESS or AGENT_PRIVATE_KEY');

const chain = Number(process.env.CHAIN_ID || baseSepolia.id) === foundry.id ? foundry : baseSepolia;
const deployment = readJson<{ vault: Address; usdc: Address }>(
  new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url)
);
const config = readJson<RuleConfig>(new URL(RULE_FILE || '../config/rule.example.json', import.meta.url));
const walletClient = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(USER_PRIVATE_KEY as Hex) });
const hashes = await applyRule({
  publicClient: createPublicClient({ chain, transport: http(RPC_URL) }) as never,
  walletClient,
  vault: deployment.vault,
  usdc: deployment.usdc,
  agent,
  config,
  watchlist: readJson<WatchedAccount[]>(new URL('../config/watchlist.json', import.meta.url)),
});
console.log(`Deposited ${config.depositUsdc} mUSDC and set the rule of ${walletClient.account.address} with agent ${agent}`);
for (const hash of hashes) console.log(`  ${hash}`);
