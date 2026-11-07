// The agent's view of the vault. The vault decides; the agent only brings it Pyth prices. Everything the agent needs from
// IVault goes through this one interface: the in-memory SimVault for tests and the stage replay, and ViemVault for the
// deployed contract.
import { type Address, formatEther, type Hex } from 'viem';
import type { PriceUpdate } from '../pyth/hermes.ts';

// IVault.AssetRule, in seconds and basis points, for one asset of a rule
export interface RuleAsset {
  asset: string;
  // Share of the rule's daily limit this asset may use (spec: priority via budget split)
  budgetShareBps: number;
  trendThresholdBps: number;
  spikeCapBps: number;
  minWaitSec: number;
  maxWindowSec: number;
  // Shortest time between two buys of this asset
  cooldownSec: number;
  // 0 turns take profit off
  takeProfitBps: number;
  stagnationBandBps: number;
  // 0 turns the stagnation exit off
  stagnationAfterSec: number;
  // Anyone may sell at P <= entry * (1 - stop loss). 0 turns it off.
  stopLossBps: number;
}

// IVault.Rule plus what the agent needs to navigate: the rule belongs to one user, keyed by their address.
export interface Rule {
  id: string;
  owner: Address;
  // The user's approved agent wallet, the only one that may open a trigger while the LLM's answer is unsigned
  agent: Address;
  paused: boolean;
  // Mock USDC with 6 decimals: what one buy spends, the largest buy, and the most per UTC day
  buyAmount: bigint;
  maxPerTrade: bigint;
  dailyLimit: bigint;
  // Handles of the watched accounts, mapped to the rule's assets that the account is linked to
  accounts: Record<string, string[]>;
  // In the user's priority order
  assets: RuleAsset[];
  topics: Record<string, string[]>;
}

export interface OpenTriggerInput {
  ruleId: string;
  asset: string;
  // The post's account handle and ID; the vault reads the post's time from the ID
  account: string;
  postId: string;
  // The first Pyth price published at or after the post
  p0: PriceUpdate;
}

// What a mined transaction cost the agent wallet: gasUsed * effectiveGasPrice, in wei, and Pyth's fee
export interface TransactionCost {
  txHash?: Hex;
  gasWei?: bigint;
  feeWei?: bigint;
}

export interface OpenedTrigger extends TransactionCost {
  triggerId: string;
}

export interface Bought extends TransactionCost {
  triggerId: string;
  positionId: string;
  usdcIn: bigint;
  assetOut: bigint;
  price: bigint;
}

export type Expired = TransactionCost;

// The event fields for a transaction: its hash and its gas in ETH, when the vault reports them
export const transactionFields = (cost: TransactionCost | void) => ({
  ...(cost?.txHash ? { txHash: cost.txHash } : {}),
  ...(cost?.gasWei === undefined ? {} : { gasEth: formatEther(cost.gasWei) }),
});

// An open trigger as the vault stores it: what Gate 2 needs to pick it up again after a restart
export interface OpenTriggerRecord {
  triggerId: string;
  ruleId: string;
  asset: string;
  // P0's price, with 18 decimals, and the time at which the source took it, in seconds
  p0: bigint;
  t0: number;
}

export type SellKind = 'manual' | 'take-profit' | 'stagnation' | 'stop-loss';

// The sell rules a position was bought with; a later change of the rule does not change them (IVault.PositionExits)
export interface PositionExits {
  takeProfitBps: number;
  stopLossBps: number;
  stagnationBandBps: number;
  stagnationAfterSec: number;
}

export interface Position {
  id: string;
  ruleId: string;
  asset: string;
  amount: bigint;
  entryPrice: bigint;
  // When the vault bought, in seconds; a sell needs a price published after it
  entryTime: number;
  open: boolean;
  exits: PositionExits;
}

export interface Sold extends TransactionCost {
  positionId: string;
  usdcOut: bigint;
  price: bigint;
}

// A revert, with the vault's custom error name as `reason` so the console can say which check stopped it.
export class VaultRejection extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'VaultRejection';
    this.reason = reason;
  }
}

// A transaction that was sent but not mined in time. It is not the vault saying no, so the caller tries again on a later
// cycle; the hash says where to look, because it may still land.
export class TxTimeout extends Error {
  readonly hash: Hex;

  constructor(hash: Hex, timeoutMs: number) {
    super(`Transaction ${hash} was not mined within ${Math.round(timeoutMs / 1000)} s; it may still land`);
    this.name = 'TxTimeout';
    this.hash = hash;
  }
}

export interface VaultPort {
  readonly kind: 'simulated' | 'onchain';
  // The sells the keeper may submit: anyone may take profit, stop the loss or exit stagnation; only the owner sells by
  // hand
  readonly keeperSellKinds: readonly SellKind[];
  listRules(): Promise<Rule[]>;
  openTrigger(input: OpenTriggerInput): Promise<OpenedTrigger>;
  confirmTrigger(triggerId: string, p1: PriceUpdate): Promise<Bought>;
  expireTrigger(triggerId: string): Promise<Expired | void>;
  listPositions(): Promise<Position[]>;
  // The open triggers of this agent's users, so a restart forgets none
  listOpenTriggers?(): Promise<OpenTriggerRecord[]>;
  sell(positionId: string, kind: SellKind, price: PriceUpdate): Promise<Sold>;
}
