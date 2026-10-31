// Live mode: real accounts through the TwitterAPI.io Airnode, real signed prices, the deployed vault on Base Sepolia (or
// a local anvil). Keys come from agent/.env and never leave this process.
import { readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, type Hex, http, isAddress, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { createPayingFetch, fetchSignedResponse, readAusdBalance, withSettlementReporting } from './airnode/client.ts';
import { ViemVault } from './chain/viem-vault.ts';
import type { Classifier } from './classifier/types.ts';
import { Budget, budgetedFetch, GuardedVault, PRICED_AIRNODES, readBudgetSettings } from './engine/budget.ts';
import { CycleRunner } from './engine/cycle.ts';
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

export interface LiveOptions {
  profiles: Profiles;
  log: EventLog;
  classifier: Classifier;
}

export const startLive = async ({ profiles, log, classifier }: LiveOptions) => {
  const rpcUrl = requireEnv('RPC_URL');
  const chain = Number(process.env.CHAIN_ID ?? baseSepolia.id) === foundry.id ? foundry : baseSepolia;
  const account = privateKeyToAccount(requireKey('AGENT_PRIVATE_KEY'));

  // Written by contracts/script/Deploy.s.sol
  const deployment = readJson<{ vault: Address; deployedAtBlock: number }>(
    new URL(`../../shared/deployments/${chain.id}.json`, import.meta.url)
  );
  const vaultAddress = process.env.VAULT_ADDRESS ?? deployment.vault;
  if (!isAddress(vaultAddress)) throw new Error('VAULT_ADDRESS is not an address');
  const watchlist = loadWatchlist();

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  // The agent's own money: the payer's aUSD for data and the agent wallet's ETH for gas, within daily budgets
  const payerKey = process.env.PAYER_PRIVATE_KEY;
  const payer = payerKey && isHex(payerKey) ? privateKeyToAccount(payerKey).address : undefined;
  const ausdClient =
    chain.id === baseSepolia.id
      ? publicClient
      : createPublicClient({ chain: baseSepolia, transport: http(process.env.AUSD_RPC_URL || 'https://sepolia.base.org') });
  const budget = new Budget({
    settings: readBudgetSettings(),
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
  const airnodeFetch = budgetedFetch(payingFetch, pricedUrls, budget);

  // The users whose rule names this agent's wallet, read from the vault; every write passes the budget first
  const vault = new GuardedVault(
    new ViemVault({
      address: vaultAddress,
      publicClient: publicClient as never,
      walletClient,
      profiles,
      watchlist,
      fromBlock: BigInt(deployment.deployedAtBlock),
    }),
    budget
  );

  const twitter = profiles.airnodes.twitterapi;
  if (!twitter) throw new Error('shared/asset-profiles.json has no twitterapi Airnode');
  const cycleIntervalSec = Number(process.env.CYCLE_INTERVAL_SEC || 30);
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
    classifier,
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
  cycles.start();
  return { now, fetchPrice, cycles, budget, stop: () => cycles.stop() };
};
