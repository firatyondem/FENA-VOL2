// Talks to Person A's deployed Vault. Rules come from the chain: the users whose latest RuleSet names this agent's
// wallet, with their topics from that event. Every write is simulated first, so a revert surfaces with the vault's
// custom error name before any gas is spent.
import {
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hash,
  type Hex,
  isAddressEqual,
  keccak256,
  type Log,
  parseEventLogs,
  type PublicClient,
  toHex,
  type Transport,
  type WalletClient,
} from 'viem';
import { deriveRequestHash, type SignedResponse } from '../airnode/attestation.ts';
import type { Profiles } from '../profiles.ts';
import { latestTweetRequest, type WatchedAccount } from '../sources/twitter.ts';
import { vaultAbi } from './vault-abi.ts';
import {
  type Bought,
  type OpenedTrigger,
  type OpenTriggerInput,
  type Position,
  type Rule,
  type SellKind,
  type Sold,
  VaultRejection,
  type VaultPort,
} from './vault.ts';

// The asset id the vault and the deploy script use: keccak256 of the asset's key, such as "OIL"
export const assetIdOf = (key: string): Hex => keccak256(toHex(key));

// IVault.SignedResponse: the vault checks the request hash against its own storage, then the signature over it
export const toVaultResponse = ({ requestHash, timestamp, data, signature }: SignedResponse) => ({
  requestHash,
  timestamp: BigInt(timestamp),
  data: toHex(data),
  signature,
});

const SELL_REASONS: Partial<Record<SellKind, number>> = { manual: 0, 'take-profit': 1, stagnation: 2 };

// The custom error name when `error` is a revert, so the vault refused; undefined for anything else, such as an RPC that
// did not answer, which says nothing about the request.
export const revertName = (error: unknown): string | undefined => {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  return revert.data?.errorName ?? revert.reason ?? revert.signature ?? 'Reverted';
};

// The custom error name of a revert, or the message when the error is not a revert.
export const revertReason = (error: unknown): string =>
  revertName(error) ??
  (error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error));

type EventName = 'TriggerOpened' | 'TriggerConfirmed' | 'PositionSold' | 'TriggerExpired' | 'RuleSet';

export const readEvent = <Name extends EventName>(logs: Log[], eventName: Name) => {
  const [event] = parseEventLogs({ abi: vaultAbi, logs, eventName });
  if (!event) throw new Error(`The transaction emitted no ${eventName}`);
  return event;
};

export interface ViemVaultOptions {
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  profiles: Profiles;
  // Accounts the agent can read, which name the vault's watched-account request hashes
  watchlist: WatchedAccount[];
  // The vault's deployment block, where the event scans start
  fromBlock?: bigint;
  // Seconds a rule read stays fresh
  cacheSec?: number;
}

export class ViemVault implements VaultPort {
  readonly kind = 'onchain';
  // Only the owner sells by hand, so the agent's keeper takes profit and exits stagnation; the vault has no stop loss
  readonly keeperSellKinds: readonly SellKind[] = ['take-profit', 'stagnation'];
  private readonly options: ViemVaultOptions;
  private readonly assetKeys: Map<string, string>;
  private readonly accountHandles: Map<string, WatchedAccount>;
  private readonly positions = new Map<string, Position>();
  private rules: { at: number; rules: Rule[] } | undefined;
  private positionsScanned = false;

  constructor(options: ViemVaultOptions) {
    this.options = options;
    this.assetKeys = new Map(Object.keys(options.profiles.assets).map((key) => [assetIdOf(key).toLowerCase(), key]));
    this.accountHandles = new Map(
      options.watchlist.map((account) => [deriveRequestHash(latestTweetRequest(account)).toLowerCase(), account])
    );
  }

  private get agent(): Address {
    return this.options.walletClient.account.address;
  }

  private assetKey(assetId: Hex) {
    return this.assetKeys.get(assetId.toLowerCase());
  }

  async listRules(): Promise<Rule[]> {
    const now = Date.now() / 1000;
    if (this.rules && now - this.rules.at < (this.options.cacheSec ?? 30)) return this.rules.rules;
    const { publicClient, address, fromBlock = 0n } = this.options;
    const events = await publicClient.getContractEvents({ address, abi: vaultAbi, eventName: 'RuleSet', fromBlock });
    // setRule replaces a rule, so each user's latest RuleSet is the rule in force
    const latest = new Map<Address, (typeof events)[number]>();
    for (const event of events) if (event.args.user) latest.set(event.args.user, event);

    const rules: Rule[] = [];
    for (const [user, event] of latest) {
      const { rule, assetIds = [], assetRules = [], assetTopics = [], watchedAccounts = [] } = event.args;
      if (!rule || !isAddressEqual(rule.agent, this.agent)) continue;
      const assets = assetIds.flatMap((assetId, index) => {
        const key = this.assetKey(assetId);
        const assetRule = assetRules[index];
        if (!key || !assetRule) return [];
        return [
          {
            asset: key,
            budgetShareBps: assetRule.budgetShareBps,
            trendThresholdBps: assetRule.thresholdBps,
            spikeCapBps: assetRule.spikeCapBps,
            minWaitSec: assetRule.minWait,
            maxWindowSec: assetRule.maxWindow,
            cooldownSec: assetRule.cooldown,
            takeProfitBps: assetRule.takeProfitBps,
            stagnationBandBps: assetRule.stagnationBandBps,
            stagnationAfterSec: assetRule.stagnationDelay,
          },
        ];
      });
      const ruleKeys = assets.map((asset) => asset.asset);
      const accounts: Record<string, string[]> = {};
      for (const account of watchedAccounts) {
        const watched = this.accountHandles.get(account.toLowerCase());
        if (watched) accounts[watched.handle] = ruleKeys.filter((key) => watched.assets.includes(key));
      }
      const topics: Record<string, string[]> = {};
      assetIds.forEach((assetId, index) => {
        const key = this.assetKey(assetId);
        const words = (assetTopics[index] ?? '').split(',').map((topic) => topic.trim()).filter(Boolean);
        if (key && words.length > 0) topics[key] = words;
      });
      const paused = await publicClient.readContract({ address, abi: vaultAbi, functionName: 'isPaused', args: [user] });
      rules.push({
        id: user,
        owner: user,
        agent: rule.agent,
        paused,
        buyAmount: rule.buyAmount,
        maxPerTrade: rule.maxPerTrade,
        dailyLimit: rule.dailyLimit,
        accounts,
        assets,
        topics,
      });
    }
    this.rules = { at: now, rules };
    return rules;
  }

