// An in-memory vault that follows Person A's Vault.sol: the same checks in the same order, with the same error names, run
// with the agent's own verification code. It is a test double and the engine of the stage replay; the deployed Vault
// makes these decisions on-chain.
import type { Address, Hex } from 'viem';
import { AttestationError, deriveRequestHash, type SignedResponse, verifySignedResponse } from '../airnode/attestation.ts';
import { readUint } from '../airnode/projected-json.ts';
import { checkTrend, type GateFailure } from '../engine/gates.ts';
import { takeProfitTarget } from '../engine/keeper.ts';
import { getAsset, priceRequest, type Profiles, readSignedPrice } from '../profiles.ts';
import { latestTweetRequest, snowflakeTime } from '../sources/twitter.ts';
import {
  type Bought,
  type Expired,
  type OpenedTrigger,
  type OpenTriggerInput,
  type OpenTriggerRecord,
  type Position,
  type Rule,
  type RuleAsset,
  type SellKind,
  type Sold,
  VaultRejection,
  type VaultPort,
} from './vault.ts';

export interface SimVaultOptions {
  profiles: Profiles;
  rules: Rule[];
  // Mock USDC with 6 decimals deposited per rule
  deposits: Record<string, bigint>;
  // The wallet that sends the agent's transactions
  caller: Address;
  tweetAirnode: Address;
  // Expected Airnode per asset; defaults to the profile's price Airnode
  priceAirnodes?: Record<string, Address>;
  // Seconds
  now: () => number;
  // Accounts whose newest post sits behind a pinned tweet
  pinnedAccounts?: string[];
}

export type TriggerStatus = 'open' | 'confirmed' | 'expired';

export interface SimTrigger {
  id: string;
  ruleId: string;
  asset: string;
  account: string;
  postId: string;
  p0: bigint;
  t0: number;
  status: TriggerStatus;
}

// Vault.sol's error for each failed gate
const GATE_ERRORS: Record<GateFailure, string> = {
  'tweet-too-old-for-p0': 'PriceOutsideTweetWindow',
  'p0-before-tweet': 'PriceOutsideTweetWindow',
  'before-min-wait': 'WaitNotOver',
  'after-max-window': 'WindowClosed',
  'below-threshold': 'TrendTooWeak',
  'above-spike-cap': 'SpikeTooHigh',
};

const DAY = 86_400;
const BPS = 10_000n;
const MAX_POST_TO_P0 = 600;

export class SimVault implements VaultPort {
  readonly kind = 'simulated';
  readonly keeperSellKinds: readonly SellKind[] = ['take-profit', 'stagnation', 'stop-loss'];
  private readonly options: SimVaultOptions;
  private readonly balances = new Map<string, bigint>();
  private readonly triggers = new Map<string, SimTrigger>();
  private readonly positions = new Map<string, Position>();
  private readonly usedPosts = new Set<string>();
  private readonly usedResponses = new Set<string>();
  private readonly lastBuy = new Map<string, number>();
  private readonly spent = new Map<string, bigint>();
  private nextTrigger = 1;
  private nextPosition = 1;

  constructor(options: SimVaultOptions) {
    this.options = options;
    for (const [ruleId, amount] of Object.entries(options.deposits)) this.balances.set(ruleId, amount);
  }

  async listRules(): Promise<Rule[]> {
    return this.options.rules;
  }

  async listPositions(): Promise<Position[]> {
    return [...this.positions.values()];
  }

  balanceOf(ruleId: string) {
    return this.balances.get(ruleId) ?? 0n;
  }

  listTriggers(): SimTrigger[] {
    return [...this.triggers.values()];
  }

  setPaused(ruleId: string, paused: boolean) {
    this.rule(ruleId).paused = paused;
  }

  private rule(ruleId: string): Rule {
    const rule = this.options.rules.find((candidate) => candidate.id === ruleId);
    if (!rule) throw new VaultRejection('UnknownRule', ruleId);
    return rule;
  }

  private ruleAsset(rule: Rule, asset: string): RuleAsset {
    const entry = rule.assets.find((candidate) => candidate.asset === asset);
    if (!entry) throw new VaultRejection('AssetNotAllowed', asset);
    return entry;
  }

