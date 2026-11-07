// An in-memory vault that follows Vault.sol: the same checks in the same order, with the same error names. It reads
// Pyth updates (LocalPyth's or real accumulator updates) without checking signatures, which the real Pyth contract does;
// bytes that do not decode stand for an edited update. It is a test double and the engine of the stage replay; the
// deployed Vault makes these decisions on-chain.
import type { Address } from 'viem';
import { checkTrend, GATE_ERRORS } from '../engine/gates.ts';
import { takeProfitTarget } from '../engine/keeper.ts';
import { getAsset, type Profiles, readPythPrice, type SignedPrice } from '../profiles.ts';
import { readUpdate } from '../pyth/accumulator.ts';
import type { PriceUpdate } from '../pyth/hermes.ts';
import { snowflakeTime } from '../sources/posts.ts';
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
  // Seconds
  now: () => number;
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

const DAY = 86_400;
const BPS = 10_000n;
const MAX_POST_TO_P0 = 600;
const MAX_POST_AGE = 1800;

export class SimVault implements VaultPort {
  readonly kind = 'simulated';
  readonly keeperSellKinds: readonly SellKind[] = ['take-profit', 'stop-loss', 'stagnation'];
  private readonly options: SimVaultOptions;
  private readonly balances = new Map<string, bigint>();
  private readonly triggers = new Map<string, SimTrigger>();
  private readonly positions = new Map<string, Position>();
  private readonly usedPosts = new Set<string>();
  private readonly usedPrices = new Set<string>();
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

