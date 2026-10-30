// An in-memory vault that enforces the spec's checks with the agent's own verification code. It is a test double and
// the engine of the stage replay; the deployed vault is Person A's contract, which makes these decisions on-chain.
import type { Address, Hex } from 'viem';
import { AttestationError, deriveRequestHash, type SignedResponse, verifySignedResponse } from '../airnode/attestation.ts';
import { readUint } from '../airnode/projected-json.ts';
import { checkTrend, checkTweetToP0, type GateFailure, risesAtLeast } from '../engine/gates.ts';
import { getAsset, priceRequest, type Profiles, readSignedPrice } from '../profiles.ts';
import { latestTweetRequest, snowflakeTime } from '../sources/twitter.ts';
import {
  type Bought,
  type OpenedTrigger,
  type OpenTriggerInput,
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
  // USDC with 6 decimals deposited per rule
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

export type TriggerStatus = 'pending' | 'bought' | 'expired';

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

const GATE_ERRORS: Record<GateFailure, string> = {
  'tweet-too-old-for-p0': 'PostTooOldForPrice',
  'p0-before-tweet': 'PriceBeforePost',
  'before-min-wait': 'BeforeMinimumWait',
  'after-max-window': 'WindowClosed',
  'below-threshold': 'TrendBelowThreshold',
  'above-spike-cap': 'AboveSpikeCap',
};

const DAY = 86_400;
const BPS = 10_000n;

export class SimVault implements VaultPort {
  readonly kind = 'simulated';
  private readonly options: SimVaultOptions;
  private readonly balances = new Map<string, bigint>();
  private readonly triggers = new Map<string, SimTrigger>();
  private readonly positions = new Map<string, Position>();
  private readonly usedPosts = new Set<string>();
  private readonly usedResponses = new Set<string>();
  private readonly lastTrade = new Map<string, number>();
  private readonly spent = new Map<string, { day: number; total: bigint; perAsset: Map<string, bigint> }>();
  private readonly dayStartBalance = new Map<string, { day: number; balance: bigint }>();
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

  // The same three checks as AirnodeV2Attestation.verify plus the age check, against what the vault stores.
  private async verify(response: SignedResponse, airnode: Address, requestHash: Hex) {
    try {
      await verifySignedResponse(response, airnode, requestHash);
    } catch (error) {
      if (error instanceof AttestationError) {
        throw new VaultRejection(error.reason === 'wrong-request' ? 'WrongRequestHash' : 'NotSignedByAirnode');
      }
      throw error;
    }
    if (this.options.now() - Number(response.timestamp) > this.options.profiles.maxPriceAgeSec) {
      throw new VaultRejection('ResponseTooOld', `signed at ${response.timestamp}`);
    }
    return `${requestHash}:${response.timestamp}:${response.signature}`;
  }

  private assertUnused(key: string) {
    if (this.usedResponses.has(key)) throw new VaultRejection('ResponseAlreadyUsed');
  }

  private async verifyPrice(asset: string, response: SignedResponse) {
    const profile = getAsset(this.options.profiles, asset);
    const airnode =
      this.options.priceAirnodes?.[asset] ?? this.options.profiles.airnodes[profile.price.airnode]?.address;
    if (!airnode) throw new VaultRejection('UnknownAirnode', asset);
    const key = await this.verify(response, airnode, deriveRequestHash(priceRequest(profile)));
    this.assertUnused(key);
    const price = readSignedPrice(this.options.profiles, profile, response);
    if (this.options.now() - price.sourceTime > this.options.profiles.maxPriceAgeSec) {
      throw new VaultRejection('MarketClosed', `price taken at ${price.sourceTime}`);
    }
    return { key, price };
  }

  async openTrigger({ ruleId, asset, account, post, p0 }: OpenTriggerInput): Promise<OpenedTrigger> {
    const rule = this.rule(ruleId);
    if (rule.paused) throw new VaultRejection('RulePaused');
    if (this.options.caller.toLowerCase() !== rule.agent.toLowerCase()) throw new VaultRejection('NotRuleAgent');
    this.ruleAsset(rule, asset);
    if (!rule.accounts[account]?.includes(asset)) throw new VaultRejection('AccountNotWatched', `${account} / ${asset}`);

    const pinned = this.options.pinnedAccounts?.includes(account) ?? false;
    const postHash = deriveRequestHash(latestTweetRequest({ handle: account, pinned }));
    const postKey = await this.verify(post, this.options.tweetAirnode, postHash);
    const postId = (() => {
      try {
        return readUint(post.data, 'id', 0).toString();
      } catch {
        throw new VaultRejection('MalformedPost');
      }
    })();
    if (this.usedPosts.has(`${ruleId}:${postId}`)) throw new VaultRejection('PostAlreadyUsed', postId);
    this.assertUnused(postKey);

    const { key: p0Key, price } = await this.verifyPrice(asset, p0);
    const timing = checkTweetToP0(snowflakeTime(postId), price, this.options.profiles.maxTweetToP0Sec);
    if (!timing.ok) throw new VaultRejection(GATE_ERRORS[timing.reason]);

    this.usedPosts.add(`${ruleId}:${postId}`);
    this.usedResponses.add(postKey);
    this.usedResponses.add(p0Key);
    const id = String(this.nextTrigger++);
    this.triggers.set(id, { id, ruleId, asset, account, postId, p0: price.price, t0: price.sourceTime, status: 'pending' });
    return { triggerId: id };
  }

  private budget(rule: Rule, asset: RuleAsset): bigint {
    const now = this.options.now();
    const day = Math.floor(now / DAY);
    let start = this.dayStartBalance.get(rule.id);
    if (!start || start.day !== day) {
      start = { day, balance: this.balanceOf(rule.id) };
      this.dayStartBalance.set(rule.id, start);
    }
    let spent = this.spent.get(rule.id);
    if (!spent || spent.day !== day) {
      spent = { day, total: 0n, perAsset: new Map() };
      this.spent.set(rule.id, spent);
    }
    const dailyLimit = (start.balance * BigInt(rule.dailyLimitBps)) / BPS;
    const assetLimit = (dailyLimit * BigInt(asset.budgetShareBps)) / BPS;
    const perTrade = (start.balance * BigInt(rule.maxPerTradeBps)) / BPS;
    const leftToday = dailyLimit - spent.total;
    const leftForAsset = assetLimit - (spent.perAsset.get(asset.asset) ?? 0n);
    const amounts = [perTrade, leftToday, leftForAsset, this.balanceOf(rule.id)];
    return amounts.reduce((min, value) => (value < min ? value : min));
  }

  async confirmTrigger(triggerId: string, p1Response: SignedResponse): Promise<Bought> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.status !== 'pending') throw new VaultRejection('TriggerNotPending', triggerId);
    const rule = this.rule(trigger.ruleId);
    const asset = this.ruleAsset(rule, trigger.asset);
    const { key, price: p1 } = await this.verifyPrice(trigger.asset, p1Response);
    const p0 = { ...p1, price: trigger.p0, sourceTime: trigger.t0 };
    const trend = checkTrend(p0, p1, asset);
    if (!trend.ok) throw new VaultRejection(GATE_ERRORS[trend.reason]);

    if (rule.paused) throw new VaultRejection('RulePaused');
    const last = this.lastTrade.get(rule.id);
    if (last !== undefined && this.options.now() - last < rule.cooldownSec) throw new VaultRejection('CooldownActive');
    const usdcIn = this.budget(rule, asset);
    if (usdcIn <= 0n) throw new VaultRejection('DailyLimitReached');

    // The mock DEX's exact-price math: 18-decimal asset for 6-decimal USDC at an 18-decimal price
    const assetOut = (usdcIn * 10n ** 18n * 10n ** 18n) / (p1.price * 10n ** 6n);
    this.usedResponses.add(key);
    this.balances.set(rule.id, this.balanceOf(rule.id) - usdcIn);
    const spent = this.spent.get(rule.id);
    if (spent) {
      spent.total += usdcIn;
      spent.perAsset.set(asset.asset, (spent.perAsset.get(asset.asset) ?? 0n) + usdcIn);
    }
    this.lastTrade.set(rule.id, this.options.now());
    trigger.status = 'bought';
    const positionId = String(this.nextPosition++);
    this.positions.set(positionId, {
      id: positionId,
      ruleId: rule.id,
      asset: asset.asset,
      amount: assetOut,
      entryPrice: p1.price,
      entryTime: p1.sourceTime,
      open: true,
    });
    return { triggerId, positionId, usdcIn, assetOut, price: p1.price };
  }

  async expireTrigger(triggerId: string): Promise<void> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.status !== 'pending') throw new VaultRejection('TriggerNotPending', triggerId);
    const asset = this.ruleAsset(this.rule(trigger.ruleId), trigger.asset);
    if (this.options.now() <= trigger.t0 + asset.maxWindowSec) throw new VaultRejection('WindowStillOpen');
    trigger.status = 'expired';
  }

  async sell(positionId: string, kind: SellKind, response: SignedResponse): Promise<Sold> {
    const position = this.positions.get(positionId);
    if (!position || !position.open) throw new VaultRejection('PositionNotOpen', positionId);
    const asset = this.ruleAsset(this.rule(position.ruleId), position.asset);
    const { key, price } = await this.verifyPrice(position.asset, response);
    const entry = position.entryPrice;
    const p = price.price;
    const held = this.options.now() - position.entryTime;
    const conditionMet: Record<SellKind, boolean> = {
      manual: true,
      'take-profit': risesAtLeast(entry, p, asset.takeProfitBps),
      'stop-loss': p * BPS <= entry * (BPS - BigInt(asset.stopLossBps)),
      stagnation:
        held >= asset.stagnationAfterSec &&
        (p > entry ? p - entry : entry - p) * BPS <= entry * BigInt(asset.stagnationBandBps),
    };
    if (!conditionMet[kind]) throw new VaultRejection('SellConditionNotMet', kind);
    const usdcOut = (position.amount * p * 10n ** 6n) / (10n ** 18n * 10n ** 18n);
    this.usedResponses.add(key);
    position.open = false;
    this.balances.set(position.ruleId, this.balanceOf(position.ruleId) + usdcOut);
    return { positionId, usdcOut, price: p };
  }
}
