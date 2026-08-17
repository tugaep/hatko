import { z } from 'zod';
import type { SearchResult } from '@hatko/shared';
import { chatJson } from '../providers/openai.ts';
import { activeModels } from '../settings.ts';

/**
 * LLM reranking, doing two jobs.
 *
 * **Ordering.** Fusion gets the right document into the top few but not always
 * first. Measured on the eval set, the keyword arm alone reaches 100% recall@3
 * and 89% recall@1, and the single rank-1 miss is sample-2: BM25 puts the
 * deprecated `sdk-notes-v2` above the current `sdk-notes-v3`, because v2 mentions
 * `lumen.track` more prominently than the document that replaced it. No amount of
 * lexical or vector tuning fixes that — it needs a reader that understands one
 * document says "deprecated, see v3".
 *
 * **Absolute relevance, which is what makes abstention possible.** RRF scores
 * carry no information about match quality: the top result always scores the same
 * constant — 1/(k+1) for whatever k is in force — whether the passage answers the
 * question or is merely the least bad of 142. The eval confirms it: top-1 scores are
 * identical for questions the corpus answers and questions it cannot. So there is no
 * threshold to set on retrieval score, and "does the corpus actually cover this" has to
 * be judged by reading the passages. That judgement is this grade.
 *
 * Grades are absolute rather than a ranking, so a query where everything is
 * irrelevant returns all zeros rather than crowning a winner by default.
 */

export const RELEVANCE = {
  UNRELATED: 0,
  SAME_TOPIC: 1,
  PARTIAL: 2,
  DIRECT: 3,
} as const;

/**
 * The abstain threshold, in grade terms: a passage must at least partially answer
 * the question to be worth grounding an answer in. Grade 1 is the important
 * exclusion — "same topic, does not answer" is exactly what a plausible but
 * unanswerable question retrieves, e.g. asking the maximum file size for a TikTok
 * playable and getting the AppLovin spec.
 */
export const MIN_USEFUL_GRADE = RELEVANCE.PARTIAL;

const SYSTEM_PROMPT = `You grade how well each passage answers a question about an internal document corpus.

For every passage you are given, assign a grade:
3 - directly answers the question
2 - partially answers it, or answers part of a multi-part question
1 - same topic or shares vocabulary, but does not answer the question
0 - unrelated

Grade each passage on its own merits against the question. Do not rank them
relative to one another, and do not award a high grade merely because a passage is
the best of a weak set: if nothing answers the question, every grade should be 0
or 1. That outcome is expected and useful.

Match the specific subject of the question, not just its topic. If the question
names a particular network, product, version, team or time period, a passage about
a *different* one does not answer it — grade it at most 1, however closely the
wording matches. A question about limits for network X is not answered by the
limits for network Y.

A passage from a document marked deprecated should be graded on whether it answers
the question as asked. If the question asks about current practice, a deprecated
document describing superseded practice does not answer it.

Reply with JSON only: {"grades":[{"id":<passage id>,"grade":<0-3>}]}
Include every passage id exactly once.`;

const gradeSchema = z.object({
  grades: z.array(
    z.object({ id: z.coerce.number().int(), grade: z.coerce.number().min(0).max(3) }),
  ),
});

export interface RerankOptions {
  /** Injectable so tests and the eval can run without a provider. */
  grader?: (query: string, candidates: SearchResult[]) => Promise<Map<number, number>>;
  signal?: AbortSignal;
}

/** Passages are truncated so a long candidate cannot crowd out the rest. */
const MAX_PASSAGE_CHARS = 1200;

function buildPrompt(query: string, candidates: SearchResult[]): string {
  const passages = candidates
    .map((candidate) => {
      const deprecated = candidate.isDeprecated
        ? ` [DEPRECATED${candidate.supersededBy ? `, superseded by ${candidate.supersededBy}` : ''}]`
        : '';
      const body = candidate.content.slice(0, MAX_PASSAGE_CHARS);
      return `[id ${candidate.chunkId}] ${candidate.documentTitle}${deprecated}\n${body}`;
    })
    .join('\n\n---\n\n');

  return `Question: ${query}\n\nPassages:\n\n${passages}`;
}

async function gradeWithModel(
  query: string,
  candidates: SearchResult[],
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const raw = await chatJson({
    model: activeModels().rerankModel,
    system: SYSTEM_PROMPT,
    user: buildPrompt(query, candidates),
    signal,
  });

  const parsed = gradeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Reranker returned an unexpected shape: ${parsed.error.message}`);
  }

  return new Map(parsed.data.grades.map((g) => [g.id, g.grade]));
}

/**
 * Rerank candidates, returning them ordered by graded relevance.
 *
 * A passage the model did not grade keeps its fusion order behind everything it
 * did grade, rather than being dropped: an incomplete response should degrade the
 * ordering, never silently shrink the result set.
 *
 * If the provider call fails entirely, the caller gets the fusion order back with
 * null rerank scores. Retrieval that is merely unpolished beats retrieval that is
 * unavailable — but the null is visible, so the answer stage can tell that no
 * relevance judgement was made and refuse to abstain on the strength of one.
 */
export async function rerank(
  query: string,
  candidates: SearchResult[],
  options: RerankOptions = {},
): Promise<SearchResult[]> {
  if (candidates.length === 0) return [];

  const grader = options.grader ?? ((q, c) => gradeWithModel(q, c, options.signal));

  let grades: Map<number, number>;
  try {
    grades = await grader(query, candidates);
  } catch {
    return candidates.map((candidate) => ({ ...candidate, rerankScore: null }));
  }

  const graded = candidates.map((candidate, index) => {
    const grade = grades.get(candidate.chunkId);
    return {
      result: {
        ...candidate,
        rerankScore: grade === undefined ? null : grade / RELEVANCE.DIRECT,
      },
      grade,
      // Preserves fusion order as the tie-break, so equally-graded passages keep
      // the ordering retrieval already established rather than an arbitrary one.
      index,
    };
  });

  graded.sort((a, b) => {
    if (a.grade === undefined && b.grade === undefined) return a.index - b.index;
    if (a.grade === undefined) return 1;
    if (b.grade === undefined) return -1;
    return b.grade - a.grade || a.index - b.index;
  });

  return graded.map((entry) => entry.result);
}

/**
 * Whether any passage is relevant enough to ground an answer.
 *
 * Returns null when nothing was graded — the distinction between "judged
 * irrelevant" and "not judged" matters, because abstaining on the basis of a
 * judgement that never happened would turn a provider outage into a confident
 * claim that the corpus lacks the answer.
 */
export function hasGroundedSupport(results: SearchResult[]): boolean | null {
  const scored = results.filter((result) => result.rerankScore !== null);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((result) => result.rerankScore as number));
  return best >= MIN_USEFUL_GRADE / RELEVANCE.DIRECT;
}