  // Vault.setRule: replaces the rule in force; open triggers wait under the new one, positions keep their exits
  setRule(rule: Rule) {
    const index = this.options.rules.findIndex((candidate) => candidate.id === rule.id);
    if (index < 0) this.options.rules.push(rule);
    else this.options.rules[index] = rule;
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

  // Vault._readPrice: Pyth parses the update, then the price must be above zero and certain enough
  private readPrice(asset: string, update: PriceUpdate): SignedPrice {
    const { profiles } = this.options;
    const profile = profiles.assets[asset];
    if (!profile) throw new VaultRejection('AssetNotRegistered', asset);
    try {
      for (const bytes of update.updates) readUpdate(bytes);
    } catch {
      throw new VaultRejection('InvalidPriceUpdate');
    }
    let price: SignedPrice;
    try {
      price = readPythPrice(profile, update);
    } catch {
      throw new VaultRejection('WrongPriceFeed', profile.pyth.priceId);
    }
    if (price.price <= 0n) throw new VaultRejection('PriceNotPositive');
    if (price.conf * BPS > price.price * BigInt(profiles.maxConfBps)) throw new VaultRejection('PriceTooUncertain');
    return price;
  }

  // Vault._readFreshPrice: a P1 or sell price, published at most maxPriceAge ago
  private readFreshPrice(asset: string, update: PriceUpdate): SignedPrice {
    const price = this.readPrice(asset, update);
    if (price.sourceTime + this.options.profiles.maxPriceAgeSec < this.options.now()) {
      throw new VaultRejection('PriceTooOld', `published at ${price.sourceTime}`);
    }
    return price;
  }

  private priceKey(ruleId: string, asset: string, publishTime: number) {
    return `${ruleId}:${asset}:${publishTime}`;
  }

  async openTrigger({ ruleId, asset, account, postId, p0 }: OpenTriggerInput): Promise<OpenedTrigger> {
    const rule = this.rule(ruleId);
    if (this.options.caller.toLowerCase() !== rule.agent.toLowerCase()) throw new VaultRejection('NotAgent');
    if (rule.paused) throw new VaultRejection('RuleIsPaused');
    this.ruleAsset(rule, asset);
    if (!rule.accounts[account]) throw new VaultRejection('AccountNotWatched', account);

    const now = this.options.now();
    const postTime = snowflakeTime(postId);
    if (postTime > now || now > postTime + MAX_POST_AGE) throw new VaultRejection('PostOutsideWindow');
    const postKey = `${ruleId}:${asset}:${postId}`;
    if (this.usedPosts.has(postKey)) throw new VaultRejection('TweetAlreadyUsed', postId);

    // P0: the first price at or after the post, at most MAX_POST_TO_P0 after it
    const price = this.readPrice(asset, p0);
    if (price.sourceTime < postTime || price.sourceTime > postTime + MAX_POST_TO_P0) {
      throw new VaultRejection('PriceOutsideTweetWindow');
    }
    if (price.prevPublishTime >= postTime) throw new VaultRejection('PriceNotFirstAfterPost');
    const key = this.priceKey(ruleId, asset, price.sourceTime);
    if (this.usedPrices.has(key)) throw new VaultRejection('PriceAlreadyUsed');

    // Every check passed: record what the call used, as the vault's storage writes would stand
    this.usedPosts.add(postKey);
    this.usedPrices.add(key);
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

  async confirmTrigger(triggerId: string, p1Update: PriceUpdate): Promise<Bought> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.status !== 'open') throw new VaultRejection('TriggerNotOpen', triggerId);
    const rule = this.rule(trigger.ruleId);
    if (rule.paused) throw new VaultRejection('RuleIsPaused');
    const asset = this.ruleAsset(rule, trigger.asset);
    const p1 = this.readFreshPrice(trigger.asset, p1Update);
    const trend = checkTrend({ price: trigger.p0, sourceTime: trigger.t0 }, p1, asset);
    if (!trend.ok) throw new VaultRejection(GATE_ERRORS[trend.reason]);
    const key = this.priceKey(rule.id, trigger.asset, p1.sourceTime);
    if (this.usedPrices.has(key)) throw new VaultRejection('PriceAlreadyUsed');
    // spend() throws before it changes anything, so nothing is recorded for a refused buy
    const usdcIn = this.spend(rule, asset);
    this.usedPrices.add(key);

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
      exits: {
        takeProfitBps: asset.takeProfitBps,
        stopLossBps: asset.stopLossBps,
        stagnationBandBps: asset.stagnationBandBps,
        stagnationAfterSec: asset.stagnationAfterSec,
      },
    });
    return { triggerId, positionId, usdcIn, assetOut, price: p1.price };
  }

  async listOpenTriggers(): Promise<OpenTriggerRecord[]> {
    return [...this.triggers.values()]
      .filter((trigger) => trigger.status === 'open')
      .map(({ id, ruleId, asset, p0, t0 }) => ({ triggerId: id, ruleId, asset, p0, t0 }));
  }

  // Nothing is mined in memory, so there is no hash or gas to report. An asset the rule no longer has has no window.
  async expireTrigger(triggerId: string): Promise<Expired | void> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.status !== 'open') throw new VaultRejection('TriggerNotOpen', triggerId);
    const asset = this.rule(trigger.ruleId).assets.find((entry) => entry.asset === trigger.asset);
    if (this.options.now() <= trigger.t0 + (asset?.maxWindowSec ?? 0)) throw new VaultRejection('WindowNotClosed');
    trigger.status = 'expired';
  }

  async sell(positionId: string, kind: SellKind, update: PriceUpdate): Promise<Sold> {
    const position = this.positions.get(positionId);
    if (!position || !position.open) throw new VaultRejection('PositionNotOpen', positionId);
    const rule = this.rule(position.ruleId);
    if (kind !== 'manual' && rule.paused) throw new VaultRejection('RuleIsPaused');
    // The same price can sell several positions, so it is not marked as used
    const { price: p, sourceTime } = this.readFreshPrice(position.asset, update);
    if (sourceTime < position.entryTime) throw new VaultRejection('PriceBeforeBuy');
    const entry = position.entryPrice;
    const exits = position.exits;
    if (kind === 'take-profit') {
      const target = exits.takeProfitBps === 0 ? undefined : takeProfitTarget(entry, exits.takeProfitBps);
      if (target === undefined || p < target) throw new VaultRejection('TakeProfitNotReached');
    } else if (kind === 'stagnation') {
      if (exits.stagnationAfterSec === 0 || sourceTime < position.entryTime + exits.stagnationAfterSec) {
        throw new VaultRejection('StagnationDelayNotOver');
      }
      const distance = p > entry ? p - entry : entry - p;
      if (distance * BPS > entry * BigInt(exits.stagnationBandBps)) throw new VaultRejection('PriceOutsideStagnationBand');
    } else if (kind === 'stop-loss') {
      if (exits.stopLossBps === 0 || p * BPS > entry * (BPS - BigInt(exits.stopLossBps))) {
        throw new VaultRejection('StopLossNotReached');
      }
    }
    const usdcOut = (position.amount * p * 10n ** 6n) / (10n ** 18n * 10n ** 18n);
    position.open = false;
    this.balances.set(position.ruleId, this.balanceOf(position.ruleId) + usdcOut);
    return { positionId, usdcOut, price: p };
  }
}

// The profile's feed for an asset, for callers building updates
export const feedOf = (profiles: Profiles, asset: string) => getAsset(profiles, asset).pyth.priceId;
