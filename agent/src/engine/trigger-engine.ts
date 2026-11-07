// Gate 1 and the hand-off to Gate 2: read each watched account's new posts once and hand them to every rule that
// watches it, ask whether a post matters to the user's assets, bring the post and P0 (the first Pyth price after it) to
// the vault, then bring P1 once the window opens. The vault decides at every step; when it says no, the engine logs
// why and moves on.
import { formatUnits } from 'viem';
import { skippedByFilter } from '../classifier/tiered.ts';
import { type Candidate, type Classification, type Classifier, prefilter } from '../classifier/types.ts';
import {
  type Expired,
  type OpenTriggerRecord,
  type Rule,
  type RuleAsset,
  transactionFields,
  VaultRejection,
  type VaultPort,
} from '../chain/vault.ts';
import type { EventLog } from '../log.ts';
import { getAsset, isPriceFresh, type PricePoint, type Profiles, readPythPrice, type SignedPrice } from '../profiles.ts';
import type { PriceUpdate } from '../pyth/hermes.ts';
import type { PriceSource } from '../pyth/price-source.ts';
import type { Post, PostSource, WatchedAccount } from '../sources/posts.ts';
import type { DecisionLog, Verdict } from '../store/decisions.ts';
import type { PollStateStore } from '../store/poll-state.ts';
import { type CostRecorder, noCosts } from './costs.ts';
import { formatPrice } from './format.ts';
import { changeBps, checkPostAge, checkTrend, checkTweetToP0, describeGateFailure, GATE_ERRORS } from './gates.ts';

export interface TriggerEngineDeps {
  profiles: Profiles;
  vault: VaultPort;
  classifier: Classifier;
  posts: PostSource;
  prices: PriceSource;
  log: EventLog;
  // Seconds
  now: () => number;
  // A result counts as relevant from this confidence on
  minConfidence?: number;
  // Seconds between two P1 fetches for one trigger
  p1IntervalSec?: number;
  decisions?: DecisionLog;
  costs?: CostRecorder;
  // Where each account's newest post ID is kept across restarts; in memory without it
  pollState?: PollStateStore;
}

export interface PendingTrigger {
  triggerId: string;
  ruleId: string;
  asset: string;
  // Gate 2 needs only P0's price and time, which the vault keeps too, so a restart can restore them
  p0: PricePoint;
  // The rule's limits for the asset, read again from the rule in force on every pass
  params: RuleAsset;
  lastCheck: number;
  // Set once the agent stops chasing P1 (spike cap); the trigger then only waits to expire
  abandoned: boolean;
}

export interface PollResult {
  posts: number;
  // Seconds; the newest post's time, for the poll schedule
  lastPostAt?: number;
}

// Vault.sol errors after which no later P1 can confirm the trigger
const TERMINAL_CONFIRM_REJECTIONS = new Set(['TriggerNotOpen', 'WindowClosed', 'SpikeTooHigh', 'AssetNotAllowed']);

