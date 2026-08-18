import type { EvalQuestion } from './questions.ts';

/**
 * The arithmetic behind the reported retrieval figures.
 *
 * Its own module so it can be run by a test. `run.ts` is a script — importing it
 * executes an eval — so while this lived there, the numbers this repository quotes as
 * evidence (recall@1, MRR) were the one part of the retrieval story with nothing
 * checking it. A metric that is wrong is worse than a metric that is missing: it reads
 * as measurement and it never fails.
 *
 * The two conventions that a reader has to be able to trust, and that a test pins:
 * a question whose expected document was never retrieved contributes zero to MRR rather
 * than being dropped from the denominator, and unanswerable questions are excluded
 * entirely — they have no correct document, so recall is undefined for them, not zero.
 */

export interface QuestionResult {
  question: EvalQuestion;
  /** 1-based rank of the first expected document, or null if absent from the top-k pool. */
  rank: number | null;
  topScore: number | null;
  topDocument: string | null;
  /** Best rerank grade, 0..1. Null when reranking is off or unavailable. */
  bestRelevance: number | null;
  contextHit: boolean;
}

export interface EvalSummary {
  recall1: number;
  recall3: number;
  recallK: number;
  mrr: number;
  /** Answerable questions whose expected document did not make the top k. */
  misses: QuestionResult[];
  /** How many questions the figures above were averaged over. */
  answerable: number;
}

export function summarise(results: QuestionResult[], k: number): EvalSummary {
  const answerable = results.filter((r) => r.question.expected.length > 0);

  // An eval over no answerable questions has no recall, and 0/0 would report itself as
  // NaN in a table of percentages. Zero is the honest reading of "nothing was measured".
  if (answerable.length === 0) {
    return { recall1: 0, recall3: 0, recallK: 0, mrr: 0, misses: [], answerable: 0 };
  }

  const hitsAt = (at: number) =>
    answerable.filter((r) => r.rank !== null && r.rank <= at).length / answerable.length;

  // Mean reciprocal rank over answerable questions; a miss contributes zero.
  const mrr =
    answerable.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / answerable.length;

  return {
    recall1: hitsAt(1),
    recall3: hitsAt(3),
    recallK: hitsAt(k),
    mrr,
    misses: answerable.filter((r) => r.rank === null || r.rank > k),
    answerable: answerable.length,
  };
}
