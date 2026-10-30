// The agent's view of the vault. The vault decides; the agent only brings it signed proof. Everything the agent needs
// from Person A's IVault goes through this one interface: the in-memory SimVault for tests and the stage replay, and
// ViemVault for the deployed contract.
import type { Address, Hex } from 'viem';
import type { SignedResponse } from '../airnode/attestation.ts';

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
  // Stop loss is a stretch goal that the deployed vault does not have; only the SimVault applies it. 0 turns it off.
  stopLossBps?: number;
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
  account: string;
  post: SignedResponse;
  p0: SignedResponse;
}

export interface OpenedTrigger {
  triggerId: string;
  txHash?: Hex;
}

export interface Bought {
  triggerId: string;
  positionId: string;
  usdcIn: bigint;
  assetOut: bigint;
  price: bigint;
  txHash?: Hex;
}

export type SellKind = 'manual' | 'take-profit' | 'stagnation' | 'stop-loss';

export interface Position {
  id: string;
  ruleId: string;
  asset: string;
  amount: bigint;
  entryPrice: bigint;
  // When the vault bought, in seconds; a sell needs a price taken after it
  entryTime: number;
  open: boolean;
}

export interface Sold {
  positionId: string;
  usdcOut: bigint;
  price: bigint;
  txHash?: Hex;
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

export interface VaultPort {
  readonly kind: 'simulated' | 'onchain';
  // The sells the keeper may submit: the vault lets anyone take profit or exit stagnation, only the owner sell by hand
  readonly keeperSellKinds: readonly SellKind[];
  listRules(): Promise<Rule[]>;
  openTrigger(input: OpenTriggerInput): Promise<OpenedTrigger>;
  confirmTrigger(triggerId: string, p1: SignedResponse): Promise<Bought>;
  expireTrigger(triggerId: string): Promise<void>;
  listPositions(): Promise<Position[]>;
  sell(positionId: string, kind: SellKind, price: SignedResponse): Promise<Sold>;
}
