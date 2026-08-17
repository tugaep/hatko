import {
  chunkSchema,
  documentSchema,
  ingestionRunSchema,
  type Chunk,
  type Document,
  type DocumentStatus,
  type IngestionRun,
  type IngestionTrigger,
  type SearchSource,
} from '@sorrel/shared';
import { toVectorBlob, type Db } from './client.ts';

/**
 * Persistence for documents, chunks and ingestion runs.
 *
 * Rows come back from SQLite as snake_case with 0/1 for booleans; the contracts
 * in @sorrel/shared are camelCase with real booleans. Every read goes through a
 * mapper and then the Zod schema, so a column renamed in a migration fails here
 * with a clear message instead of surfacing as an undefined field in the UI.
 */

type Row = Record<string, unknown>;

const toDocument = (row: Row): Document =>
  documentSchema.parse({
    id: Number(row.id),
    sourcePath: row.source_path,
    title: row.title,
    category: row.category,
    contentHash: row.content_hash,
    byteSize: Number(row.byte_size),
    status: row.status,
    isDeprecated: Boolean(row.is_deprecated),
    supersededBy: row.superseded_by ?? null,
    error: row.error ?? null,
    chunkCount: Number(row.chunk_count),
    indexedAt: row.indexed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toIngestionRun = (row: Row): IngestionRun => {
  const startedAt = String(row.started_at);
  const finishedAt = row.finished_at ? String(row.finished_at) : null;

  return ingestionRunSchema.parse({
    id: Number(row.id),
    trigger: row.trigger,
    status: row.status,
    docsTotal: Number(row.docs_total),
    docsIndexed: Number(row.docs_indexed),
    docsUpdated: Number(row.docs_updated),
    docsSkipped: Number(row.docs_skipped),
    docsDeleted: Number(row.docs_deleted),
    docsFailed: Number(row.docs_failed),
    error: row.error ?? null,
    startedAt,
    finishedAt,
    // Measured by the pipeline. Rows written before migration 004 have no measured
    // value and fall back to the second-resolution subtraction they were recorded
    // with — coarse, but better than dropping the history.
    durationMs:
      row.duration_ms !== null && row.duration_ms !== undefined
        ? Number(row.duration_ms)
        : finishedAt
          ? Date.parse(finishedAt) - Date.parse(startedAt)
          : null,
  });
};

// --- documents --------------------------------------------------------------

/** Every document keyed by source path — the identity ingestion diffs against. */
export function getDocumentsBySourcePath(db: Db): Map<string, Document> {
  const rows = db.prepare('SELECT * FROM documents').all() as Row[];
  return new Map(rows.map((row) => [String(row.source_path), toDocument(row)]));
}

export function listDocuments(db: Db): Document[] {
  return (db.prepare('SELECT * FROM documents ORDER BY source_path').all() as Row[]).map(
    toDocument,
  );
}

export interface DocumentUpsert {
  sourcePath: string;
  title: string;
  category: string;
  contentHash: string;
  byteSize: number;
  isDeprecated: boolean;
  supersededBy: string | null;
}

/**
 * Insert or update by source path, returning the row id.
 *
 * `updated_at` is only touched when something actually changed, so the dashboard
 * can show when a document last genuinely moved rather than when ingest last ran.
 */
export function upsertDocument(db: Db, doc: DocumentUpsert): number {
  const row = db
    .prepare(
      `INSERT INTO documents
         (source_path, title, category, content_hash, byte_size, is_deprecated, superseded_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT (source_path) DO UPDATE SET
         title         = excluded.title,
         category      = excluded.category,
         content_hash  = excluded.content_hash,
         byte_size     = excluded.byte_size,
         is_deprecated = excluded.is_deprecated,
         superseded_by = excluded.superseded_by,
         status        = 'pending',
         error         = NULL,
         updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       RETURNING id`,
    )
    .get(
      doc.sourcePath,
      doc.title,
      doc.category,
      doc.contentHash,
      doc.byteSize,
      doc.isDeprecated ? 1 : 0,
      doc.supersededBy,
    ) as Row;

  return Number(row.id);
}

export function markDocumentIndexed(db: Db, documentId: number, chunkCount: number): void {
  db.prepare(
    `UPDATE documents
        SET status = 'indexed', chunk_count = ?, error = NULL,
            indexed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
  ).run(chunkCount, documentId);
}

/**
 * Record a failure without deleting what is already indexed.
 *
 * A document that fails to re-index keeps its previous chunks: stale results beat
 * a silent hole in the corpus, and the dashboard surfaces the failure so the
 * staleness is visible rather than assumed.
 */
export function markDocumentFailed(db: Db, documentId: number, error: string): void {
  db.prepare(`UPDATE documents SET status = 'failed', error = ? WHERE id = ?`).run(
    error.slice(0, 1000),
    documentId,
  );
}

/** Delete documents by source path. Chunks, vectors and FTS rows follow. */
export function deleteDocuments(db: Db, sourcePaths: string[]): number {
  if (sourcePaths.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM documents WHERE source_path = ?');
  let deleted = 0;
  for (const sourcePath of sourcePaths) deleted += stmt.run(sourcePath).changes as number;
  return deleted;
}

// --- chunks -----------------------------------------------------------------

export interface ChunkInsert {
  heading: string | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

/**
 * Replace a document's passages wholesale.
 *
 * Deleting and reinserting rather than diffing individual chunks: a document that
 * changed at all may have had a section added in the middle, which shifts every
 * subsequent ordinal. At this corpus size the rewrite costs nothing, and it makes
 * the invariant trivial to state — a document's chunks always reflect exactly one
 * version of the file.
 *
 * Must run inside a transaction. The chunks and their vectors have to land
 * together or retrieval starts returning passages whose embeddings are missing.
 */
export function replaceChunks(db: Db, documentId: number, chunks: ChunkInsert[]): void {
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

  const insertChunk = db.prepare(
    `INSERT INTO chunks (document_id, ordinal, heading, content, token_count)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  );
  const insertVector = db.prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)');

  chunks.forEach((chunk, ordinal) => {
    const row = insertChunk.get(
      documentId,
      ordinal,
      chunk.heading,
      chunk.content,
      chunk.tokenCount,
    ) as Row;
    // BigInt: node:sqlite binds plain numbers as doubles, which vec0 rejects as a
    // rowid.
    insertVector.run(BigInt(Number(row.id)), toVectorBlob(chunk.embedding));
  });
}

// --- ingestion runs ---------------------------------------------------------

export function startIngestionRun(db: Db, trigger: IngestionTrigger): number {
  const row = db
    .prepare(`INSERT INTO ingestion_runs (trigger, status) VALUES (?, 'running') RETURNING id`)
    .get(trigger) as Row;
  return Number(row.id);
}

export interface RunCounts {
  docsTotal: number;
  docsIndexed: number;
  docsUpdated: number;
  docsSkipped: number;
  docsDeleted: number;
  docsFailed: number;
}

/**
 * Close out a run.
 *
 * `durationMs` is measured by the caller rather than derived from the two stored
 * timestamps, which have second resolution — see migration 004.
 */
export function finishIngestionRun(
  db: Db,
  runId: number,
  counts: RunCounts,
  durationMs: number,
  error?: string | null,
): void {
  db.prepare(
    `UPDATE ingestion_runs
        SET status = ?, docs_total = ?, docs_indexed = ?, docs_updated = ?,
            docs_skipped = ?, docs_deleted = ?, docs_failed = ?, error = ?,
            duration_ms = ?,
            finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
  ).run(
    error ? 'failed' : 'succeeded',
    counts.docsTotal,
    counts.docsIndexed,
    counts.docsUpdated,
    counts.docsSkipped,
    counts.docsDeleted,
    counts.docsFailed,
    error ?? null,
    Math.max(0, Math.round(durationMs)),
    runId,
  );
}

export function getIngestionRun(db: Db, runId: number): IngestionRun | null {
  const row = db.prepare('SELECT * FROM ingestion_runs WHERE id = ?').get(runId) as Row | undefined;
  return row ? toIngestionRun(row) : null;
}

export function listIngestionRuns(db: Db, limit = 20): IngestionRun[] {
  return (
    db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT ?').all(limit) as Row[]
  ).map(toIngestionRun);
}

// --- search analytics -------------------------------------------------------

export interface SearchQueryRecord {
  userId: string | null;
  source: SearchSource;
  query: string;
  resultCount: number;
  topScore: number | null;
  abstained: boolean;
  latencyMs: number;
}

/**
 * Record a query for the dashboard.
 *
 * Never throws. Analytics are a reporting concern, and a failure to write one row
 * must not turn a successful search into an error for the user — losing a metric
 * is strictly better than losing the answer.
 */
export function recordSearchQuery(db: Db, record: SearchQueryRecord): void {
  try {
    db.prepare(
      `INSERT INTO search_queries
         (user_id, source, query, result_count, top_score, abstained, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.userId,
      record.source,
      record.query.slice(0, 500),
      record.resultCount,
      record.topScore,
      record.abstained ? 1 : 0,
      record.latencyMs,
    );
  } catch {
    // Deliberately swallowed. See above.
  }
}

// --- document listing -------------------------------------------------------

export interface DocumentFilter {
  status?: DocumentStatus;
  category?: string;
  /** Substring match against title and source path. */
  q?: string;
  limit: number;
  offset: number;
}

export function listDocumentsFiltered(
  db: Db,
  filter: DocumentFilter,
): { items: Document[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.category) {
    where.push('category = ?');
    params.push(filter.category);
  }
  if (filter.q) {
    // Parameterised LIKE. The wildcards are ours; the user's text is bound, so it
    // cannot alter the statement.
    where.push('(lower(title) LIKE ? OR lower(source_path) LIKE ?)');
    const needle = `%${filter.q.toLowerCase()}%`;
    params.push(needle, needle);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(
    (
      db.prepare(`SELECT count(*) n FROM documents ${clause}`).get(...(params as never[])) as {
        n: number;
      }
    ).n,
  );

  const rows = db
    .prepare(`SELECT * FROM documents ${clause} ORDER BY source_path LIMIT ? OFFSET ?`)
    .all(...(params as never[]), filter.limit, filter.offset) as Row[];

  return { items: rows.map(toDocument), total };
}

export function getDocumentById(db: Db, id: number): Document | null {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Row | undefined;
  return row ? toDocument(row) : null;
}

/** A document's passages, in order. Used by the dashboard's document detail view. */
export function getChunksForDocument(db: Db, documentId: number): Chunk[] {
  return (
    db
      .prepare(
        `SELECT id, document_id, ordinal, heading, content, token_count
           FROM chunks WHERE document_id = ? ORDER BY ordinal`,
      )
      .all(documentId) as Row[]
  ).map((row) =>
    chunkSchema.parse({
      id: Number(row.id),
      documentId: Number(row.document_id),
      ordinal: Number(row.ordinal),
      heading: row.heading ?? null,
      content: row.content,
      tokenCount: Number(row.token_count),
    }),
  );
}
