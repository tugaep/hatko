import { searchResultSchema, type SearchResult } from '@sorrel/shared';
import { toVectorBlob, type Db } from '../db/client.ts';
import { embedOne } from '../providers/openai.ts';
import { toFtsQuery } from './query.ts';

/**
 * Hybrid retrieval: dense vectors and BM25, fused by Reciprocal Rank Fusion.
 *
 * Why both arms. The corpus contains 78 near-identical delivery reports, and
 * embeddings of near-identical text are near-identical vectors — so a purely
 * semantic search answers "why are sound assets built in a separate pass" with a
 * wall of delivery reports that all talk vaguely about builds and audio. The
 * lexical arm rescues it, because "separate pass" is a literal phrase in exactly
 * one document. The converse also holds: BM25 alone cannot match a question
 * phrased entirely in different words from the document, and the porter stemmer
 * does not bridge irregular forms (`built` never meets `building`). Each arm
 * covers the other's blind spot.
 *
 * Why RRF rather than a weighted score blend. Cosine distance and BM25 are not
 * commensurable — BM25 is unbounded, corpus-relative and negative in SQLite,
 * cosine is bounded 0..2 — so any weighted sum needs normalisation constants that
 * are really just fitted to one corpus. RRF discards the magnitudes and fuses the
 * *ranks*, which is scale-free.
 *
 * RRF is not, however, parameter-free, and its usual defaults are wrong here.
 * With the literature's k=60 and a 30-candidate pool, hybrid retrieval scored
 * *worse* than the keyword arm alone — recall@1 78% against 89% — because summing
 * 1/(k+rank) across arms rewards appearing mediocrely in both over appearing first
 * in one. Both constants below were then chosen by sweeping them against the eval
 * set. Measured outcome after tuning, with the rerank pass:
 *
 *   arm       recall@1  recall@3   MRR
 *   keyword     100%      100%    1.000
 *   vector       89%       89%    0.889
 *   hybrid      100%      100%    1.000
 *
 * Hybrid matching rather than beating keyword-only on this corpus is worth
 * stating plainly: the sample questions share vocabulary with their answers, which
 * is the case BM25 is best at. The vector arm earns its place as insurance for
 * queries phrased in words the corpus does not use — the private evaluation set is
 * unseen — and it now costs nothing in accuracy to carry it.
 */

/**
 * RRF damping. Larger values flatten the advantage of a high rank, which makes
 * "retrieved by both arms" outweigh "retrieved first by one arm".
 *
 * The literature's k=60 comes from TREC runs fusing ~1000 candidates. Against 142
 * chunks it is far too large: a rank-1 hit found by one arm scores 1/61 = 0.0164,
 * while a mediocre rank-20 hit found by both scores 1/80 + 1/80 = 0.025 and wins.
 * Measured on the eval set, k=60 dropped localization-guide.md from keyword rank 1
 * to outside the hybrid top 30. The default here is chosen by sweep, not by
 * citation — see the eval script.
 */
const DEFAULT_RRF_K = 10;

/**
 * Candidates drawn from each arm before fusion.
 *
 * The sweep found this matters more than k: at depth 10 the hybrid arm reaches
 * recall@3 of 100%, at depth 20-30 it drops to 89% for every value of k tried.
 * The reason is proportional — 30 candidates out of 142 chunks is a fifth of the
 * corpus, so almost everything appears in both arms and the summed score rewards
 * being mediocre twice over being right once. This should grow with the corpus,
 * not stay fixed: it is a fraction of the collection, not an absolute.
 */
const DEFAULT_CANDIDATES = 10;

/**
 * Column weights for bm25(heading, content). The heading is a stronger relevance
 * signal per word than body text, but most chunks here span a whole document and
 * carry no section heading, so this rarely fires — it matters for corpora with
 * longer, more sectioned documents.
 */
const BM25_HEADING_WEIGHT = 2.0;
const BM25_CONTENT_WEIGHT = 1.0;

/**
 * Which retrieval arms to use. `hybrid` is the product behaviour; the single-arm
 * modes exist so the eval script can measure what each contributes, which is the
 * only way to justify the added complexity of running two.
 */
export type RetrievalArm = 'hybrid' | 'vector' | 'keyword';

