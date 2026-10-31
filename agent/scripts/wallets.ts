// Shows the agent's two wallets and whether they can run: the agent wallet pays the gas of its vault transactions, the
// payer wallet pays aUSD for data. Run with `npm run wallets`. It reads the keys from agent/.env, derives the addresses
// and prints addresses only, never a key.
import { existsSync, readFileSync } from 'node:fs';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  type Hex,
  http,
  isAddressEqual,
  isHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { AUSD_DECIMALS, readAusdBalance, TWEET_PRICE_AUSD } from '../src/airnode/client.ts';
import { ViemVault } from '../src/chain/viem-vault.ts';
import { readBudgetSettings } from '../src/engine/budget.ts';
import { activeWatchSet } from '../src/engine/watch-set.ts';
import { loadProfiles } from '../src/profiles.ts';
import { loadWatchlist } from '../src/sources/watchlist.ts';

export const addressLink = (address: Address) => `https://sepolia.basescan.org/address/${address}`;

export interface WalletReport {
  agent?: { address: Address; eth: bigint };
  payer?: { address: Address; ausd: bigint };
  // Users whose rule names the agent wallet; undefined when the vault could not be read
  rulesNamingAgent?: number;
  // Why the rules could not be read
  rulesUnavailable?: string;
}

export interface WalletLimits {
  // Wei
  minEth: bigint;
  // aUSD with 6 decimals
  minAusd: bigint;
}

export interface Check {
  ok: boolean;
  message: string;
}

// The same minimums as the agent's budget: AGENT_MIN_ETH and PAYER_MIN_AUSD
export const walletLimits = (env: NodeJS.ProcessEnv = process.env): WalletLimits => {
  const { minEth, minAusd } = readBudgetSettings(env);
  return { minEth, minAusd };
};

export const checkWallets = (report: WalletReport, limits: WalletLimits): Check[] => {
  const { agent, payer } = report;
  const checks: Check[] = [];
  checks.push(
    agent
      ? {
          ok: agent.eth >= limits.minEth,
          message: `agent wallet holds ${formatEther(agent.eth)} ETH, needs at least ${formatEther(limits.minEth)} for gas`,
        }
      : { ok: false, message: 'AGENT_PRIVATE_KEY is not set in agent/.env' }
  );
  checks.push(
    payer
      ? {
          ok: payer.ausd >= limits.minAusd,
          message: `payer wallet holds ${formatUnits(payer.ausd, AUSD_DECIMALS)} aUSD, needs at least ${formatUnits(limits.minAusd, AUSD_DECIMALS)} for data`,
        }
      : { ok: false, message: 'PAYER_PRIVATE_KEY is not set in agent/.env' }
  );
  if (agent && payer) {
    checks.push(
      isAddressEqual(agent.address, payer.address)
        ? {
            ok: false,
            message:
              'agent and payer are the same wallet: use two, so a stolen agent key cannot spend data money and the other way round',
          }
        : { ok: true, message: 'agent and payer are different wallets' }
    );
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

// One paid tweet call per watched account per poll
export const paidCallsPerHour = (accounts: number, pollIntervalSec: number) =>
  pollIntervalSec > 0 ? (accounts * 3600) / pollIntervalSec : 0;

// Hours the payer's aUSD lasts at `callsPerHour` tweet calls; undefined when the agent makes no paid call
export const estimateRuntimeHours = (ausd: bigint, callsPerHour: number, pricePerCall: bigint = TWEET_PRICE_AUSD) =>
  callsPerHour > 0 ? Number(ausd) / (callsPerHour * Number(pricePerCall)) : undefined;

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
  // aUSD lives on Base Sepolia, where the Airnodes take payment, whichever chain the vault is on
  const ausdClient =
    chain.id === baseSepolia.id
      ? client
      : createPublicClient({ chain: baseSepolia, transport: http(env.AUSD_RPC_URL || 'https://sepolia.base.org') });

  const agentAddress = keyAddress(env, 'AGENT_PRIVATE_KEY');
  const payerAddress = keyAddress(env, 'PAYER_PRIVATE_KEY');
  const report: WalletReport = {};
  if (agentAddress) report.agent = { address: agentAddress, eth: await client.getBalance({ address: agentAddress }) };
  if (payerAddress) report.payer = { address: payerAddress, ausd: await readAusdBalance(ausdClient, payerAddress) };

  const watchlist = loadWatchlist(env);
  let watched: string[] | undefined;
  const deploymentUrl = new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url);
  if (!agentAddress) {
    report.rulesUnavailable = 'no agent wallet';
  } else if (!existsSync(deploymentUrl)) {
    report.rulesUnavailable = `no deployment at shared/deployments/${chain.id}.json`;
  } else {
    const deployment = JSON.parse(readFileSync(deploymentUrl, 'utf8')) as { vault: Address; deployedAtBlock: number };
    const vault = new ViemVault({
      address: (env.VAULT_ADDRESS as Address | undefined) || deployment.vault,
      publicClient: client as never,
      // Reads only: listRules needs the agent's address, never its key
      walletClient: createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex) }),
      profiles: loadProfiles(),
      watchlist,
      fromBlock: BigInt(deployment.deployedAtBlock),
    });
    try {
      const rules = await vault.listRules();
      report.rulesNamingAgent = rules.length;
      watched = activeWatchSet(rules);
    } catch (error) {
      report.rulesUnavailable = (error as Error).message.split('\n')[0];
    }
  }

  console.log(`Chain ${chain.name} (${chain.id}), RPC ${new URL(rpcUrl).host}`);
  if (report.agent) {
    console.log(`Agent wallet  ${report.agent.address}  ${addressLink(report.agent.address)}`);
    console.log(`              ${formatEther(report.agent.eth)} ETH (gas for confirmTrigger, buys, expiries and sells)`);
  }
  if (report.payer) {
    const payerEth = await ausdClient.getBalance({ address: report.payer.address });
    console.log(`Payer wallet  ${report.payer.address}  ${addressLink(report.payer.address)}`);
    console.log(`              ${formatUnits(report.payer.ausd, AUSD_DECIMALS)} aUSD (data), ${formatEther(payerEth)} ETH (not needed)`);
  }

  const checks = checkWallets(report, walletLimits(env));
  for (const check of checks) console.log(`${check.ok ? '✔' : '✖'} ${check.message}`);

  const pollIntervalSec = Number(env.POLL_INTERVAL_SEC || 60);
  const accounts = watched ?? watchlist.map((account) => account.handle);
  const callsPerHour = paidCallsPerHour(accounts.length, pollIntervalSec);
  const source = watched ? 'active watch set' : 'whole watchlist, rules unknown';
  console.log(
    `Paid polls: ${accounts.length} account(s) (${source}: ${accounts.join(', ') || 'none'}) every ${pollIntervalSec} s = ` +
      `${callsPerHour} calls/h, ${formatUnits(BigInt(Math.round(callsPerHour * Number(TWEET_PRICE_AUSD))), AUSD_DECIMALS)} aUSD/h`
  );
  if (report.payer) {
    const hours = estimateRuntimeHours(report.payer.ausd, callsPerHour);
    console.log(hours === undefined ? 'Estimated runtime: no paid polls, so the aUSD lasts' : `Estimated runtime left: ${hours.toFixed(1)} h`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}
