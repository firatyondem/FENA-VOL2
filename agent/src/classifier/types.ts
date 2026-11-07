// The relevance check is Gate 1's navigation: it decides which rule to check and when. It never moves money; the vault
// checks every condition against signed data.

// The fixed format from the spec, e.g. {"asset":"OIL","relevant":true,"confidence":0.85,"reason":"..."}
export interface Classification {
  asset: string;
  relevant: boolean;
  confidence: number;
  reason: string;
  // Who answered: the keyword filter, the verdict cache or a model's name
  by?: string;
}

// One model call, for the cost ledger
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

// An asset the post may be checked against: one of the account's assets that the user's rule also allows.
export interface Candidate {
  asset: string;
  name: string;
  topics: string[];
}

export interface PostForClassification {
  author: string;
  text: string;
  // The post's ID, which keys the verdict cache
  id?: string;
}

export interface Classifier {
  readonly name: string;
  // Returns one result per candidate at most; never an asset outside `candidates`. `meter` hears of every paid model
  // call.
  classify(post: PostForClassification, candidates: Candidate[], meter?: (usage: ModelUsage) => void): Promise<Classification[]>;
}

export type SkipReason = 'repost' | 'empty' | 'no-candidates';

// Removes what the spec says to ignore before any model runs.
export const prefilter = (
  post: PostForClassification & { isRepost: boolean },
  candidates: Candidate[]
): SkipReason | undefined => {
  if (candidates.length === 0) return 'no-candidates';
  if (post.isRepost) return 'repost';
  if (post.text.trim().length === 0) return 'empty';
  return undefined;
};

// Keeps only results for candidate assets, one per asset, with the confidence clamped to [0, 1].
export const sanitize = (results: Classification[], candidates: Candidate[]): Classification[] => {
  const allowed = new Set(candidates.map((candidate) => candidate.asset));
  const seen = new Set<string>();
  const kept: Classification[] = [];
  for (const result of results) {
    if (!allowed.has(result.asset) || seen.has(result.asset)) continue;
    seen.add(result.asset);
    const confidence = Number.isFinite(result.confidence) ? Math.min(1, Math.max(0, result.confidence)) : 0;
    kept.push({ ...result, confidence, reason: result.reason.slice(0, 280) });
  }
  return kept;
};
