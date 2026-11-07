// Live mode: real accounts through a post provider (GetXAPI or TwitterAPI.io), Pyth prices from Hermes, the deployed
// vault on Base Sepolia (or a local anvil). Keys come from the environment and never leave this process.
import { readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, formatEther, type Hex, http, isAddress, isHex, parseEther, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { Faucet } from './chain/faucet.ts';
import { updateFee, ViemVault } from './chain/viem-vault.ts';
import type { Classifier } from './classifier/types.ts';
import { Budget, budgetedFetch, GuardedVault, readBudgetSettings } from './engine/budget.ts';
import { ledgerRecorder } from './engine/costs.ts';
import { CycleRunner } from './engine/cycle.ts';
import { readPollSchedule } from './engine/poll-schedule.ts';
import { guardedClassifier, guardedFetch, SourceGuard } from './engine/sources.ts';
import { buildStatus } from './engine/status.ts';
import { SellKeeper } from './engine/keeper.ts';
import { TriggerEngine } from './engine/trigger-engine.ts';
import type { EventLog } from './log.ts';
import { getAsset, type Profiles, readPythPrice } from './profiles.ts';
import { DEFAULT_HERMES_URL, HermesClient } from './pyth/hermes.ts';
import { HermesPriceSource } from './pyth/price-source.ts';
import { GETXAPI_URL, GetXApiSource } from './sources/getxapi.ts';
import type { PostSource } from './sources/posts.ts';
import { TWITTERAPI_IO_URL, TwitterApiIoSource } from './sources/twitterapi-io.ts';
import { loadWatchlist } from './sources/watchlist.ts';
import type { Db } from './store/db.ts';
import { DecisionLog } from './store/decisions.ts';
import { CostLedger } from './store/ledger.ts';
import { PollStateStore } from './store/poll-state.ts';

const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for live mode (see agent/.env.example)`);
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

// GetXAPI bills per call, TwitterAPI.io per post returned: POST_SOURCE picks one, and its key must be set
export const createPostSource = (env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): { source: PostSource; baseUrl: string } => {
  const name = env.POST_SOURCE || 'getxapi';
  if (name === 'getxapi') {
    return { source: new GetXApiSource({ apiKey: requireEnv('GETXAPI_KEY'), fetch: fetchImpl }), baseUrl: GETXAPI_URL };
  }
  if (name === 'twitterapi.io') {
    return { source: new TwitterApiIoSource({ apiKey: requireEnv('TWITTERAPI_IO_KEY'), fetch: fetchImpl }), baseUrl: TWITTERAPI_IO_URL };
  }
  throw new Error(`POST_SOURCE must be getxapi or twitterapi.io, not ${name}`);
};

export interface LiveOptions {
  profiles: Profiles;
  log: EventLog;
  classifier: Classifier;
  db: Db;
  version: string;
}

export const startLive = async ({ profiles, log, classifier, db, version }: LiveOptions) => {
  installCrashHandlers(log);
  const rpcUrl = requireEnv('RPC_URL');
  const chain = Number(process.env.CHAIN_ID || baseSepolia.id) === foundry.id ? foundry : baseSepolia;
  const account = privateKeyToAccount(requireKey('AGENT_PRIVATE_KEY'));

  // Written by contracts/script/Deploy.s.sol
  const deployment = readJson<{ vault: Address; usdc: Address; deployedAtBlock: number; scanFromBlock?: number }>(
    new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url)
  );
  // An empty line in .env counts as unset here and below, as it does in .env.example
  const vaultAddress = process.env.VAULT_ADDRESS || deployment.vault;
  if (!isAddress(vaultAddress)) throw new Error('VAULT_ADDRESS is not an address');
  const watchlist = loadWatchlist();

  // A source that keeps failing (the post provider, Hermes, the RPC, the classifier) is skipped for a while
  const cycleIntervalSec = Number(process.env.CYCLE_INTERVAL_SEC || 30);
  const sources = new SourceGuard({ log, cycleIntervalSec });
  const rpcFetch = guardedFetch(fetch, sources, () => 'rpc');
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { fetchFn: rpcFetch }) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl, { fetchFn: rpcFetch }), account });

  const ledger = new CostLedger(db);
  const decisions = new DecisionLog(db);
  const pollState = new PollStateStore(db);

  // The agent's own money: USD for data from the ledger, the agent wallet's ETH for gas and Pyth's fees
  const budgetSettings = readBudgetSettings();
  const budget = new Budget({
    settings: budgetSettings,
    log,
    readBalances: async () => ({ eth: await publicClient.getBalance({ address: account.address }) }),
    dataSpentToday: () => ledger.usdToday(),
  });

  const hermesUrl = process.env.HERMES_URL || profiles.pyth.hermesUrl || DEFAULT_HERMES_URL;
  const hermes = new HermesClient({
    baseUrl: hermesUrl,
    ...(process.env.PYTH_API_KEY ? { apiKey: process.env.PYTH_API_KEY } : {}),
    fetch: guardedFetch(fetch, sources, () => 'hermes'),
  });
  const prices = new HermesPriceSource(profiles, hermes);
  // The budget refuses a paid post call first, so a refused call costs nothing; then the source guard
  const postFetch: typeof fetch = (input, init) =>
    budgetedFetch(guardedFetch(fetch, sources, () => 'posts'), [GETXAPI_URL, TWITTERAPI_IO_URL], budget)(input, init);
  const { source: posts } = createPostSource(process.env, postFetch);

  // Gas and Pyth's fees in USD at the ETH price, so the ledger shows what a run on mainnet would cost
  let ethUsd: number | undefined;
  const refreshEthUsd = async () => {
    try {
      ethUsd = Number(readPythPrice(getAsset(profiles, 'ETH'), await prices.latest('ETH')).price) / 1e18;
    } catch {
      // keeps the last price
    }
  };
  void refreshEthUsd();
  setInterval(refreshEthUsd, 10 * 60_000).unref();
  const costs = ledgerRecorder({ ledger, ethUsd: () => ethUsd, chain: chain.name.toLowerCase().replace(/\s+/g, '-'), log });

  // The users whose rule names this agent's wallet, read from the vault; every write passes the budget first
  const viemVault = new ViemVault({
    address: vaultAddress,
    publicClient: publicClient as never,
    walletClient,
    profiles,
    watchlist,
    fromBlock: BigInt(deployment.scanFromBlock ?? deployment.deployedAtBlock),
    txTimeoutMs: Number(process.env.TX_TIMEOUT_MS || 90_000),
  });
  const vault = new GuardedVault(viemVault, budget);

  const schedule = readPollSchedule();
  const p1IntervalSec = Number(process.env.P1_INTERVAL_SEC || 30);
  const now = () => Math.floor(Date.now() / 1000);
  const engine = new TriggerEngine({
    profiles,
    vault,
    classifier: guardedClassifier(classifier, sources),
    posts,
    prices,
    log,
    now,
    p1IntervalSec,
    decisions,
    costs,
    pollState,
  });
  const keeper = new SellKeeper({ profiles, vault, log, now, prices, costs });

  const faucetKey = process.env.FAUCET_PRIVATE_KEY;
  const faucet =
    faucetKey && isHex(faucetKey)
      ? new Faucet({
          db,
          publicClient: publicClient as never,
          walletClient: createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(faucetKey) }),
          usdc: deployment.usdc,
          settings: {
            ethPerDrip: parseEther(process.env.FAUCET_ETH || '0.0005'),
            usdcPerDrip: parseUnits(process.env.FAUCET_USDC || '1000', 6),
            maxDripsPerDay: Number(process.env.FAUCET_MAX_PER_DAY || 50),
            minFaucetEth: parseEther(process.env.FAUCET_MIN_ETH || '0.002'),
          },
        })
      : undefined;

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
      postSource: posts.name,
      hermesHost: new URL(hermesUrl).host,
      cycleIntervalSec,
      pollActiveSec: schedule.activeSec,
      pollQuietSec: schedule.quietSec,
      pollIdleSec: schedule.idleSec,
      p1IntervalSec,
      txTimeoutMs: Number(process.env.TX_TIMEOUT_MS || 90_000),
      dataUsdPerDay: budgetSettings.dataUsdPerDay,
      ethBudgetPerDay: formatEther(budgetSettings.ethPerDay),
      minEth: formatEther(budgetSettings.minEth),
      maxTxPerHour: budgetSettings.maxTxPerHour,
      savingAtPct: budgetSettings.savingAtPct,
      agent: account.address,
      faucet: faucet ? 'on' : 'off',
    },
  });

  // One cycle every CYCLE_INTERVAL_SEC: health, rules, Gate 2, keeper, then Gate 1 for each account whose poll is due
  const cycles = new CycleRunner({
    log,
    engine,
    keeper,
    vault,
    watchlist,
    agent: account.address,
    health: budget,
    cycleIntervalSec,
    schedule,
    activityOf: (handle) => pollState.get(handle),
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
      postSource: posts.name,
      classifier: classifier.name,
      startedAt,
      restarts,
      cycleIntervalSec,
      pollIntervalSec: schedule.activeSec,
    });
  // Healthy while cycles keep finishing; the last poll is the newest of any account
  const health = () => {
    const last = cycles.status().lastCycle;
    const lastFinished = last ? last.startedAt + last.durationMs : startedAt;
    const lastPollAt = Math.max(0, ...watchlist.map((watched) => pollState.get(watched.handle).lastPollAt ?? 0));
    return {
      ok: Date.now() - lastFinished < cycleIntervalSec * 1000 * 4,
      lastPollAt: lastPollAt || null,
      version,
      mode: budget.mode,
    };
  };
  return {
    now,
    prices,
    fee: (update: Parameters<typeof updateFee>[2]) => updateFee(publicClient as never, vaultAddress as Address, update),
    cycles,
    budget,
    sources,
    status,
    health,
    ledger,
    decisions,
    faucet,
    stop: () => cycles.stop(),
  };
};
