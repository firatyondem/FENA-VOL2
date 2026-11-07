// The cheap path to a verdict: the keyword filter first, so a post that names none of a rule's topics never reaches a
// model; then the verdict cache, so a post is never classified twice, also across restarts; then the small model, and the
// large one only for the assets the small one is unsure about.
import type { Db } from '../store/db.ts';
import { KeywordClassifier } from './keyword.ts';
import type { Candidate, Classification, Classifier, ModelUsage, PostForClassification } from './types.ts';

export const FILTER = 'keyword-filter';
export const CACHE = 'cache';

export class VerdictCache {
  private readonly db: Db;
  private readonly nowMs: () => number;

  constructor(db: Db, nowMs: () => number = Date.now) {
    this.db = db;
    this.nowMs = nowMs;
  }

  get(tweetId: string, asset: string): Classification | undefined {
    const row = this.db
      .prepare('SELECT relevant, confidence, reason, model FROM verdicts WHERE tweet_id = ? AND asset = ?')
      .get(tweetId, asset) as { relevant: number; confidence: number; reason: string; model: string } | undefined;
    return row && { asset, relevant: row.relevant === 1, confidence: row.confidence, reason: row.reason, by: row.model };
  }

  set(tweetId: string, result: Classification): void {
    this.db
      .prepare(
        `INSERT INTO verdicts (tweet_id, asset, relevant, confidence, reason, model, at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tweet_id, asset) DO UPDATE SET relevant = excluded.relevant, confidence = excluded.confidence,
         reason = excluded.reason, model = excluded.model, at = excluded.at`
      )
      .run(tweetId, result.asset, result.relevant ? 1 : 0, result.confidence, result.reason, result.by ?? '', this.nowMs());
  }
}

export interface TieredClassifierOptions {
  small: Classifier;
  // Without it, the small model's answer stands
  large?: Classifier;
  cache?: VerdictCache;
  // A relevant answer below this confidence counts as unsure and goes to the large model
  escalateBelow?: number;
  keywords?: Classifier;
}

// True when every candidate was answered by the keyword filter: the post never reached a model
export const skippedByFilter = (results: readonly Classification[]) =>
  results.length > 0 && results.every((result) => result.by === FILTER);

export class TieredClassifier implements Classifier {
  readonly name: string;
  private readonly options: TieredClassifierOptions & { escalateBelow: number; keywords: Classifier };

  constructor(options: TieredClassifierOptions) {
    this.options = { escalateBelow: 0.7, keywords: new KeywordClassifier(), ...options };
    this.name = options.large ? `${options.small.name} → ${options.large.name}` : options.small.name;
  }

  async classify(
    post: PostForClassification,
    candidates: Candidate[],
    meter?: (usage: ModelUsage) => void
  ): Promise<Classification[]> {
    if (candidates.length === 0) return [];
    const { small, large, cache, escalateBelow, keywords } = this.options;

    // 1. Keywords: no topic of any candidate in the post, so no model call
    const hits = await keywords.classify(post, candidates);
    if (!hits.some((hit) => hit.relevant)) {
      return candidates.map((candidate) => ({
        asset: candidate.asset,
        relevant: false,
        confidence: 0,
        reason: 'Names none of the rule’s topics',
        by: FILTER,
      }));
    }

    // 2. The cache: what an earlier poll or run already decided for this post
    const cached = new Map<string, Classification>();
    if (cache && post.id) {
      for (const candidate of candidates) {
        const hit = cache.get(post.id, candidate.asset);
        if (hit) cached.set(candidate.asset, { ...hit, by: CACHE });
      }
    }
    const open = candidates.filter((candidate) => !cached.has(candidate.asset));
    if (open.length === 0) return candidates.map((candidate) => cached.get(candidate.asset) as Classification);

    // 3. The small model for the rest; 4. the large one for the assets it is unsure about
    const answers = new Map((await small.classify(post, open, meter)).map((result) => [result.asset, result]));
    const unsure = open.filter((candidate) => {
      const answer = answers.get(candidate.asset);
      return !answer || (answer.relevant && answer.confidence < escalateBelow);
    });
    if (large && unsure.length > 0) {
      for (const result of await large.classify(post, unsure, meter)) answers.set(result.asset, result);
    }

    const results: Classification[] = [];
    for (const candidate of candidates) {
      const result = cached.get(candidate.asset) ?? answers.get(candidate.asset);
      if (!result) continue;
      results.push(result);
      if (cache && post.id && !cached.has(candidate.asset)) cache.set(post.id, result);
    }
    return results;
  }
}