export interface HybridOptions {
  /** Passages to return. */
  limit?: number;
  /** Candidates drawn from each arm before fusion. */
  candidates?: number;
  category?: string;
  arm?: RetrievalArm;
  /** RRF damping constant. Defaults to DEFAULT_RRF_K; exposed so the eval can sweep it. */
  rrfK?: number;
  /** Injectable for tests; defaults to the OpenAI embeddings client. */
  embedder?: (text: string) => Promise<number[]>;
  signal?: AbortSignal;
}

interface FusedRow {
  id: number;
  document_id: number;
  ordinal: number;
  heading: string | null;
  content: string;
  title: string;
  source_path: string;
  category: string;
  is_deprecated: number;
  superseded_by: string | null;
  distance: number | null;
  vec_rank: number | null;
  bm25: number | null;
  kw_rank: number | null;
  rrf: number;
}

/**
 * One statement, because the three stores share an integer key space: chunks.id
 * is the rowid in both chunks_vec and chunks_fts, so the two arms return
 * comparable identifiers and can be fused with a full outer join and hydrated
 * with metadata in the same pass.
 *
 * The full outer join is what keeps a passage found by only one arm — which is
 * the entire point of running two.
 */
const fusionSql = (rrfK: number) => `
WITH vec AS (
  SELECT rowid AS chunk_id,
         distance,
         ROW_NUMBER() OVER (ORDER BY distance) AS rank
  FROM chunks_vec
  WHERE embedding MATCH :vector AND k = :candidates
),
kw AS (
  -- bm25() is an FTS5 auxiliary function and may only be called in a query
  -- directly against the fts table, not inside a window function's ORDER BY.
  -- Hence the inner select: score there, rank over the alias out here.
  SELECT chunk_id, bm25, ROW_NUMBER() OVER (ORDER BY bm25) AS rank
  FROM (
    SELECT rowid AS chunk_id,
           bm25(chunks_fts, ${BM25_HEADING_WEIGHT}, ${BM25_CONTENT_WEIGHT}) AS bm25
    FROM chunks_fts
    WHERE chunks_fts MATCH :ftsQuery
    ORDER BY 2
    LIMIT :candidates
  )
)
SELECT
  c.id, c.document_id, c.ordinal, c.heading, c.content,
  d.title, d.source_path, d.category, d.is_deprecated, d.superseded_by,
  vec.distance, vec.rank AS vec_rank,
  kw.bm25, kw.rank AS kw_rank,
  COALESCE(1.0 / (${rrfK} + vec.rank), 0) + COALESCE(1.0 / (${rrfK} + kw.rank), 0) AS rrf
FROM vec
FULL OUTER JOIN kw ON kw.chunk_id = vec.chunk_id
JOIN chunks    c ON c.id = COALESCE(vec.chunk_id, kw.chunk_id)
JOIN documents d ON d.id = c.document_id
ORDER BY rrf DESC
`;

/** Vector-only, for when a query yields no usable keyword terms. */
const vectorOnlySql = (rrfK: number) => `
WITH vec AS (
  SELECT rowid AS chunk_id,
         distance,
         ROW_NUMBER() OVER (ORDER BY distance) AS rank
  FROM chunks_vec
  WHERE embedding MATCH :vector AND k = :candidates
)
SELECT
  c.id, c.document_id, c.ordinal, c.heading, c.content,
  d.title, d.source_path, d.category, d.is_deprecated, d.superseded_by,
  vec.distance, vec.rank AS vec_rank,
  NULL AS bm25, NULL AS kw_rank,
  1.0 / (${rrfK} + vec.rank) AS rrf
FROM vec
JOIN chunks    c ON c.id = vec.chunk_id
JOIN documents d ON d.id = c.document_id
ORDER BY rrf DESC
`;

/** Keyword-only. Needs no embedding call, so the eval can run it without a key. */
const keywordOnlySql = (rrfK: number) => `
WITH kw AS (
  SELECT chunk_id, bm25, ROW_NUMBER() OVER (ORDER BY bm25) AS rank
  FROM (
    SELECT rowid AS chunk_id,
           bm25(chunks_fts, ${BM25_HEADING_WEIGHT}, ${BM25_CONTENT_WEIGHT}) AS bm25
    FROM chunks_fts
    WHERE chunks_fts MATCH :ftsQuery
    ORDER BY 2
    LIMIT :candidates
  )
)
SELECT
  c.id, c.document_id, c.ordinal, c.heading, c.content,
  d.title, d.source_path, d.category, d.is_deprecated, d.superseded_by,
  NULL AS distance, NULL AS vec_rank,
  kw.bm25, kw.rank AS kw_rank,
  1.0 / (${rrfK} + kw.rank) AS rrf
FROM kw
JOIN chunks    c ON c.id = kw.chunk_id
JOIN documents d ON d.id = c.document_id
ORDER BY rrf DESC
`;

