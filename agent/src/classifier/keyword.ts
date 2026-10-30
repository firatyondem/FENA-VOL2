import type { Candidate, Classification, Classifier, PostForClassification } from './types.ts';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Matches whole words and phrases, ignoring case, so "Iran" matches "Iran's" but not "Tirana".
const topicPattern = (topic: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(topic)}(?=$|[^\\p{L}\\p{N}])`, 'iu');

// The baseline the LLM is measured against, and the fallback when no model is configured. It reads words, not meaning,
// so it misses sarcasm, vague threats and paraphrases; the demo shows one post where it fails.
export class KeywordClassifier implements Classifier {
  readonly name = 'keywords';

  async classify(post: PostForClassification, candidates: Candidate[]): Promise<Classification[]> {
    return candidates.map((candidate) => {
      const hits = candidate.topics.filter((topic) => topicPattern(topic).test(post.text));
      return {
        asset: candidate.asset,
        relevant: hits.length > 0,
        confidence: hits.length === 0 ? 0 : Math.min(0.9, 0.5 + 0.2 * hits.length),
        reason: hits.length > 0 ? `Mentions ${hits.join(', ')}` : 'No topic keyword',
      };
    });
  }
}