  // Vault._verifyResponse: the request, then the signer, then the age, against what the vault stores
  private async verify(response: SignedResponse, airnode: Address, requestHash: Hex) {
    try {
      await verifySignedResponse(response, airnode, requestHash);
    } catch (error) {
      if (error instanceof AttestationError) {
        throw new VaultRejection(error.reason === 'wrong-request' ? 'WrongRequestHash' : 'NotSignedByAirnode');
      }
      throw error;
    }
    if (Number(response.timestamp) + this.options.profiles.maxPriceAgeSec < this.options.now()) {
      throw new VaultRejection('ResponseTooOld', `signed at ${response.timestamp}`);
    }
  }

  // Vault._readPrice: verified, with a source time inside the asset's maximum price age
  private async readPrice(asset: string, response: SignedResponse) {
    const profile = getAsset(this.options.profiles, asset);
    const airnode =
      this.options.priceAirnodes?.[asset] ?? this.options.profiles.airnodes[profile.price.airnode]?.address;
    if (!airnode) throw new VaultRejection('AssetNotRegistered', asset);
    await this.verify(response, airnode, deriveRequestHash(priceRequest(profile)));
    const price = readSignedPrice(this.options.profiles, profile, response);
    if (price.sourceTime + this.options.profiles.maxPriceAgeSec < this.options.now()) {
      throw new VaultRejection('PriceTooOld', `price taken at ${price.sourceTime}`);
    }
    return price;
  }

  // Vault._verifyPrice: a buy uses each price response once per user. The caller records `key` only once every check
  // passed, because a revert in the vault undoes the whole call.
  private async verifyPrice(ruleId: string, asset: string, response: SignedResponse) {
    const price = await this.readPrice(asset, response);
    const key = `${ruleId}:${response.requestHash}:${response.timestamp}:${response.data}`;
    if (this.usedResponses.has(key)) throw new VaultRejection('ResponseAlreadyUsed');
    return { price, key };
  }

  async openTrigger({ ruleId, asset, account, post, p0 }: OpenTriggerInput): Promise<OpenedTrigger> {
    const rule = this.rule(ruleId);
    if (this.options.caller.toLowerCase() !== rule.agent.toLowerCase()) throw new VaultRejection('NotAgent');
    if (rule.paused) throw new VaultRejection('RuleIsPaused');
    this.ruleAsset(rule, asset);
    if (!rule.accounts[account]) throw new VaultRejection('AccountNotWatched', account);

    const pinned = this.options.pinnedAccounts?.includes(account) ?? false;
    await this.verify(post, this.options.tweetAirnode, deriveRequestHash(latestTweetRequest({ handle: account, pinned })));
    let postId: string;
    try {
      postId = readUint(post.data, 'id', 0).toString();
    } catch {
      throw new VaultRejection('FieldNotFound', 'id');
    }
    const postKey = `${ruleId}:${asset}:${postId}`;
    if (this.usedPosts.has(postKey)) throw new VaultRejection('TweetAlreadyUsed', postId);

    const { price, key } = await this.verifyPrice(ruleId, asset, p0);
    const postTime = snowflakeTime(postId);
    if (price.sourceTime < postTime || price.sourceTime > postTime + MAX_POST_TO_P0) {
      throw new VaultRejection('PriceOutsideTweetWindow');
    }

    // Every check passed: record what the call used, as the vault's storage writes would stand
    this.usedPosts.add(postKey);
    this.usedResponses.add(key);
    const id = String(this.nextTrigger++);
    this.triggers.set(id, { id, ruleId, asset, account, postId, p0: price.price, t0: price.sourceTime, status: 'open' });
    return { triggerId: id };
  }

  // Vault._spend: the fixed buy amount, within the per-trade limit, the asset's cooldown and its share of the day
  private spend(rule: Rule, asset: RuleAsset): bigint {
    const now = this.options.now();
    const amount = rule.buyAmount;
    if (amount > rule.maxPerTrade) throw new VaultRejection('PerTradeLimitExceeded');
    const last = this.lastBuy.get(`${rule.id}:${asset.asset}`);
    if (last !== undefined && now < last + asset.cooldownSec) throw new VaultRejection('CooldownActive');
    const dayKey = `${rule.id}:${asset.asset}:${Math.floor(now / DAY)}`;
    const budget = (rule.dailyLimit * BigInt(asset.budgetShareBps)) / BPS;
    const spent = this.spent.get(dayKey) ?? 0n;
    if (spent + amount > budget) throw new VaultRejection('DailyBudgetExceeded');
    if (this.balanceOf(rule.id) < amount) throw new VaultRejection('InsufficientBalance');
    this.balances.set(rule.id, this.balanceOf(rule.id) - amount);
    this.spent.set(dayKey, spent + amount);
    this.lastBuy.set(`${rule.id}:${asset.asset}`, now);
    return amount;
  }

