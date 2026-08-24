import type { IngestionRun, IngestionTrigger } from '@hatko/shared';
import { config } from '../config.ts';
import { transaction, type Db } from '../db/client.ts';
import {
  deleteDocuments,
  finishIngestionRun,
  getDocumentsBySourcePath,
  getIngestionRun,
  markDocumentFailed,
  markDocumentIndexed,
  replaceChunks,
  startIngestionRun,
  upsertDocument,
  type ChunkInsert,
  type DocumentUpsert,
  type RunCounts,
} from '../db/repository.ts';
import { embed } from '../providers/openai.ts';
import { buildEmbeddingText, chunkMarkdown, estimateTokens, type RawChunk } from './chunk.ts';
import { categoryOf, scanCorpus, readDocument, titleOf, type SourceDocument } from './corpus.ts';

/**
 * The ingestion pipeline.
 *
 * Runs in four phases rather than processing each file end to end:
 *
 *   1. scan and diff   — decide what changed, using the stored content hash
 *   2. read and chunk  — per-file failures isolated here
 *   3. embed           — one batched pass across every changed document
 *   4. write           — one transaction per document
 *
 * Phase 3 is separated so embedding is batched across documents. Doing it inside
 * a per-file loop would mean one sequential API round trip per document in the
 * corpus; batching turns that into a handful.
 *
 * Repeatability comes from the content hash: a file whose bytes have not changed
 * is skipped without re-embedding, so re-running ingest is cheap and produces the
 * same index. Observability comes from the ingestion_runs row, which records what
 * was indexed, updated, skipped, deleted and failed, and whether the run succeeded.
 */

export interface IngestProgress {
  phase: 'scan' | 'read' | 'embed' | 'write' | 'prune';
  message: string;
  current?: number;
  total?: number;
}

/** Injectable so the pipeline can be exercised end to end without a network call. */
export type Embedder = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

export interface IngestOptions {
  trigger: IngestionTrigger;
  /** Re-embed everything, ignoring unchanged content hashes. */
  force?: boolean;
  /** Defaults to CORPUS_PATH. */
  corpusPath?: string;
  /** Defaults to the OpenAI embeddings client. */
  embedder?: Embedder;
  onProgress?: (progress: IngestProgress) => void;
  signal?: AbortSignal;
}

interface PlannedDocument {
  source: SourceDocument;
  chunks: RawChunk[];
  /** True when the document already existed and is being re-indexed. */
  isUpdate: boolean;
}

/** Raised when a second run is started while one is still going. */
export class IngestionInProgressError extends Error {
  constructor() {
    super('An ingestion run is already in progress. Wait for it to finish.');
    this.name = 'IngestionInProgressError';
  }
}

/**
 * Whether a run is currently between its scan and its final write.
 *
 * Two overlapping runs left the stores consistent — the write phases are
 * synchronous, so they cannot interleave mid-transaction — but both read the
 * pre-run snapshot before either wrote, so both saw every document as new and
 * five documents were reported as ten indexed. The run log is the whole of
 * "ingestion is observable", and it was the part that lied. It also means a
 * double-clicked dashboard button pays for every embedding twice.
 *
 * Module scope rather than per-database: this process holds one connection, and
 * that is the thing being contended for.
 */
let running = false;

export async function ingest(db: Db, options: IngestOptions): Promise<IngestionRun> {
  if (running) throw new IngestionInProgressError();
  running = true;
  try {
    return await runIngest(db, options);
  } finally {
    running = false;
  }
}

