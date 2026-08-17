import fs from 'node:fs';
import {
  dashboardStatsSchema,
  type CategoryBreakdown,
  type DashboardStats,
  type IndexHealth,
  type SearchStats,
} from '@sorrel/shared';
import { config } from '../config.ts';
import type { Db } from './client.ts';
import { listIngestionRuns } from './repository.ts';

/**
 * Dashboard statistics: what is indexed, whether the index is intact, and what
 * people are asking.
 */

/**
 * Index health.
 *
 * `embeddingsTotal` is read from chunks_vec separately rather than assumed equal
 * to `chunksTotal`, because the two are maintained by different mechanisms — a
 * foreign-key cascade and a trigger. If they ever diverge, retrieval is quietly
 * broken: passages exist that can never be found by vector search, or vectors
 * point at passages that no longer exist. Surfacing both numbers makes that
 * visible on the dashboard instead of leaving it to be inferred from bad answers.
 */
export function getIndexHealth(db: Db): IndexHealth {
  const counts = db
    .prepare(
      `SELECT
         count(*)                                            AS total,
         sum(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexed,
         sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         sum(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
         sum(is_deprecated)                                  AS deprecated
       FROM documents`,
    )
    .get() as Record<string, number | null>;

  const chunks = (db.prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n;
  const embeddings = (db.prepare('SELECT count(*) n FROM chunks_vec').get() as { n: number }).n;
  const total = Number(counts.total ?? 0);

  let databaseBytes = 0;
  try {
    databaseBytes = fs.statSync(config.databasePath).size;
  } catch {
    // An in-memory or freshly-removed database has no file. Reporting zero is
    // better than failing the whole dashboard over a cosmetic figure.
  }

  return {
    documentsTotal: total,
    documentsIndexed: Number(counts.indexed ?? 0),
    documentsPending: Number(counts.pending ?? 0),
    documentsFailed: Number(counts.failed ?? 0),
    documentsDeprecated: Number(counts.deprecated ?? 0),
    chunksTotal: Number(chunks),
    embeddingsTotal: Number(embeddings),
    avgChunksPerDocument: total === 0 ? 0 : Number((Number(chunks) / total).toFixed(2)),
    databaseBytes,
    lastRun: listIngestionRuns(db, 1)[0] ?? null,
  };
}

export function getCategoryBreakdown(db: Db): CategoryBreakdown[] {
  return (
    db
      .prepare(
        `SELECT d.category                AS category,
                count(DISTINCT d.id)     AS documents,
                count(c.id)              AS chunks
           FROM documents d
           LEFT JOIN chunks c ON c.document_id = d.id
          GROUP BY d.category
          ORDER BY documents DESC, category`,
      )
      .all() as Array<{ category: string; documents: number; chunks: number }>
  ).map((row) => ({
    category: row.category,
    documents: Number(row.documents),
    chunks: Number(row.chunks),
  }));
}

/**
 * Search analytics.
 *
 * `abstainRate` is the interesting figure and it is not a fault measure. A query
 * the corpus cannot answer is answered correctly by saying so, so a rising abstain
 * rate is a reading list — the documents the corpus is missing — which is why
 * recent abstained queries are listed verbatim.
 */
export function getSearchStats(db: Db): SearchStats {
  const totals = db
    .prepare(
      `SELECT
         count(*)                                           AS total,
         sum(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last7,
         sum(abstained)                                     AS abstained,
         avg(latency_ms)                                    AS avg_latency
       FROM search_queries`,
    )
    .get() as Record<string, number | null>;

  const total = Number(totals.total ?? 0);

  // SQLite has no percentile function. Ordering and indexing is exact, and the
  // row count here is small enough that a window over the whole table is cheap.
  const p95Row =
    total === 0
      ? undefined
      : (db
          .prepare(
            `SELECT latency_ms FROM search_queries
              ORDER BY latency_ms
              LIMIT 1 OFFSET max(0, CAST(? * 0.95 AS INTEGER) - 1)`,
          )
          .get(total) as { latency_ms: number } | undefined);

  const topQueries = (
    db
      .prepare(
        `SELECT query, count(*) AS count, sum(abstained) AS abstained_count
           FROM search_queries
          GROUP BY lower(trim(query))
          ORDER BY count DESC, query
          LIMIT 10`,
      )
      .all() as Array<{ query: string; count: number; abstained_count: number | null }>
  ).map((row) => ({
    query: row.query,
    count: Number(row.count),
    abstainedCount: Number(row.abstained_count ?? 0),
  }));

  const recentAbstains = (
    db
      .prepare(
        `SELECT query, created_at FROM search_queries
          WHERE abstained = 1
          ORDER BY id DESC
          LIMIT 10`,
      )
      .all() as Array<{ query: string; created_at: string }>
  ).map((row) => ({ query: row.query, createdAt: row.created_at }));

  const volumeByDay = (
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, count(*) AS count
           FROM search_queries
          WHERE created_at >= datetime('now', '-13 days')
          GROUP BY day
          ORDER BY day`,
      )
      .all() as Array<{ day: string; count: number }>
  ).map((row) => ({ day: row.day, count: Number(row.count) }));

  return {
    queriesTotal: total,
    queriesLast7Days: Number(totals.last7 ?? 0),
    abstainRate: total === 0 ? 0 : Number((Number(totals.abstained ?? 0) / total).toFixed(4)),
    avgLatencyMs: Math.round(Number(totals.avg_latency ?? 0)),
    p95LatencyMs: Number(p95Row?.latency_ms ?? 0),
    topQueries,
    recentAbstains,
    volumeByDay,
  };
}

export function getDashboardStats(db: Db): DashboardStats {
  return dashboardStatsSchema.parse({
    index: getIndexHealth(db),
    byCategory: getCategoryBreakdown(db),
    search: getSearchStats(db),
  });
}
