// Talks to Person A's deployed Vault. Rules come from the chain: the users whose latest RuleSet names this agent's
// wallet, with their topics from that event. Every write is simulated first, so a revert surfaces with the vault's
// custom error name before any gas is spent.
import {
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type GetContractEventsReturnType,
  type Hash,
  type Hex,
  isAddressEqual,
  keccak256,
  type Log,
  parseEventLogs,
  type PublicClient,
  toHex,
  type Transport,
  WaitForTransactionReceiptTimeoutError,
  type WalletClient,
} from 'viem';
import { deriveRequestHash, type SignedResponse } from '../airnode/attestation.ts';
import type { Profiles } from '../profiles.ts';
import { latestTweetRequest, type WatchedAccount } from '../sources/twitter.ts';
import { vaultAbi } from './vault-abi.ts';
import {
  type Bought,
  type Expired,
  type OpenedTrigger,
  type OpenTriggerInput,
  type OpenTriggerRecord,
  type Position,
  type Rule,
  type SellKind,
  type Sold,
  TxTimeout,
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

// IVault.TriggerStatus: None, Open, Confirmed, Expired
const TRIGGER_OPEN = 1;

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

// The vault's own checks on a price response. Anyone may ask and nothing moves, so this needs no wallet; a refusal comes
// back as a VaultRejection, like a write's.
export const checkPrice = async (publicClient: PublicClient, address: Address, asset: string, response: SignedResponse) => {
  try {
    const [price, priceTime] = await publicClient.readContract({
      address,
      abi: vaultAbi,
      functionName: 'checkPrice',
      args: [assetIdOf(asset), toVaultResponse(response)],
    });
    return { price, priceTime };
  } catch (error) {
    const name = revertName(error);
    if (name) throw new VaultRejection(name);
    throw error;
  }
};

type EventName = 'TriggerOpened' | 'TriggerConfirmed' | 'PositionSold' | 'TriggerExpired' | 'RuleSet';

// The events the agent scans, each read once per block range and cached
type ScannedEvent = 'RuleSet' | 'TriggerConfirmed' | 'TriggerOpened';

// Blocks per getLogs request; a provider that refuses the range gets half as many, down to one
const LOG_CHUNK_BLOCKS = 2000n;

// A provider's way of saying the block range or the result is too large, as opposed to an outage or a rate limit
export const isRangeTooLarge = (error: unknown) => {
  const text = error instanceof BaseError ? `${error.shortMessage} ${error.details}` : String(error);
  return /block range|range (is )?too (large|wide|big)|limited to (a )?\d+|exceeds? (the )?max|response size|more than \d+ (results|logs)/i.test(text);
};

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
  // How long a sent transaction may take to be mined before the agent gives up on it for this cycle
  txTimeoutMs?: number;
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
  // Each scanned event's logs so far, and the last block they cover
  private readonly logs = new Map<ScannedEvent, { toBlock: bigint; events: unknown[] }>();
  // Positions of other agents' users, so they are not read again on every call
  private readonly foreignPositions = new Set<string>();

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

  // The vault's `eventName` logs from the deployment block to the chain head. Each call fetches only the blocks after the
  // last call's, in chunks; a failed chunk keeps what came before it, so the next call resumes there.
  private async scan<Name extends ScannedEvent>(
    eventName: Name
  ): Promise<GetContractEventsReturnType<typeof vaultAbi, Name>> {
    const { publicClient, address, fromBlock = 0n } = this.options;
    const cached = this.logs.get(eventName) ?? { toBlock: fromBlock - 1n, events: [] };
    this.logs.set(eventName, cached);
    // Uncached: viem keeps a block number for seconds, and a scan that stops at a stale head misses a log just mined
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    let span = LOG_CHUNK_BLOCKS;
    while (cached.toBlock < head) {
      const start = cached.toBlock + 1n;
      const end = start + span - 1n < head ? start + span - 1n : head;
      try {
        const chunk = await publicClient.getContractEvents({ address, abi: vaultAbi, eventName, fromBlock: start, toBlock: end });
        cached.events.push(...chunk);
        cached.toBlock = end;
      } catch (error) {
        if (!isRangeTooLarge(error) || span === 1n) throw error;
        span /= 2n;
      }
    }
    return cached.events as GetContractEventsReturnType<typeof vaultAbi, Name>;
  }

  async listRules(): Promise<Rule[]> {
    const now = Date.now() / 1000;
    if (this.rules && now - this.rules.at < (this.options.cacheSec ?? 30)) return this.rules.rules;
    const { publicClient, address } = this.options;
    const events = await this.scan('RuleSet');
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

  // Open positions of this agent's users, from TriggerConfirmed, so a restart forgets none and a buy confirmed by someone
  // else is found too; then each open one's status is refreshed
  async listPositions(): Promise<Position[]> {
    const { publicClient, address } = this.options;
    const confirmed = await this.scan('TriggerConfirmed');
    const unseen = confirmed.flatMap((event) => {
      const id = event.args.positionId?.toString();
      return id && !this.positions.has(id) && !this.foreignPositions.has(id) ? [id] : [];
    });
    if (unseen.length > 0) {
      const users = new Set((await this.listRules()).map((rule) => rule.id.toLowerCase()));
      for (const id of unseen) {
        await this.loadPosition(id, users);
        if (!this.positions.has(id)) this.foreignPositions.add(id);
      }
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

  // The triggers of this agent's users that are still open, from TriggerOpened and each trigger's status
  async listOpenTriggers(): Promise<OpenTriggerRecord[]> {
    const { publicClient, address } = this.options;
    const users = new Set((await this.listRules()).map((rule) => rule.id.toLowerCase()));
    const opened = await this.scan('TriggerOpened');
    const open: OpenTriggerRecord[] = [];
    for (const event of opened) {
      const { triggerId, user, assetId, p0, t0 } = event.args;
      if (triggerId === undefined || !user || !assetId || p0 === undefined || t0 === undefined) continue;
      const asset = this.assetKey(assetId);
      if (!asset || !users.has(user.toLowerCase())) continue;
      const trigger = await publicClient.readContract({ address, abi: vaultAbi, functionName: 'getTrigger', args: [triggerId] });
      if (trigger.status === TRIGGER_OPEN) open.push({ triggerId: triggerId.toString(), ruleId: user, asset, p0, t0: Number(t0) });
    }
    return open;
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

  // A dropped transaction must not hang the agent: viem's own timeout, and a timer of ours in case the client never answers
  private async waitForReceipt(hash: Hash) {
    const { publicClient, txTimeoutMs = 90_000 } = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TxTimeout(hash, txTimeoutMs)), txTimeoutMs);
    });
    try {
      return await Promise.race([publicClient.waitForTransactionReceipt({ hash, timeout: txTimeoutMs }), timeout]);
    } catch (error) {
      if (error instanceof WaitForTransactionReceiptTimeoutError) throw new TxTimeout(hash, txTimeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(
    functionName: 'openTrigger' | 'confirmTrigger' | 'expireTrigger' | 'sell',
    args: readonly unknown[]
  ): Promise<{ hash: Hash; logs: Log[]; gasWei?: bigint }> {
    const { publicClient, walletClient, address } = this.options;
    try {
      const { request } = await publicClient.simulateContract({
        address,
        abi: vaultAbi,
        functionName,
        args: args as never,
        account: walletClient.account,
      });
      // The request's ABI holds only this function; the whole ABI names a revert that first shows up at send time
      const hash = await walletClient.writeContract({ ...request, abi: vaultAbi } as never);
      const receipt = await this.waitForReceipt(hash);
      if (receipt.status !== 'success') throw new VaultRejection('Reverted', hash);
      const { gasUsed, effectiveGasPrice } = receipt;
      return {
        hash,
        logs: receipt.logs,
        ...(gasUsed !== undefined && effectiveGasPrice !== undefined ? { gasWei: gasUsed * effectiveGasPrice } : {}),
      };
    } catch (error) {
      if (error instanceof VaultRejection || error instanceof TxTimeout) throw error;
      // Only a revert is the vault saying no; any other failure passes through, so the caller can try again
      const name = revertName(error);
      if (name) throw new VaultRejection(name);
      throw error;
    }
  }

  async openTrigger({ ruleId, asset, post, p0 }: OpenTriggerInput): Promise<OpenedTrigger> {
    const { hash, logs, gasWei } = await this.send('openTrigger', [
      ruleId,
      assetIdOf(asset),
      toVaultResponse(post),
      toVaultResponse(p0),
    ]);
    return { triggerId: readEvent(logs, 'TriggerOpened').args.triggerId.toString(), txHash: hash, gasWei };
  }

  async confirmTrigger(triggerId: string, p1: SignedResponse): Promise<Bought> {
    const { hash, logs, gasWei } = await this.send('confirmTrigger', [BigInt(triggerId), toVaultResponse(p1)]);
    const { args } = readEvent(logs, 'TriggerConfirmed');
    const positionId = args.positionId.toString();
    await this.loadPosition(positionId);
    return { triggerId, positionId, usdcIn: args.quoteIn, assetOut: args.assetOut, price: args.p1, txHash: hash, gasWei };
  }

  async expireTrigger(triggerId: string): Promise<Expired> {
    const { hash, gasWei } = await this.send('expireTrigger', [BigInt(triggerId)]);
    return { txHash: hash, gasWei };
  }

  async sell(positionId: string, kind: SellKind, price: SignedResponse): Promise<Sold> {
    const reason = SELL_REASONS[kind];
    if (reason === undefined) throw new VaultRejection('SellKindNotSupported', kind);
    const { hash, logs, gasWei } = await this.send('sell', [BigInt(positionId), reason, toVaultResponse(price)]);
    const { args } = readEvent(logs, 'PositionSold');
    const position = this.positions.get(positionId);
    if (position) position.open = false;
    return { positionId, usdcOut: args.quoteOut, price: args.price, txHash: hash, gasWei };
  }
}
