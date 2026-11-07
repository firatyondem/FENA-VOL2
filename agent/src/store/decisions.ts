// The decision log: for every post the agent sees, what the classifier said and why, and for each user and asset what
// the vault did with it. GET /api/decisions reads it. It holds no keys: posts, verdicts, outcomes and transaction hashes.
import type { Db } from './db.ts';

export type Verdict = 'relevant' | 'not-relevant' | 'skipped-by-filter' | 'pending';

export interface DecisionAsset {
  assetId: string;
  // 1 opens the price check, 2 buys
  gate: 1 | 2;
  // opened | bought | expired | the vault's error name, such as TrendTooWeak
  outcome: string;
  txHash?: string;
}

export interface Decision {
  tweetId: string;
  account: string;
  text: string;
  // Seconds since the epoch
  createdAt: number;
  verdict: Verdict;
  reason: string;
  classifier: string;
  assets: DecisionAsset[];
}

export interface PostRecord {
  tweetId: string;
  account: string;
  text: string;
  createdAt: number;
  // The users whose rule watched the account when the post came in
  users: readonly string[];
}

export class DecisionLog {
  private readonly db: Db;
  private readonly nowMs: () => number;

  constructor(db: Db, nowMs: () => number = Date.now) {
    this.db = db;
    this.nowMs = nowMs;
  }

  recordPost(post: PostRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO decisions (tweet_id, account, text, created_at, seen_at, verdict, reason, classifier)
         VALUES (?, ?, ?, ?, ?, 'pending', '', '')`
      )
      .run(post.tweetId, post.account, post.text, post.createdAt, this.nowMs());
    const link = this.db.prepare('INSERT OR IGNORE INTO decision_users (tweet_id, user) VALUES (?, ?)');
    for (const user of post.users) link.run(post.tweetId, user.toLowerCase());
  }

  recordVerdict(tweetId: string, verdict: Verdict, reason: string, classifier: string): void {
    this.db
      .prepare('UPDATE decisions SET verdict = ?, reason = ?, classifier = ? WHERE tweet_id = ?')
      .run(verdict, reason.slice(0, 500), classifier, tweetId);
  }

  // One outcome for a user and asset; a later outcome of the same gate replaces it, so a retry reads as its result
  recordOutcome(
    tweetId: string,
    user: string,
    asset: string,
    gate: 1 | 2,
    outcome: string,
    txHash?: string,
    triggerId?: string
  ): void {
    const key = user.toLowerCase();
    this.db
      .prepare('DELETE FROM decision_assets WHERE tweet_id = ? AND user = ? AND asset = ? AND gate = ?')
      .run(tweetId, key, asset, gate);
    this.db
      .prepare(
        'INSERT INTO decision_assets (tweet_id, user, asset, gate, outcome, tx_hash, trigger_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(tweetId, key, asset, gate, outcome, txHash ?? null, triggerId ?? null, this.nowMs());
  }

  // Gate 2's outcome for the post that opened `triggerId`
  recordTriggerOutcome(triggerId: string, outcome: string, txHash?: string): void {
    const opened = this.db
      .prepare('SELECT tweet_id, user, asset FROM decision_assets WHERE trigger_id = ? AND gate = 1')
      .get(triggerId) as { tweet_id: string; user: string; asset: string } | undefined;
    if (opened) this.recordOutcome(opened.tweet_id, opened.user, opened.asset, 2, outcome, txHash, triggerId);
  }

  // Newest first; for one user (the posts of the accounts their rule watched) or '*' for all
  list(user: string, limit = 50): Decision[] {
    const key = user.toLowerCase();
    const posts = (
      key === '*'
        ? this.db.prepare('SELECT * FROM decisions ORDER BY created_at DESC, tweet_id DESC LIMIT ?').all(limit)
        : this.db
            .prepare(
              `SELECT d.* FROM decisions d JOIN decision_users u ON u.tweet_id = d.tweet_id
               WHERE u.user = ? ORDER BY d.created_at DESC, d.tweet_id DESC LIMIT ?`
            )
            .all(key, limit)
    ) as {
      tweet_id: string;
      account: string;
      text: string;
      created_at: number;
      verdict: Verdict;
      reason: string;
      classifier: string;
    }[];
    const assetsOf = this.db.prepare(
      `SELECT asset, gate, outcome, tx_hash FROM decision_assets WHERE tweet_id = ? ${key === '*' ? '' : 'AND user = ?'}
       ORDER BY asset, gate`
    );
    return posts.map((post) => ({
      tweetId: post.tweet_id,
      account: post.account,
      text: post.text,
      createdAt: post.created_at,
      verdict: post.verdict,
      reason: post.reason,
      classifier: post.classifier,
      assets: (
        assetsOf.all(...(key === '*' ? [post.tweet_id] : [post.tweet_id, key])) as {
          asset: string;
          gate: number;
          outcome: string;
          tx_hash: string | null;
        }[]
      ).map((row) => ({
        assetId: row.asset,
        gate: row.gate as 1 | 2,
        outcome: row.outcome,
        ...(row.tx_hash ? { txHash: row.tx_hash } : {}),
      })),
    }));
  }
}
