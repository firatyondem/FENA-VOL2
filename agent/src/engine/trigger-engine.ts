// Gate 1 and the hand-off to Gate 2: notice a post, ask whether it matters to the user's assets, bring the signed post
// and P0 to the vault, then bring P1 once the window opens. The vault decides at every step; when it says no, the
// engine logs why and moves on.
import { type Address, formatUnits } from 'viem';
import { deriveRequestHash, type SignedResponse, verifySignedResponse } from '../airnode/attestation.ts';
import { formatFixedPoint } from '../airnode/projected-json.ts';
import { prefilter, type Candidate, type Classification, type Classifier } from '../classifier/types.ts';
import { type Rule, type RuleAsset, VaultRejection, type VaultPort } from '../chain/vault.ts';
import type { EventLog } from '../log.ts';
import { getAsset, isPriceFresh, type Profiles, readSignedPrice, type SignedPrice } from '../profiles.ts';
import { latestTweetRequest, type Post, readSignedPost, type WatchedAccount } from '../sources/twitter.ts';
import { changeBps, checkTrend, checkTweetToP0, describeGateFailure } from './gates.ts';

export interface TriggerEngineDeps {
  profiles: Profiles;
  vault: VaultPort;
  classifier: Classifier;
  fetchLatestPost: (account: WatchedAccount) => Promise<SignedResponse>;
  fetchPrice: (asset: string) => Promise<SignedResponse>;
  log: EventLog;
  // Seconds
  now: () => number;
  tweetAirnode: Address;
  // A result counts as relevant from this confidence on
  minConfidence?: number;
  // Seconds between two P1 fetches for one trigger
  p1IntervalSec?: number;
}

export interface PendingTrigger {
  triggerId: string;
  ruleId: string;
  asset: string;
  p0: SignedPrice;
  params: RuleAsset;
  lastCheck: number;
  // Set once the agent stops chasing P1 (spike cap); the trigger then only waits to expire
  abandoned: boolean;
}

// Vault.sol errors after which no later P1 can confirm the trigger
const TERMINAL_CONFIRM_REJECTIONS = new Set(['TriggerNotOpen', 'WindowClosed', 'SpikeTooHigh']);

