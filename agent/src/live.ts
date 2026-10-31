// Live mode: real accounts through the TwitterAPI.io Airnode, real signed prices, the deployed vault on Base Sepolia (or
// a local anvil). Keys come from agent/.env and never leave this process.
import { readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, formatEther, formatUnits, type Hex, http, isAddress, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import {
  AUSD_DECIMALS,
  createPayingFetch,
  fetchSignedResponse,
  readAusdBalance,
  withSettlementReporting,
} from './airnode/client.ts';
import { ViemVault } from './chain/viem-vault.ts';
import type { Classifier } from './classifier/types.ts';
import { Budget, budgetedFetch, GuardedVault, PRICED_AIRNODES, readBudgetSettings } from './engine/budget.ts';
import { CycleRunner } from './engine/cycle.ts';
import { airnodeSourceOf, guardedClassifier, guardedFetch, SourceGuard } from './engine/sources.ts';
import { buildStatus } from './engine/status.ts';
import { SellKeeper } from './engine/keeper.ts';
import { TriggerEngine } from './engine/trigger-engine.ts';
import type { EventLog } from './log.ts';
import { getAsset, priceAirnode, priceRequest, type Profiles } from './profiles.ts';
import { latestTweetRequest } from './sources/twitter.ts';
import { loadWatchlist } from './sources/watchlist.ts';

const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in agent/.env for live mode (see agent/.env.example)`);
  return value;
};

const requireKey = (name: string): Hex => {
  const value = requireEnv(name);
  if (!isHex(value) || value.length !== 66) throw new Error(`${name} must be a 0x-prefixed 32-byte hex key`);
  return value;
};

// Unattended, a failure nobody caught must not leave a half-dead process behind: log it (the log writes synchronously, so
// it is on disk) and exit with code 1, so the supervisor restarts the agent.
export const installCrashHandlers = (log: EventLog) => {
  const crash = (where: string) => (error: unknown) => {
    try {
      log.append({ kind: 'error', where, message: error instanceof Error ? error.message : String(error) });
    } finally {
      process.exit(1);
    }
  };
  process.on('unhandledRejection', crash('unhandled rejection, exiting'));
  process.on('uncaughtException', crash('uncaught exception, exiting'));
};

export interface LiveOptions {
  profiles: Profiles;
  log: EventLog;
  classifier: Classifier;
}

export const startLive = async ({ profiles, log, classifier }: LiveOptions) => {
  installCrashHandlers(log);
  const rpcUrl = requireEnv('RPC_URL');
  const chain = Number(process.env.CHAIN_ID || baseSepolia.id) === foundry.id ? foundry : baseSepolia;
  const account = privateKeyToAccount(requireKey('AGENT_PRIVATE_KEY'));

  // Written by contracts/script/Deploy.s.sol
  const deployment = readJson<{ vault: Address; deployedAtBlock: number }>(
    new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url)
  );
  // An empty line in .env counts as unset here and below, as it does in .env.example
  const vaultAddress = process.env.VAULT_ADDRESS || deployment.vault;
  if (!isAddress(vaultAddress)) throw new Error('VAULT_ADDRESS is not an address');
  const watchlist = loadWatchlist();

  // A source that keeps failing (an Airnode, the RPC, the classifier) is skipped for a while instead of hammered
  const cycleIntervalSec = Number(process.env.CYCLE_INTERVAL_SEC || 30);
  const sources = new SourceGuard({ log, cycleIntervalSec });
  const rpcFetch = guardedFetch(fetch, sources, () => 'rpc');
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { fetchFn: rpcFetch }) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl, { fetchFn: rpcFetch }), account });

  // The agent's own money: the payer's aUSD for data and the agent wallet's ETH for gas, within daily budgets
  const payerKey = process.env.PAYER_PRIVATE_KEY;
  const payer = payerKey && isHex(payerKey) ? privateKeyToAccount(payerKey).address : undefined;
  const ausdClient =
    chain.id === baseSepolia.id
      ? publicClient
      : createPublicClient({
          chain: baseSepolia,
          transport: http(process.env.AUSD_RPC_URL || 'https://sepolia.base.org', { fetchFn: rpcFetch }),
        });
  const budgetSettings = readBudgetSettings();
  const budget = new Budget({
    settings: budgetSettings,
    log,
    trackAusd: Boolean(payer),
    readBalances: async () => ({
      ausd: payer ? await readAusdBalance(ausdClient as never, payer) : 0n,
      eth: await publicClient.getBalance({ address: account.address }),
    }),
  });

  const payingFetch: typeof fetch =
    payerKey && isHex(payerKey)
      ? withSettlementReporting(createPayingFetch(payerKey), (transaction) =>
          log.append({ kind: 'payment.settled', transaction })
        )
      : fetch;
  const pricedUrls = PRICED_AIRNODES.flatMap((name) => profiles.airnodes[name]?.url ?? []);
  // The budget refuses first, so a refused call costs nothing; then the source guard, then the payment
  const airnodeFetch = budgetedFetch(guardedFetch(payingFetch, sources, airnodeSourceOf(profiles.airnodes)), pricedUrls, budget);

  // The users whose rule names this agent's wallet, read from the vault; every write passes the budget first
  const vault = new GuardedVault(
    new ViemVault({
      address: vaultAddress,
      publicClient: publicClient as never,
      walletClient,
      profiles,
      watchlist,
      fromBlock: BigInt(deployment.deployedAtBlock),
      txTimeoutMs: Number(process.env.TX_TIMEOUT_MS || 90_000),
    }),
    budget
  );

  const twitter = profiles.airnodes.twitterapi;
  if (!twitter) throw new Error('shared/asset-profiles.json has no twitterapi Airnode');
  const pollIntervalSec = Number(process.env.POLL_INTERVAL_SEC || 60);
  const p1IntervalSec = Number(process.env.P1_INTERVAL_SEC || 30);
  const now = () => Math.floor(Date.now() / 1000);
  const fetchPrice = (asset: string) => {
    const profile = getAsset(profiles, asset);
    return fetchSignedResponse(priceAirnode(profiles, profile).url, priceRequest(profile), airnodeFetch);
  };
  const engine = new TriggerEngine({
    profiles,
    vault,
    classifier: guardedClassifier(classifier, sources),
    log,
    now,
    tweetAirnode: twitter.address,
    fetchLatestPost: (watched) => fetchSignedResponse(twitter.url, latestTweetRequest(watched), airnodeFetch),
    fetchPrice,
    p1IntervalSec,
  });
  const keeper = new SellKeeper({ profiles, vault, log, now, fetchPrice });

  log.append({
    kind: 'agent.started',
    mode: 'live',
    vault: `${vaultAddress} on ${chain.name}`,
    classifier: classifier.name,
    accounts: watchlist.map((watched) => watched.handle),
    restarts: Number(process.env.AGENT_RESTARTS || 0),
    // What this run ran with, for the run report. The RPC's host only: a provider URL carries its API key.
    settings: {
      chainId: chain.id,
      rpcHost: new URL(rpcUrl).host,
      cycleIntervalSec,
      pollIntervalSec,
      p1IntervalSec,
      txTimeoutMs: Number(process.env.TX_TIMEOUT_MS || 90_000),
      ausdBudgetPerDay: formatUnits(budgetSettings.ausdPerDay, AUSD_DECIMALS),
      ethBudgetPerDay: formatEther(budgetSettings.ethPerDay),
      minEth: formatEther(budgetSettings.minEth),
      minAusd: formatUnits(budgetSettings.minAusd, AUSD_DECIMALS),
      maxTxPerHour: budgetSettings.maxTxPerHour,
      savingAtPct: budgetSettings.savingAtPct,
      payer: payer ?? 'none',
      agent: account.address,
    },
  });

  // One cycle every CYCLE_INTERVAL_SEC: health, rules, Gate 2, keeper, then Gate 1 when a poll is due
  const cycles = new CycleRunner({
    log,
    engine,
    keeper,
    vault,
    watchlist,
    agent: account.address,
    health: budget,
    cycleIntervalSec,
    pollIntervalSec,
  });
  // Before the first cycle: the triggers a previous run left open go back on the Gate 2 list. A briefly unreachable RPC
  // gets three tries; after that the agent runs anyway and says so.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      engine.restorePending(await vault.listOpenTriggers(), await vault.listRules());
      break;
    } catch (error) {
      log.append({ kind: 'error', where: `recovering open triggers, try ${attempt} of 3`, message: (error as Error).message });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  cycles.start();
  const startedAt = Date.now();
  const restarts = Number(process.env.AGENT_RESTARTS || 0);
  const status = () =>
    buildStatus({
      cycles,
      budget,
      sources,
      agent: account.address,
      ...(payer ? { payer } : {}),
      startedAt,
      restarts,
      cycleIntervalSec,
      pollIntervalSec,
    });
  return { now, fetchPrice, cycles, budget, sources, status, stop: () => cycles.stop() };
};