  // Open positions of this agent's users: found once from TriggerConfirmed, so a restart forgets none, then refreshed
  async listPositions(): Promise<Position[]> {
    const { publicClient, address, fromBlock = 0n } = this.options;
    if (!this.positionsScanned) {
      const users = new Set((await this.listRules()).map((rule) => rule.id.toLowerCase()));
      const confirmed = await publicClient.getContractEvents({
        address,
        abi: vaultAbi,
        eventName: 'TriggerConfirmed',
        fromBlock,
      });
      for (const event of confirmed) {
        const id = event.args.positionId;
        if (id !== undefined) await this.loadPosition(id.toString(), users);
      }
      this.positionsScanned = true;
    }
    for (const position of this.positions.values()) {
      if (!position.open) continue;
      const onChain = await publicClient.readContract({
        address,
        abi: vaultAbi,
        functionName: 'getPosition',
        args: [BigInt(position.id)],
      });
      position.open = onChain.isOpen;
    }
    return [...this.positions.values()];
  }

  private async loadPosition(id: string, users?: Set<string>) {
    const { publicClient, address } = this.options;
    const position = await publicClient.readContract({ address, abi: vaultAbi, functionName: 'getPosition', args: [BigInt(id)] });
    const key = this.assetKey(position.assetId);
    if (!key || (users && !users.has(position.user.toLowerCase()))) return;
    this.positions.set(id, {
      id,
      ruleId: position.user,
      asset: key,
      amount: position.amount,
      entryPrice: position.entryPrice,
      entryTime: Number(position.openedAt),
      open: position.isOpen,
    });
  }

  private async send(
    functionName: 'openTrigger' | 'confirmTrigger' | 'expireTrigger' | 'sell',
    args: readonly unknown[]
  ): Promise<{ hash: Hash; logs: Log[] }> {
    const { publicClient, walletClient, address } = this.options;
    try {
      const { request } = await publicClient.simulateContract({
        address,
        abi: vaultAbi,
        functionName,
        args: args as never,
        account: walletClient.account,
      });
      const hash = await walletClient.writeContract(request as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new VaultRejection('Reverted', hash);
      return { hash, logs: receipt.logs };
    } catch (error) {
      if (error instanceof VaultRejection) throw error;
      // Only a revert is the vault saying no; any other failure passes through, so the caller can try again
      const name = revertName(error);
      if (name) throw new VaultRejection(name);
      throw error;
    }
  }

  async openTrigger({ ruleId, asset, post, p0 }: OpenTriggerInput): Promise<OpenedTrigger> {
    const { hash, logs } = await this.send('openTrigger', [
      ruleId,
      assetIdOf(asset),
      toVaultResponse(post),
      toVaultResponse(p0),
    ]);
    return { triggerId: readEvent(logs, 'TriggerOpened').args.triggerId.toString(), txHash: hash };
  }

  async confirmTrigger(triggerId: string, p1: SignedResponse): Promise<Bought> {
    const { hash, logs } = await this.send('confirmTrigger', [BigInt(triggerId), toVaultResponse(p1)]);
    const { args } = readEvent(logs, 'TriggerConfirmed');
    const positionId = args.positionId.toString();
    await this.loadPosition(positionId);
    return { triggerId, positionId, usdcIn: args.quoteIn, assetOut: args.assetOut, price: args.p1, txHash: hash };
  }

  async expireTrigger(triggerId: string): Promise<void> {
    await this.send('expireTrigger', [BigInt(triggerId)]);
  }

  async sell(positionId: string, kind: SellKind, price: SignedResponse): Promise<Sold> {
    const reason = SELL_REASONS[kind];
    if (reason === undefined) throw new VaultRejection('SellKindNotSupported', kind);
    const { hash, logs } = await this.send('sell', [BigInt(positionId), reason, toVaultResponse(price)]);
    const { args } = readEvent(logs, 'PositionSold');
    const position = this.positions.get(positionId);
    if (position) position.open = false;
    return { positionId, usdcOut: args.quoteOut, price: args.price, txHash: hash };
  }
}