const price18 = (value: bigint) => formatFixedPoint(value, 18);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private readonly seenPosts = new Set<string>();
  private readonly pending = new Map<string, PendingTrigger>();

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
  }

  pendingTriggers(): PendingTrigger[] {
    return [...this.pending.values()];
  }

  // One poll of one watched account: at most one new post, classified once for every rule that watches the account.
  async pollAccount(account: WatchedAccount): Promise<void> {
    const { log, now, profiles } = this.deps;
    let post: Post;
    try {
      const response = await this.deps.fetchLatestPost(account);
      await verifySignedResponse(response, this.deps.tweetAirnode, deriveRequestHash(latestTweetRequest(account)));
      post = readSignedPost(response);
    } catch (error) {
      log.append({ kind: 'error', where: `poll @${account.handle}`, message: errorMessage(error) });
      return;
    }
    const seenKey = `${account.handle}:${post.id}`;
    if (this.seenPosts.has(seenKey)) return;
    this.seenPosts.add(seenKey);
    log.append({ kind: 'post.seen', account: account.handle, postId: post.id, text: post.text, createdAt: post.createdAt });

    if (now() - post.createdAt > profiles.maxTweetToP0Sec) {
      log.append({ kind: 'post.skipped', account: account.handle, postId: post.id, reason: 'older than the P0 window' });
      return;
    }
    const rules = (await this.deps.vault.listRules()).filter((rule) => !rule.paused && rule.accounts[account.handle]);
    const candidates = this.candidatesFor(account, rules);
    const skip = prefilter(post, candidates);
    if (skip) {
      log.append({ kind: 'post.skipped', account: account.handle, postId: post.id, reason: skip });
      return;
    }

    const results = await this.deps.classifier.classify(post, candidates);
    log.append({
      kind: 'post.classified',
      account: account.handle,
      postId: post.id,
      classifier: this.deps.classifier.name,
      results,
    });
    const relevant = new Map<string, Classification>();
    for (const result of results) {
      if (result.relevant && result.confidence >= (this.deps.minConfidence ?? 0.7)) relevant.set(result.asset, result);
    }
    if (relevant.size === 0) return;

    const prices = new Map<string, Promise<SignedResponse>>();
    for (const rule of rules) await this.openForRule(rule, account, post, relevant, prices);
  }

  // The assets a post may be checked against: those linked to the account in a rule, with the rule's topics.
  private candidatesFor(account: WatchedAccount, rules: Rule[]): Candidate[] {
    const candidates = new Map<string, Candidate>();
    for (const rule of rules) {
      for (const asset of rule.accounts[account.handle] ?? []) {
        if (!account.assets.includes(asset) || candidates.has(asset)) continue;
        const profile = getAsset(this.deps.profiles, asset);
        candidates.set(asset, { asset, name: profile.name, topics: rule.topics[asset] ?? profile.suggestedTopics });
      }
    }
    return [...candidates.values()];
  }

  // Serves the relevant assets in the rule's priority order. The vault takes one trigger per user, asset and post, and
  // its budget split stops an asset whose share of the day is spent.
  private async openForRule(
    rule: Rule,
    account: WatchedAccount,
    post: Post,
    relevant: Map<string, Classification>,
    prices: Map<string, Promise<SignedResponse>>
  ) {
    const { log, now, profiles } = this.deps;
    for (const params of rule.assets) {
      if (!relevant.has(params.asset) || !rule.accounts[account.handle]?.includes(params.asset)) continue;
      const asset = getAsset(profiles, params.asset);
      try {
        if (!prices.has(asset.key)) prices.set(asset.key, this.deps.fetchPrice(asset.key));
        const p0Response = await (prices.get(asset.key) as Promise<SignedResponse>);
        const p0 = readSignedPrice(profiles, asset, p0Response);
        if (!isPriceFresh(profiles, p0, now())) {
          log.append({ kind: 'trigger.rejected', asset: asset.key, stage: 'open', reason: 'market closed: P0 is stale' });
          continue;
        }
        const timing = checkTweetToP0(post.createdAt, p0, profiles.maxTweetToP0Sec);
        if (!timing.ok) {
          log.append({ kind: 'trigger.rejected', asset: asset.key, stage: 'open', reason: describeGateFailure[timing.reason] });
          continue;
        }
        const opened = await this.deps.vault.openTrigger({
          ruleId: rule.id,
          asset: asset.key,
          account: account.handle,
          post: post.response,
          p0: p0Response,
        });
        this.pending.set(opened.triggerId, {
          triggerId: opened.triggerId,
          ruleId: rule.id,
          asset: asset.key,
          p0,
          params,
          lastCheck: 0,
          abandoned: false,
        });
        log.append({
          kind: 'trigger.opened',
          triggerId: opened.triggerId,
          ruleId: rule.id,
          asset: asset.key,
          account: account.handle,
          postId: post.id,
          p0: price18(p0.price),
          t0: p0.sourceTime,
          opensAt: p0.sourceTime + params.minWaitSec,
          closesAt: p0.sourceTime + params.maxWindowSec,
          thresholdBps: params.trendThresholdBps,
          spikeCapBps: params.spikeCapBps,
          ...(opened.txHash ? { txHash: opened.txHash } : {}),
        });
      } catch (error) {
        const reason = error instanceof VaultRejection ? error.reason : errorMessage(error);
        log.append({ kind: 'trigger.rejected', asset: asset.key, stage: 'open', reason });
      }
    }
  }

  // Brings P1 to each open trigger once its window opens, and expires the ones whose window closed.
  async checkPending(): Promise<void> {
    const { log, now, profiles } = this.deps;
    const interval = this.deps.p1IntervalSec ?? 30;
    for (const trigger of this.pending.values()) {
      const opensAt = trigger.p0.sourceTime + trigger.params.minWaitSec;
      const closesAt = trigger.p0.sourceTime + trigger.params.maxWindowSec;
      if (now() > closesAt) {
        await this.expire(trigger);
        continue;
      }
      if (trigger.abandoned || now() < opensAt || now() - trigger.lastCheck < interval) continue;
      trigger.lastCheck = now();

      let p1: SignedPrice;
      try {
        p1 = readSignedPrice(profiles, getAsset(profiles, trigger.asset), await this.deps.fetchPrice(trigger.asset));
      } catch (error) {
        log.append({ kind: 'error', where: `P1 ${trigger.asset}`, message: errorMessage(error) });
        continue;
      }
      const trend = checkTrend(trigger.p0, p1, trigger.params);
      log.append({
        kind: 'trigger.checked',
        triggerId: trigger.triggerId,
        asset: trigger.asset,
        p1: price18(p1.price),
        changeBps: changeBps(trigger.p0.price, p1.price),
        verdict: trend.ok ? 'submitting' : describeGateFailure[trend.reason],
      });
      if (!trend.ok) {
        if (trend.reason === 'above-spike-cap') trigger.abandoned = true;
        continue;
      }
      try {
        const bought = await this.deps.vault.confirmTrigger(trigger.triggerId, p1.response);
        this.pending.delete(trigger.triggerId);
        log.append({
          kind: 'trigger.bought',
          triggerId: trigger.triggerId,
          positionId: bought.positionId,
          asset: trigger.asset,
          usdcIn: formatUnits(bought.usdcIn, profiles.usdcDecimals),
          assetOut: formatUnits(bought.assetOut, 18),
          price: price18(bought.price),
          ...(bought.txHash ? { txHash: bought.txHash } : {}),
        });
      } catch (error) {
        const reason = error instanceof VaultRejection ? error.reason : errorMessage(error);
        log.append({ kind: 'trigger.rejected', triggerId: trigger.triggerId, asset: trigger.asset, stage: 'confirm', reason });
        if (TERMINAL_CONFIRM_REJECTIONS.has(reason)) trigger.abandoned = true;
      }
    }
  }

  private async expire(trigger: PendingTrigger) {
    try {
      await this.deps.vault.expireTrigger(trigger.triggerId);
    } catch (error) {
      if (!(error instanceof VaultRejection && error.reason === 'TriggerNotOpen')) {
        this.deps.log.append({ kind: 'error', where: `expire ${trigger.triggerId}`, message: errorMessage(error) });
        return;
      }
    }
    this.pending.delete(trigger.triggerId);
    this.deps.log.append({ kind: 'trigger.expired', triggerId: trigger.triggerId, asset: trigger.asset });
  }
}