// The rule of an asset its user took out of the rule: no window, so the trigger expires at once
const closedWindow = (asset: string): RuleAsset => ({
  asset,
  budgetShareBps: 0,
  trendThresholdBps: 0,
  spikeCapBps: 0,
  minWaitSec: 0,
  maxWindowSec: 0,
  cooldownSec: 0,
  takeProfitBps: 0,
  stagnationBandBps: 0,
  stagnationAfterSec: 0,
  stopLossBps: 0,
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private readonly sinceIds = new Map<string, string>();
  // Posts fully handled, and the answer for each post the classifier gave one for
  private readonly donePosts = new Set<string>();
  private readonly classifications = new Map<string, Classification[]>();
  // Posts a passing outage interrupted, tried again on the account's next poll while the vault still takes them
  private readonly retryPosts = new Map<string, Post>();
  // Post, rule and asset combinations that opened or that the vault refused for good
  private readonly settled = new Set<string>();
  private readonly pending = new Map<string, PendingTrigger>();

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
  }

  pendingTriggers(): PendingTrigger[] {
    return [...this.pending.values()];
  }

  // After a restart: puts the vault's open triggers back on the Gate 2 list, with P0 and t0 from the vault. The window
  // comes from the rule in force on each pass.
  restorePending(records: readonly OpenTriggerRecord[], rules: readonly Rule[]): string[] {
    const restored: string[] = [];
    for (const record of records) {
      if (this.pending.has(record.triggerId)) continue;
      const rule = rules.find((entry) => sameId(entry.id, record.ruleId));
      const params = rule?.assets.find((entry) => entry.asset === record.asset) ?? closedWindow(record.asset);
      this.pending.set(record.triggerId, {
        triggerId: record.triggerId,
        ruleId: record.ruleId,
        asset: record.asset,
        p0: { price: record.p0, sourceTime: record.t0 },
        params,
        lastCheck: 0,
        abandoned: false,
      });
      restored.push(record.triggerId);
    }
    this.deps.log.append({ kind: 'agent.recovered', openTriggers: restored });
    return restored;
  }

  private sinceId(handle: string): string | undefined {
    return this.deps.pollState?.get(handle).sinceId ?? this.sinceIds.get(handle.toLowerCase());
  }

  private saveSinceId(handle: string, sinceId: string, lastPostAt?: number) {
    this.sinceIds.set(handle.toLowerCase(), sinceId);
    this.deps.pollState?.set(handle, { sinceId, lastPollAt: this.deps.now() * 1000, ...(lastPostAt ? { lastPostAt } : {}) });
  }

  // One poll of one watched account, shared by every rule that watches it: one paid call, each new post classified once
  // and handed to each rule. A post that a passing outage interrupted is tried again on the next poll.
  async pollAccount(account: WatchedAccount): Promise<PollResult> {
    const { log, now, costs = noCosts } = this.deps;
    let rules: Rule[];
    try {
      rules = (await this.deps.vault.listRules()).filter((rule) => !rule.paused && rule.accounts[account.handle]);
    } catch (error) {
      log.append({ kind: 'error', where: 'reading rules, will retry', message: errorMessage(error) });
      return { posts: 0 };
    }
    const users = rules.map((rule) => rule.id);

    let fresh: Post[] = [];
    try {
      const fetched = await this.deps.posts.fetchNewPosts(account, this.sinceId(account.handle));
      costs.postFetch(this.deps.posts.name, users, fetched.cost, `@${account.handle}`);
      fresh = fetched.posts;
    } catch (error) {
      log.append({ kind: 'error', where: `poll @${account.handle}`, message: errorMessage(error) });
    }
    const newest = fresh.at(-1);
    if (newest) this.saveSinceId(account.handle, newest.id, newest.createdAt);
    else this.deps.pollState?.set(account.handle, { lastPollAt: now() * 1000 });

    const retries = [...this.retryPosts.entries()].filter(([key]) => key.startsWith(`${account.handle}:`));
    for (const [key] of retries) this.retryPosts.delete(key);
    for (const post of [...retries.map(([, post]) => post), ...fresh]) {
      if (await this.handlePost(account, post, rules)) this.retryPosts.set(`${account.handle}:${post.id}`, post);
    }
    return { posts: fresh.length, ...(newest ? { lastPostAt: newest.createdAt } : {}) };
  }

  // Returns whether the post should be tried again on the next poll
  private async handlePost(account: WatchedAccount, post: Post, rules: Rule[]): Promise<boolean> {
    const { log, now, profiles, decisions, costs = noCosts } = this.deps;
    const postKey = `${account.handle}:${post.id}`;
    if (this.donePosts.has(postKey)) return false;
    const users = rules.map((rule) => rule.id);
    if (!this.classifications.has(postKey)) {
      log.append({ kind: 'post.seen', account: account.handle, postId: post.id, text: post.text, createdAt: post.createdAt });
      decisions?.recordPost({ tweetId: post.id, account: account.handle, text: post.text, createdAt: post.createdAt, users });
    }
    const skipPost = (reason: string, verdict: Verdict = 'skipped-by-filter') => {
      this.donePosts.add(postKey);
      decisions?.recordVerdict(post.id, verdict, reason, verdict === 'skipped-by-filter' ? 'filter' : '');
      log.append({ kind: 'post.skipped', account: account.handle, postId: post.id, reason });
      return false;
    };

    if (!checkPostAge(post.createdAt, now(), profiles.maxPostAgeSec).ok) return skipPost('older than the vault takes');
    const candidates = this.candidatesFor(account, rules);
    const skip = prefilter(post, candidates);
    if (skip) return skipPost(skip);

    let results = this.classifications.get(postKey);
    if (!results) {
      try {
        results = await this.deps.classifier.classify(post, candidates, (usage) => costs.aiCall(usage, users, post.id));
      } catch (error) {
        log.append({ kind: 'error', where: `classifying @${account.handle}, will retry`, message: errorMessage(error) });
        return true;
      }
      this.classifications.set(postKey, results);
      const minConfidence = this.deps.minConfidence ?? 0.7;
      const relevantResults = results.filter((result) => result.relevant && result.confidence >= minConfidence);
      const verdict: Verdict = skippedByFilter(results)
        ? 'skipped-by-filter'
        : relevantResults.length > 0
          ? 'relevant'
          : 'not-relevant';
      const reason = (relevantResults.length > 0 ? relevantResults : results).map((r) => `${r.asset}: ${r.reason}`).join('; ');
      decisions?.recordVerdict(post.id, verdict, reason, [...new Set(results.map((r) => r.by ?? this.deps.classifier.name))].join(', '));
      log.append({
        kind: 'post.classified',
        account: account.handle,
        postId: post.id,
        classifier: this.deps.classifier.name,
        verdict,
        results,
      });
    }
    const relevant = new Map<string, Classification>();
    for (const result of results) {
      if (result.relevant && result.confidence >= (this.deps.minConfidence ?? 0.7)) relevant.set(result.asset, result);
    }

    const prices = new Map<string, Promise<PriceUpdate>>();
    let retry = false;
    for (const rule of rules) {
      if (await this.openForRule(rule, account, post, relevant, prices)) retry = true;
    }
    if (!retry) this.donePosts.add(postKey);
    return retry && checkPostAge(post.createdAt, now(), profiles.maxPostAgeSec).ok;
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
  // its budget split stops an asset whose share of the day is spent. Returns whether an asset should be tried again.
  private async openForRule(
    rule: Rule,
    account: WatchedAccount,
    post: Post,
    relevant: Map<string, Classification>,
    prices: Map<string, Promise<PriceUpdate>>
  ): Promise<boolean> {
    const { log, now, profiles, decisions, costs = noCosts } = this.deps;
    let retry = false;
    for (const params of rule.assets) {
      if (!relevant.has(params.asset) || !rule.accounts[account.handle]?.includes(params.asset)) continue;
      const settledKey = `${account.handle}:${post.id}:${rule.id}:${params.asset}`;
      if (this.settled.has(settledKey)) continue;
      const asset = getAsset(profiles, params.asset);
      const refuse = (reason: string, txHash?: string) => {
        this.settled.add(settledKey);
        decisions?.recordOutcome(post.id, rule.id, asset.key, 1, reason, txHash);
        log.append({ kind: 'trigger.rejected', asset: asset.key, stage: 'open', reason });
      };
      try {
        if (!prices.has(asset.key)) prices.set(asset.key, this.deps.prices.firstAt(asset.key, post.createdAt));
        const p0Update = await (prices.get(asset.key) as Promise<PriceUpdate>);
        const p0: SignedPrice = readPythPrice(asset, p0Update);
        const timing = checkPostAge(post.createdAt, now(), profiles.maxPostAgeSec).ok
          ? checkTweetToP0(post.createdAt, p0, profiles.maxTweetToP0Sec)
          : checkPostAge(post.createdAt, now(), profiles.maxPostAgeSec);
        if (!timing.ok) {
          // Refused before any gas: for example a closed market, with no Pyth price in the ten minutes after the post
          refuse(GATE_ERRORS[timing.reason]);
          continue;
        }
        const opened = await this.deps.vault.openTrigger({
          ruleId: rule.id,
          asset: asset.key,
          account: account.handle,
          postId: post.id,
          p0: p0Update,
        });
        this.settled.add(settledKey);
        costs.transaction(opened, [rule.id], `open ${post.id}`);
        decisions?.recordOutcome(post.id, rule.id, asset.key, 1, 'opened', opened.txHash, opened.triggerId);
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
          p0: formatPrice(p0.price),
          t0: p0.sourceTime,
          opensAt: p0.sourceTime + params.minWaitSec,
          closesAt: p0.sourceTime + params.maxWindowSec,
          thresholdBps: params.trendThresholdBps,
          spikeCapBps: params.spikeCapBps,
          ...transactionFields(opened),
        });
      } catch (error) {
        if (error instanceof VaultRejection) {
          refuse(error.reason);
        } else {
          // A failed fetch or RPC call says nothing about the post, so the next poll tries again
          retry = true;
          prices.delete(asset.key);
          log.append({ kind: 'error', where: `opening ${asset.key}, will retry`, message: errorMessage(error) });
        }
      }
    }
    return retry;
  }

  // Brings P1 to each open trigger once its window opens, and expires the ones whose window closed. Each pass reads the
  // rules in force, so a changed rule's window applies at once, and an asset taken out of the rule expires its trigger.
  async checkPending(): Promise<void> {
    const { log, now, profiles, decisions, costs = noCosts } = this.deps;
    if (this.pending.size === 0) return;
    const interval = this.deps.p1IntervalSec ?? 30;
    let rules: Rule[] | undefined;
    try {
      rules = await this.deps.vault.listRules();
    } catch (error) {
      log.append({ kind: 'error', where: 'reading rules for Gate 2', message: errorMessage(error) });
    }
    for (const trigger of this.pending.values()) {
      if (rules) {
        const rule = rules.find((entry) => sameId(entry.id, trigger.ruleId));
        trigger.params = rule?.assets.find((entry) => entry.asset === trigger.asset) ?? closedWindow(trigger.asset);
      }
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
        p1 = readPythPrice(getAsset(profiles, trigger.asset), await this.deps.prices.latest(trigger.asset));
      } catch (error) {
        log.append({ kind: 'error', where: `P1 ${trigger.asset}`, message: errorMessage(error) });
        continue;
      }
      // A closed market publishes no new price; the trigger waits for the open or its window
      if (!isPriceFresh(profiles, p1, now())) continue;
      const trend = checkTrend(trigger.p0, p1, trigger.params);
      log.append({
        kind: 'trigger.checked',
        triggerId: trigger.triggerId,
        asset: trigger.asset,
        p1: formatPrice(p1.price),
        changeBps: changeBps(trigger.p0.price, p1.price),
        verdict: trend.ok ? 'submitting' : describeGateFailure[trend.reason],
      });
      if (!trend.ok) {
        if (trend.reason === 'above-spike-cap') trigger.abandoned = true;
        continue;
      }
      try {
        const bought = await this.deps.vault.confirmTrigger(trigger.triggerId, p1.update);
        this.pending.delete(trigger.triggerId);
        costs.transaction(bought, [trigger.ruleId], `confirm ${trigger.triggerId}`);
        decisions?.recordTriggerOutcome(trigger.triggerId, 'bought', bought.txHash);
        log.append({
          kind: 'trigger.bought',
          triggerId: trigger.triggerId,
          positionId: bought.positionId,
          asset: trigger.asset,
          usdcIn: formatUnits(bought.usdcIn, profiles.usdcDecimals),
          assetOut: formatUnits(bought.assetOut, 18),
          price: formatPrice(bought.price),
          ...transactionFields(bought),
        });
      } catch (error) {
        const reason = error instanceof VaultRejection ? error.reason : errorMessage(error);
        log.append({ kind: 'trigger.rejected', triggerId: trigger.triggerId, asset: trigger.asset, stage: 'confirm', reason });
        if (error instanceof VaultRejection) decisions?.recordTriggerOutcome(trigger.triggerId, reason);
        if (TERMINAL_CONFIRM_REJECTIONS.has(reason)) trigger.abandoned = true;
      }
    }
  }

  private async expire(trigger: PendingTrigger) {
    let expired: Expired | void = undefined;
    try {
      expired = await this.deps.vault.expireTrigger(trigger.triggerId);
    } catch (error) {
      if (!(error instanceof VaultRejection && error.reason === 'TriggerNotOpen')) {
        this.deps.log.append({ kind: 'error', where: `expire ${trigger.triggerId}`, message: errorMessage(error) });
        return;
      }
    }
    this.pending.delete(trigger.triggerId);
    (this.deps.costs ?? noCosts).transaction(expired, [trigger.ruleId], `expire ${trigger.triggerId}`);
    this.deps.decisions?.recordTriggerOutcome(trigger.triggerId, 'expired', expired ? expired.txHash : undefined);
    this.deps.log.append({
      kind: 'trigger.expired',
      triggerId: trigger.triggerId,
      asset: trigger.asset,
      ...transactionFields(expired),
    });
  }
}
