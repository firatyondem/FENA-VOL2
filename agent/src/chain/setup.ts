// Funds a user's vault balance and sets their rule, as the rule setup page will. Used by `npm run set-rule` for the
// stage demo and by the end-to-end test.
import {
  type Account,
  type Address,
  type Chain,
  type Hash,
  parseUnits,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { deriveRequestHash } from '../airnode/attestation.ts';
import { latestTweetRequest, type WatchedAccount } from '../sources/twitter.ts';
import { mockUsdcAbi, vaultAbi } from './vault-abi.ts';
import { assetIdOf } from './viem-vault.ts';

export interface RuleConfig {
  depositUsdc: number;
  buyAmountUsdc: number;
  maxPerTradeUsdc: number;
  dailyLimitUsdc: number;
  // Handles from the watchlist
  accounts: string[];
  assets: {
    asset: string;
    budgetShareBps: number;
    trendThresholdBps: number;
    spikeCapBps: number;
    minWaitSec: number;
    maxWindowSec: number;
    cooldownSec: number;
    takeProfitBps: number;
    stagnationBandBps: number;
    stagnationAfterSec: number;
    topics: string[];
  }[];
}

// IVault.setRule's arguments for a rule config
export const setRuleArgs = (config: RuleConfig, agent: Address, watchlist: WatchedAccount[]) => {
  const usdc = (amount: number) => parseUnits(String(amount), 6);
  const accounts = config.accounts.map((handle) => {
    const watched = watchlist.find((account) => account.handle === handle);
    if (!watched) throw new Error(`@${handle} is not in the watchlist`);
    return deriveRequestHash(latestTweetRequest(watched));
  });
  return [
    { agent, buyAmount: usdc(config.buyAmountUsdc), maxPerTrade: usdc(config.maxPerTradeUsdc), dailyLimit: usdc(config.dailyLimitUsdc) },
    config.assets.map((asset) => assetIdOf(asset.asset)),
    config.assets.map((asset) => ({
      thresholdBps: asset.trendThresholdBps,
      spikeCapBps: asset.spikeCapBps,
      minWait: asset.minWaitSec,
      maxWindow: asset.maxWindowSec,
      cooldown: asset.cooldownSec,
      budgetShareBps: asset.budgetShareBps,
      takeProfitBps: asset.takeProfitBps,
      stagnationBandBps: asset.stagnationBandBps,
      stagnationDelay: asset.stagnationAfterSec,
    })),
    config.assets.map((asset) => asset.topics.join(', ')),
    accounts,
  ] as const;
};

export interface ApplyRuleOptions {
  publicClient: PublicClient;
  // The user's wallet
  walletClient: WalletClient<Transport, Chain, Account>;
  vault: Address;
  usdc: Address;
  agent: Address;
  config: RuleConfig;
  watchlist: WatchedAccount[];
}

// Mints the deposit from the mock USDC faucet, deposits it and sets the rule, waiting for each transaction.
export const applyRule = async ({ publicClient, walletClient, vault, usdc, agent, config, watchlist }: ApplyRuleOptions) => {
  const user = walletClient.account.address;
  const deposit = parseUnits(String(config.depositUsdc), 6);
  const hashes: Hash[] = [];
  const send = async (request: Parameters<typeof walletClient.writeContract>[0]) => {
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    hashes.push(hash);
  };
  const simulate = async (params: Parameters<typeof publicClient.simulateContract>[0]) =>
    (await publicClient.simulateContract({ ...params, account: walletClient.account } as never)).request as never;

  await send(await simulate({ address: usdc, abi: mockUsdcAbi, functionName: 'mint', args: [user, deposit] } as never));
  await send(await simulate({ address: usdc, abi: mockUsdcAbi, functionName: 'approve', args: [vault, deposit] } as never));
  await send(await simulate({ address: vault, abi: vaultAbi, functionName: 'deposit', args: [deposit] } as never));
  await send(
    await simulate({
      address: vault,
      abi: vaultAbi,
      functionName: 'setRule',
      args: setRuleArgs(config, agent, watchlist),
    } as never)
  );
  return hashes;
};