async function runIngest(db: Db, options: IngestOptions): Promise<IngestionRun> {
  const {
    trigger,
    force = false,
    corpusPath = config.corpusPath,
    embedder = embed,
    onProgress,
    signal,
  } = options;
  const report = (progress: IngestProgress) => onProgress?.(progress);

  /**
   * Record a document that could not be indexed, creating its row if none exists.
   *
   * Must run *outside* the write transaction. A failure in there is rolled back,
   * and an `upsertDocument` inside it is rolled back with the error it was meant to
   * record — which is how a run came to report two failures while only one
   * appeared in the document list, and index health counted one. `docs_failed` on
   * the run and the failed documents themselves have to agree, or "ingestion is
   * observable" is only true for the failures that happen to be re-runs.
   *
   * Never throws: bookkeeping must not abort a run over the 141 documents that
   * were fine. Same rule as `recordSearchQuery`.
   */
  const recordFailure = (doc: DocumentUpsert, message: string) => {
    try {
      markDocumentFailed(db, upsertDocument(db, doc), message);
    } catch {
      report({ phase: 'write', message: `could not record the failure of ${doc.sourcePath}` });
    }
  };

  /**
   * What we know about a file we could not even read: its path. Enough to make the
   * failure visible. The empty content hash matters — it can never equal a real
   * one, so the next run always retries rather than treating the stub as current.
   */
  const placeholderFor = (sourcePath: string): DocumentUpsert => ({
    sourcePath,
    title: titleOf(sourcePath, ''),
    category: categoryOf(sourcePath),
    contentHash: '',
    byteSize: 0,
    isDeprecated: false,
    supersededBy: null,
  });

  const runId = startIngestionRun(db, trigger);
  // Elapsed time is measured here rather than derived from started_at and
  // finished_at, which are stored with second resolution — see migration 004.
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;

  const counts: RunCounts = {
    docsTotal: 0,
    docsIndexed: 0,
    docsUpdated: 0,
    docsSkipped: 0,
    docsDeleted: 0,
    docsFailed: 0,
  };

  try {
    // --- 1. scan and diff ----------------------------------------------------
    const { files, ignored } = scanCorpus(corpusPath);
    const existing = getDocumentsBySourcePath(db);
    counts.docsTotal = files.length;
    report({ phase: 'scan', message: `${files.length} documents in corpus`, total: files.length });
    if (ignored.length > 0) {
      // Named rather than counted. A file silently missing from the index is the
      // problem this exclusion list exists to fix, so the exclusion itself must
      // not be silent.
      report({ phase: 'scan', message: `ignored ${ignored.length}: ${ignored.join(', ')}` });
    }

    // --- 2. read and chunk ---------------------------------------------------
    const planned: PlannedDocument[] = [];

    for (const [index, sourcePath] of files.entries()) {
      const previous = existing.get(sourcePath);
      try {
        const source = readDocument(corpusPath, sourcePath);

        // Unchanged content and a healthy previous index means nothing to do.
        // A previously failed document is retried even when its bytes match.
        if (
          !force &&
          previous?.contentHash === source.contentHash &&
          previous.status === 'indexed'
        ) {
          counts.docsSkipped++;
          continue;
        }

        const chunks = chunkMarkdown(source.body);
        if (chunks.length === 0) {
          // An empty file is not an error, but it has nothing to retrieve. Record
          // it so it appears in the dashboard rather than vanishing silently.
          counts.docsFailed++;
          recordFailure(source, 'Document is empty; nothing to index.');
          continue;
        }

        planned.push({ source, chunks, isUpdate: previous !== undefined });
        report({
          phase: 'read',
          message: sourcePath,
          current: index + 1,
          total: files.length,
        });
      } catch (error) {
        // One unreadable file must not abort the run.
        counts.docsFailed++;
        const message = error instanceof Error ? error.message : String(error);
        // A document already on record keeps its stored title, category and hash —
        // overwriting them with placeholders would discard what the last good
        // ingest learned. A file never seen before has nothing to keep, and needs a
        // row created or the failure is invisible.
        if (previous) markDocumentFailed(db, previous.id, message);
        else recordFailure(placeholderFor(sourcePath), message);
        report({ phase: 'read', message: `failed: ${sourcePath} — ${message}` });
      }
    }

    // --- 3. embed ------------------------------------------------------------
    const texts = planned.flatMap((doc) =>
      doc.chunks.map((chunk) => buildEmbeddingText(doc.source.title, chunk.heading, chunk.content)),
    );

    let embeddings: number[][] = [];
    if (texts.length > 0) {
      report({
        phase: 'embed',
        message: `embedding ${texts.length} passages`,
        total: texts.length,
      });
      embeddings = await embedder(texts, signal);
    }

    // --- 4. write ------------------------------------------------------------
    let cursor = 0;
    for (const [index, doc] of planned.entries()) {
      const slice = embeddings.slice(cursor, cursor + doc.chunks.length);
      cursor += doc.chunks.length;

      try {
        // Named rather than asserted with `slice[i]!`. An embedder returning fewer
        // vectors than texts recorded "Cannot read properties of undefined
        // (reading 'length')" against the document, which tells an operator
        // reading the dashboard nothing about what to do. The real client already
        // checks its own batch counts, so this guards the injected-embedder seam.
        if (slice.length !== doc.chunks.length) {
          throw new Error(
            `Embedder returned ${slice.length} vectors for ${doc.chunks.length} passages.`,
          );
        }

        const inserts: ChunkInsert[] = doc.chunks.map((chunk, i) => ({
          heading: chunk.heading,
          content: chunk.content,
          tokenCount: estimateTokens(chunk.content),
          embedding: slice[i]!,
        }));

        transaction(db, () => {
          const documentId = upsertDocument(db, doc.source);
          replaceChunks(db, documentId, inserts);
          markDocumentIndexed(db, documentId, inserts.length);
        });
        if (doc.isUpdate) counts.docsUpdated++;
        else counts.docsIndexed++;
        report({
          phase: 'write',
          message: doc.source.sourcePath,
          current: index + 1,
          total: planned.length,
        });
      } catch (error) {
        counts.docsFailed++;
        const message = error instanceof Error ? error.message : String(error);
        // The transaction above has rolled back, so this runs on a clean
        // connection and its row survives. Previously this looked up the pre-run
        // snapshot and did nothing when the document was new — the case where the
        // failure record is the only evidence the document exists at all.
        recordFailure(doc.source, message);
        report({ phase: 'write', message: `failed: ${doc.source.sourcePath} — ${message}` });
      }
    }

    // --- 5. prune ------------------------------------------------------------
    // Files that vanished from disk. Without this the index would keep serving
    // passages from documents that no longer exist, which is worse than missing
    // them: the answer would cite a source the reader cannot find.
    const onDisk = new Set(files);
    const removed = [...existing.keys()].filter((sourcePath) => !onDisk.has(sourcePath));
    counts.docsDeleted = deleteDocuments(db, removed);
    if (counts.docsDeleted > 0) {
      report({ phase: 'prune', message: `removed ${counts.docsDeleted} deleted documents` });
    }

    finishIngestionRun(db, runId, counts, elapsed());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishIngestionRun(db, runId, counts, elapsed(), message);
    throw error;
  }

  const run = getIngestionRun(db, runId);
  if (!run) throw new Error(`Ingestion run ${runId} disappeared after completing.`);
  return run;
}