  async confirmTrigger(triggerId: string, p1Response: SignedResponse): Promise<Bought> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.status !== 'open') throw new VaultRejection('TriggerNotOpen', triggerId);
    const rule = this.rule(trigger.ruleId);
    if (rule.paused) throw new VaultRejection('RuleIsPaused');
    const asset = this.ruleAsset(rule, trigger.asset);
    const { price: p1, key } = await this.verifyPrice(rule.id, trigger.asset, p1Response);
    const trend = checkTrend({ price: trigger.p0, sourceTime: trigger.t0 }, p1, asset);
    if (!trend.ok) throw new VaultRejection(GATE_ERRORS[trend.reason]);
    // spend() throws before it changes anything, so nothing is recorded for a refused buy
    const usdcIn = this.spend(rule, asset);
    this.usedResponses.add(key);

    // The mock DEX's exact-price math: 18-decimal asset for 6-decimal USDC at an 18-decimal price
    const assetOut = (usdcIn * 10n ** 18n * 10n ** 18n) / (p1.price * 10n ** 6n);
    trigger.status = 'confirmed';
    const positionId = String(this.nextPosition++);
    this.positions.set(positionId, {
      id: positionId,
      ruleId: rule.id,
      asset: asset.asset,
      amount: assetOut,
      entryPrice: p1.price,
      entryTime: this.options.now(),
      open: true,
    });
    return { triggerId, positionId, usdcIn, assetOut, price: p1.price };
  }

  async listOpenTriggers(): Promise<OpenTriggerRecord[]> {
    return [...this.triggers.values()]
      .filter((trigger) => trigger.status === 'open')
      .map(({ id, ruleId, asset, p0, t0 }) => ({ triggerId: id, ruleId, asset, p0, t0 }));
  }

  // Nothing is mined in memory, so there is no hash or gas to report
  async expireTrigger(triggerId: string): Promise<Expired | void> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.status !== 'open') throw new VaultRejection('TriggerNotOpen', triggerId);
    const asset = this.ruleAsset(this.rule(trigger.ruleId), trigger.asset);
    if (this.options.now() <= trigger.t0 + asset.maxWindowSec) throw new VaultRejection('WindowNotClosed');
    trigger.status = 'expired';
  }

  async sell(positionId: string, kind: SellKind, response: SignedResponse): Promise<Sold> {
    const position = this.positions.get(positionId);
    if (!position || !position.open) throw new VaultRejection('PositionNotOpen', positionId);
    const rule = this.rule(position.ruleId);
    if (kind !== 'manual' && rule.paused) throw new VaultRejection('RuleIsPaused');
    const asset = this.ruleAsset(rule, position.asset);
    // The same price can sell several positions, so it is not marked as used
    const { price: p, sourceTime } = await this.readPrice(position.asset, response);
    if (sourceTime < position.entryTime) throw new VaultRejection('PriceBeforeBuy');
    const entry = position.entryPrice;
    if (kind === 'take-profit') {
      const target = asset.takeProfitBps === 0 ? undefined : takeProfitTarget(entry, asset.takeProfitBps);
      if (target === undefined || p < target) throw new VaultRejection('TakeProfitNotReached');
    } else if (kind === 'stagnation') {
      if (asset.stagnationAfterSec === 0 || sourceTime < position.entryTime + asset.stagnationAfterSec) {
        throw new VaultRejection('StagnationDelayNotOver');
      }
      const distance = p > entry ? p - entry : entry - p;
      if (distance * BPS > entry * BigInt(asset.stagnationBandBps)) {
        throw new VaultRejection('PriceOutsideStagnationBand');
      }
    } else if (kind === 'stop-loss') {
      const stop = asset.stopLossBps ?? 0;
      if (stop === 0 || p * BPS > entry * (BPS - BigInt(stop))) throw new VaultRejection('StopLossNotReached');
    }
    const usdcOut = (position.amount * p * 10n ** 6n) / (10n ** 18n * 10n ** 18n);
    position.open = false;
    this.balances.set(position.ruleId, this.balanceOf(position.ruleId) + usdcOut);
    return { positionId, usdcOut, price: p };
  }
}
