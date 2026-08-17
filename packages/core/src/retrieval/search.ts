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
 * *ranks*, which is scale-free and needs no tuning. The single constant k=60 is
 * the value from the original paper and is not corpus-specific.
 */

/** Standard RRF damping. Larger values flatten the advantage of top ranks. */
const RRF_K = 60;

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
const FUSION_SQL = `
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
  COALESCE(1.0 / (${RRF_K} + vec.rank), 0) + COALESCE(1.0 / (${RRF_K} + kw.rank), 0) AS rrf
FROM vec
FULL OUTER JOIN kw ON kw.chunk_id = vec.chunk_id
JOIN chunks    c ON c.id = COALESCE(vec.chunk_id, kw.chunk_id)
JOIN documents d ON d.id = c.document_id
ORDER BY rrf DESC
`;

/** Vector-only, for when a query yields no usable keyword terms. */
const VECTOR_ONLY_SQL = `
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
  1.0 / (${RRF_K} + vec.rank) AS rrf
FROM vec
JOIN chunks    c ON c.id = vec.chunk_id
JOIN documents d ON d.id = c.document_id
ORDER BY rrf DESC
`;

/** Keyword-only. Needs no embedding call, so the eval can run it without a key. */
const KEYWORD_ONLY_SQL = `
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
  1.0 / (${RRF_K} + kw.rank) AS rrf
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
  const candidates = options.candidates ?? 20;
  const arm = options.arm ?? 'hybrid';
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
      .prepare(FUSION_SQL)
      .all({ vector, candidates: poolSize, ftsQuery: ftsQuery! }) as unknown as FusedRow[];
  } else if (useVector) {
    const vector = toVectorBlob(await embedder(query));
    rows = db
      .prepare(VECTOR_ONLY_SQL)
      .all({ vector, candidates: poolSize }) as unknown as FusedRow[];
  } else {
    rows = db
      .prepare(KEYWORD_ONLY_SQL)
      .all({ ftsQuery: ftsQuery!, candidates: poolSize }) as unknown as FusedRow[];
  }

  const filtered = options.category
    ? rows.filter((row) => row.category === options.category)
    : rows;

  const top = filtered.slice(0, limit);
  const keywordScores = normaliseBm25(top);

  return top.map((row) => toSearchResult(row, keywordScores));
}
