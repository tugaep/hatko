import type { SearchResult } from '@hatko/shared';
import type { Db } from '../db/client.ts';
import { hybridSearch, type HybridOptions } from './search.ts';
import { rerank, type RerankOptions } from './rerank.ts';

/**
 * Retrieve, judge, then cut, in that order.
 *
 * This exists because the order was wrong, and wrong in a way that cost retrieval its most
 * important correction. Both surfaces used to call
 * `hybridSearch({ limit })` and then `rerank`, which truncates to the caller's `limit`
 * *before* anything reads the passages, so the reranker could only reorder a set that had
 * already been decided by fused score. `limit` is caller-supplied on `/api/search` and on
 * the MCP tool, from 1 to 20.
 *
 * Measured, on sample question 3 ("Why are sound assets built in a separate pass?"):
 *
 *   limit=1  guides/asset-naming.md   fused 0.174   judged 0.67
 *   limit=6  build-pipeline.md        fused 0.168   judged 1.00
 *
 * At `limit=1` the document that answers the question was not in the response at all. It
 * loses on fused score and wins on judged relevance, which is the entire reason a rerank
 * pass exists — `rerank.ts` says it plainly: "Fusion gets the right document into the top
 * few but not always first." A caller asking for one passage was getting the one fusion
 * liked, not the one that answers.
 *
 * So the candidate pool is a floor, independent of `limit`: draw at least
 * `MIN_RERANK_CANDIDATES`, grade all of them, and only then return the caller's `limit`.
 * A caller asking for more than the floor gets a deeper pool rather than a shallower one,
 * so `limit` can only ever widen what gets judged.
 *
 * One function rather than the same three lines in three places, for the reason
 * `requireMcpPermission` gives about authorization: two implementations of one decision are
 * two things to keep in step, and the one that drifts is the one nobody looks at. This was
 * that drift — the answer path happened to be correct because its depth is fixed at 6,
 * while the two surfaces a caller can set a limit on were not.
 */

/**
 * Passages graded before the caller's `limit` is applied.
 *
 * Six. `DEFAULT_ANSWER_PASSAGES` is defined as this value rather than its own literal, so
 * the answer path, both search surfaces and the eval all read to one depth. That is what
 * keeps the measured recall figures describing the shipped system rather than a nearby one,
 * and it means a passage good enough to be cited in an answer is one a search can surface.
 */
export const MIN_RERANK_CANDIDATES = 6;

export interface RetrieveOptions
  extends Omit<HybridOptions, 'limit' | 'candidates' | 'rrfK'>, RerankOptions {
  /** Passages to return after grading. */
  limit: number;
}

export async function retrieveAndRerank(
  db: Db,
  query: string,
  options: RetrieveOptions,
): Promise<SearchResult[]> {
  const { limit, grader, signal, ...search } = options;

  const candidates = await hybridSearch(db, query, {
    ...search,
    // The floor. Never fewer than this reach the grader, however few the caller wants back.
    limit: Math.max(limit, MIN_RERANK_CANDIDATES),
    ...(signal ? { signal } : {}),
  });

  const graded = await rerank(query, candidates, {
    ...(grader ? { grader } : {}),
    ...(signal ? { signal } : {}),
  });

  return graded.slice(0, limit);
}