/** Cosine distance (0..2) to a 0..1 similarity, for display. */
const similarityOf = (distance: number | null) =>
  distance === null ? null : Math.max(0, Math.min(1, 1 - distance / 2));

/**
 * BM25 to a 0..1 display score.
 *
 * SQLite returns bm25() as a negative number, more negative being a better
 * match, and its magnitude is corpus- and query-relative with no fixed ceiling.
 * There is no honest absolute normalisation, so this is scaled against the best
 * score in the current result set: it is a within-result comparison only, which
 * is all the UI uses it for. Ranking never depends on it — that is RRF's job.
 */
function normaliseBm25(rows: FusedRow[]): Map<number, number> {
  const scored = rows.filter((row) => row.bm25 !== null);
  const best = Math.min(...scored.map((row) => row.bm25 as number));
  const out = new Map<number, number>();

  for (const row of scored) {
    const value = row.bm25 as number;
    out.set(row.id, best === 0 ? 1 : Math.max(0, Math.min(1, value / best)));
  }
  return out;
}

function toSearchResult(row: FusedRow, keywordScores: Map<number, number>): SearchResult {
  return searchResultSchema.parse({
    chunkId: Number(row.id),
    documentId: Number(row.document_id),
    documentTitle: row.title,
    sourcePath: row.source_path,
    category: row.category,
    heading: row.heading,
    content: row.content,
    ordinal: Number(row.ordinal),
    score: row.rrf,
    vectorScore: similarityOf(row.distance),
    keywordScore: keywordScores.get(Number(row.id)) ?? null,
    rerankScore: null,
    isDeprecated: Boolean(row.is_deprecated),
    supersededBy: row.superseded_by,
  });
}

/**
 * Retrieve passages for a query.
 *
 * Deprecated documents are returned rather than filtered out. Suppressing them
 * would hide legitimately relevant history, and a question specifically about v2
 * should still find v2 — the flag travels with the result so the answer can say
 * the document is superseded.
 */
export async function hybridSearch(
  db: Db,
  query: string,
  options: HybridOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 8;
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const arm = options.arm ?? 'hybrid';
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const embedder = options.embedder ?? ((text: string) => embedOne(text, options.signal));

  const ftsQuery = toFtsQuery(query);

  // The category filter is applied after fusion rather than inside the vector
  // scan, because vec0 can only filter on columns declared in the virtual table
  // and this one holds embeddings alone. Widening the candidate pool compensates:
  // at 142 chunks the extra scan is free.
  const poolSize = options.category ? Math.max(candidates * 4, 100) : candidates;

  // A query with no usable keyword terms has no lexical arm — falling back to
  // vector-only is correct, and passing an empty string to MATCH would be a
  // syntax error rather than an empty result.
  const useKeyword = arm !== 'vector' && ftsQuery !== null;
  const useVector = arm !== 'keyword';

  if (!useKeyword && !useVector) return [];

  let rows: FusedRow[];
  if (useKeyword && useVector) {
    const vector = toVectorBlob(await embedder(query));
    rows = db
      .prepare(fusionSql(rrfK))
      .all({ vector, candidates: poolSize, ftsQuery: ftsQuery! }) as unknown as FusedRow[];
  } else if (useVector) {
    const vector = toVectorBlob(await embedder(query));
    rows = db
      .prepare(vectorOnlySql(rrfK))
      .all({ vector, candidates: poolSize }) as unknown as FusedRow[];
  } else {
    rows = db
      .prepare(keywordOnlySql(rrfK))
      .all({ ftsQuery: ftsQuery!, candidates: poolSize }) as unknown as FusedRow[];
  }

  const filtered = options.category
    ? rows.filter((row) => row.category === options.category)
    : rows;

  const top = filtered.slice(0, limit);
  const keywordScores = normaliseBm25(top);

  return top.map((row) => toSearchResult(row, keywordScores));
}
