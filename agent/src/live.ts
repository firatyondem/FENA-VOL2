// Live mode: real accounts through the TwitterAPI.io Airnode, real signed prices, the deployed vault on Base Sepolia (or
// a local anvil). Keys come from agent/.env and never leave this process.
import { readFileSync } from 'node:fs';
import { type Address, createPublicClient, createWalletClient, type Hex, http, isAddress, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import { createPayingFetch, fetchSignedResponse, withSettlementReporting } from './airnode/client.ts';
import { ViemVault } from './chain/viem-vault.ts';
import type { Classifier } from './classifier/types.ts';
import { SellKeeper } from './engine/keeper.ts';
import { TriggerEngine } from './engine/trigger-engine.ts';
import type { EventLog } from './log.ts';
import { getAsset, priceAirnode, priceRequest, type Profiles } from './profiles.ts';
import { latestTweetRequest, type WatchedAccount } from './sources/twitter.ts';

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
  const watchlist = readJson<WatchedAccount[]>(new URL('../config/watchlist.json', import.meta.url));
  if (process.env.DEMO_X_HANDLE) {
    // Our own account for the live stage post, linked like Trump's (spec: our demo account)
    watchlist.push({ handle: process.env.DEMO_X_HANDLE, label: 'Demo account', assets: ['OIL', 'BTC', 'ETH'], pinned: false });
  }

  const payerKey = process.env.PAYER_PRIVATE_KEY;
  const airnodeFetch: typeof fetch =
    payerKey && isHex(payerKey)
      ? withSettlementReporting(createPayingFetch(payerKey), (transaction) =>
          log.append({ kind: 'payment.settled', transaction })
        )
      : fetch;

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });
  // The users whose rule names this agent's wallet, read from the vault
  const vault = new ViemVault({
    address: vaultAddress,
    publicClient: publicClient as never,
    walletClient,
    profiles,
    watchlist,
    fromBlock: BigInt(deployment.deployedAtBlock),
  });

  const twitter = profiles.airnodes.twitterapi;
  if (!twitter) throw new Error('shared/asset-profiles.json has no twitterapi Airnode');
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
  });
  const keeper = new SellKeeper({ profiles, vault, log, now, fetchPrice });

  log.append({
    kind: 'agent.started',
    mode: 'live',
    vault: `${vaultAddress} on ${chain.name}`,
    classifier: classifier.name,
    accounts: watchlist.map((watched) => watched.handle),
  });

  const pollEverySec = Number(process.env.POLL_INTERVAL_SEC ?? 60);
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const watched of watchlist) await engine.pollAccount(watched);
    } finally {
      polling = false;
    }
  };
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await engine.checkPending();
      await keeper.tick();
    } catch (error) {
      log.append({ kind: 'error', where: 'tick', message: (error as Error).message });
    } finally {
      ticking = false;
    }
  };
  await poll();
  const timers = [setInterval(poll, pollEverySec * 1000), setInterval(tick, 5000)];
  return { now, fetchPrice, stop: () => timers.forEach(clearInterval) };
};
