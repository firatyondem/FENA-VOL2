// Shows the agent's wallets and whether they can run: the agent wallet pays the gas and Pyth's fees of its vault
// transactions, and the optional faucet wallet funds demo users. Data (posts, model calls) is paid by API key, in USD.
// Run with `npm run wallets`. It reads the keys from agent/.env, derives the addresses and prints addresses only, never a
// key. It also estimates what polling the watched accounts costs a day on the smart-poll schedule.
import { existsSync, readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, formatEther, type Hex, http, isAddressEqual, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { ViemVault } from '../src/chain/viem-vault.ts';
import { readBudgetSettings } from '../src/engine/budget.ts';
import { readPollSchedule, type PollScheduleSettings } from '../src/engine/poll-schedule.ts';
import { activeWatchSet } from '../src/engine/watch-set.ts';
import { redactUrls } from '../src/log.ts';
import { loadProfiles } from '../src/profiles.ts';
import { GETXAPI_USD_PER_CALL } from '../src/sources/getxapi.ts';
import { TWITTERAPI_IO_USD_PER_TWEET } from '../src/sources/twitterapi-io.ts';
import { loadWatchlist } from '../src/sources/watchlist.ts';

export const addressLink = (address: Address) => `https://sepolia.basescan.org/address/${address}`;

// What an RPC failure says, in one line and without its URL: viem quotes the RPC URL in full, and a provider's carries
// the API key
export const describeRpcError = (error: unknown) => {
  const { shortMessage, details, message } = error as { shortMessage?: string; details?: string; message?: string };
  const text = shortMessage
    ? [shortMessage, details].filter(Boolean).join(' ')
    : (message ?? String(error)).split('\n')[0];
  return redactUrls(text ?? '');
};

export interface WalletReport {
  agent?: { address: Address; eth: bigint };
  faucet?: { address: Address; eth: bigint };
  // Users whose rule names the agent wallet; undefined when the vault could not be read
  rulesNamingAgent?: number;
  // Why the rules could not be read
  rulesUnavailable?: string;
}

export interface WalletLimits {
  // Wei
  minEth: bigint;
}

export interface Check {
  ok: boolean;
  message: string;
}

// The same minimum as the agent's budget: AGENT_MIN_ETH
export const walletLimits = (env: NodeJS.ProcessEnv = process.env): WalletLimits => ({
  minEth: readBudgetSettings(env).minEth,
});

export const checkWallets = (report: WalletReport, limits: WalletLimits): Check[] => {
  const { agent, faucet } = report;
  const checks: Check[] = [];
  checks.push(
    agent
      ? {
          ok: agent.eth >= limits.minEth,
          message: `agent wallet holds ${formatEther(agent.eth)} ETH, needs at least ${formatEther(limits.minEth)} for gas and Pyth's fees`,
        }
      : { ok: false, message: 'AGENT_PRIVATE_KEY is not set in agent/.env' }
  );
  if (agent && faucet && isAddressEqual(agent.address, faucet.address)) {
    checks.push({
      ok: false,
      message: 'agent and faucet are the same wallet: use two, so demo users cannot drain the gas the agent needs',
    });
  }
  if (report.rulesNamingAgent === undefined) {
    checks.push({ ok: false, message: `could not read the rules: ${report.rulesUnavailable ?? 'unknown reason'}` });
  } else if (report.rulesNamingAgent === 0) {
    checks.push({
      ok: false,
      message: `No user has approved this agent yet: save a rule in the frontend naming ${agent?.address ?? 'the agent wallet'}`,
    });
  } else {
    const users = report.rulesNamingAgent === 1 ? '1 user names' : `${report.rulesNamingAgent} users name`;
    checks.push({ ok: true, message: `${users} this agent in their rule` });
  }
  return checks;
};

// Polls of one account in a week on the schedule: active through market hours (6.5 h on weekdays), quiet the rest. Posts
// make it busier; a long silence makes it idler, so this is the quiet-account case.
export const pollsPerDay = (settings: PollScheduleSettings): number => {
  const [open = '09:30', close = '16:00'] = settings.marketHours.split('-');
  const minutes = (hhmm: string) => {
    const [h = '0', m = '0'] = hhmm.split(':');
    return Number(h) * 60 + Number(m);
  };
  const marketSec = Math.max(0, minutes(close) - minutes(open)) * 60;
  const weekSec = 7 * 86_400;
  const activeSec = 5 * marketSec;
  const perWeek = activeSec / settings.activeSec + (weekSec - activeSec) / settings.idleSec;
  return perWeek / 7;
};

// USD a day to poll `accounts` accounts with no new posts: GetXAPI bills each call, TwitterAPI.io an empty page as one
// post
export const pollUsdPerDay = (source: string, accounts: number, settings: PollScheduleSettings) =>
  accounts * pollsPerDay(settings) * (source === 'twitterapi.io' ? TWITTERAPI_IO_USD_PER_TWEET : GETXAPI_USD_PER_CALL);

const keyAddress = (env: NodeJS.ProcessEnv, name: string): Address | undefined => {
  const key = env[name];
  if (!key) return undefined;
  if (!isHex(key) || key.length !== 66) throw new Error(`${name} in agent/.env must be a 0x-prefixed 32-byte hex key`);
  return privateKeyToAccount(key).address;
};

if (import.meta.main) {
  const env = process.env;
  const chain = Number(env.CHAIN_ID ?? baseSepolia.id) === foundry.id ? foundry : baseSepolia;
  const rpcUrl = env.RPC_URL || (chain.id === foundry.id ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org');
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const agentAddress = keyAddress(env, 'AGENT_PRIVATE_KEY');
  const faucetAddress = keyAddress(env, 'FAUCET_PRIVATE_KEY');
  const report: WalletReport = {};
  try {
    if (agentAddress) report.agent = { address: agentAddress, eth: await client.getBalance({ address: agentAddress }) };
    if (faucetAddress) report.faucet = { address: faucetAddress, eth: await client.getBalance({ address: faucetAddress }) };
  } catch (error) {
    console.log(`✖ could not read the wallet balances: ${describeRpcError(error)}`);
    process.exit(1);
  }

  const watchlist = loadWatchlist(env);
  let watched: string[] | undefined;
  const deploymentUrl = new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url);
  if (!agentAddress) {
    report.rulesUnavailable = 'no agent wallet';
  } else if (!existsSync(deploymentUrl)) {
    report.rulesUnavailable = `no deployment at shared/deployments/${chain.id}.json`;
  } else {
    const deployment = JSON.parse(readFileSync(deploymentUrl, 'utf8')) as { vault: Address; deployedAtBlock: number; scanFromBlock?: number };
    const vault = new ViemVault({
      address: (env.VAULT_ADDRESS as Address | undefined) || deployment.vault,
      publicClient: client as never,
      // Reads only: listRules needs the agent's address, never its key
      walletClient: createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex) }),
      profiles: loadProfiles(),
      watchlist,
      fromBlock: BigInt(deployment.scanFromBlock ?? deployment.deployedAtBlock),
    });
    try {
      const rules = await vault.listRules();
      report.rulesNamingAgent = rules.length;
      watched = activeWatchSet(rules);
    } catch (error) {
      report.rulesUnavailable = describeRpcError(error);
    }
  }

  console.log(`Chain ${chain.name} (${chain.id}), RPC ${new URL(rpcUrl).host}`);
  if (report.agent) {
    console.log(`Agent wallet   ${report.agent.address}  ${addressLink(report.agent.address)}`);
    console.log(`               ${formatEther(report.agent.eth)} ETH (gas and Pyth's fees)`);
  }
  if (report.faucet) {
    console.log(`Faucet wallet  ${report.faucet.address}  ${addressLink(report.faucet.address)}`);
    console.log(`               ${formatEther(report.faucet.eth)} ETH for demo users`);
  }

  const checks = checkWallets(report, walletLimits(env));
  for (const check of checks) console.log(`${check.ok ? '✔' : '✖'} ${check.message}`);

  const schedule = readPollSchedule(env);
  const source = env.POST_SOURCE || 'getxapi';
  const accounts = watched ?? watchlist.map((account) => account.handle);
  const which = watched ? 'active watch set' : 'whole watchlist, rules unknown';
  console.log(
    `Polls: ${accounts.length} account(s) (${which}: ${accounts.join(', ') || 'none'}), about ` +
      `${pollsPerDay(schedule).toFixed(0)} a day each on the schedule = $${pollUsdPerDay(source, accounts.length, schedule).toFixed(3)}/day on ${source}`
  );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}
