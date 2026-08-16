import type { IngestionRun, IngestionTrigger } from '@sorrel/shared';
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
  type RunCounts,
} from '../db/repository.ts';
import { embed } from '../providers/openai.ts';
import { buildEmbeddingText, chunkMarkdown, estimateTokens, type RawChunk } from './chunk.ts';
import { listCorpusFiles, readDocument, type SourceDocument } from './corpus.ts';

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
 * a per-file loop would mean 142 sequential API round trips for the sample
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

export async function ingest(db: Db, options: IngestOptions): Promise<IngestionRun> {
  const {
    trigger,
    force = false,
    corpusPath = config.corpusPath,
    embedder = embed,
    onProgress,
    signal,
  } = options;
  const report = (progress: IngestProgress) => onProgress?.(progress);

  const runId = startIngestionRun(db, trigger);
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
    const files = listCorpusFiles(corpusPath);
    const existing = getDocumentsBySourcePath(db);
    counts.docsTotal = files.length;
    report({ phase: 'scan', message: `${files.length} documents in corpus`, total: files.length });

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
          const documentId = upsertDocument(db, source);
          markDocumentFailed(db, documentId, 'Document is empty; nothing to index.');
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
        if (previous) markDocumentFailed(db, previous.id, message);
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

      const inserts: ChunkInsert[] = doc.chunks.map((chunk, i) => ({
        heading: chunk.heading,
        content: chunk.content,
        tokenCount: estimateTokens(chunk.content),
        embedding: slice[i]!,
      }));

      try {
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
        const documentId = existing.get(doc.source.sourcePath)?.id;
        if (documentId !== undefined) markDocumentFailed(db, documentId, message);
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

    finishIngestionRun(db, runId, counts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishIngestionRun(db, runId, counts, message);
    throw error;
  }

  const run = getIngestionRun(db, runId);
  if (!run) throw new Error(`Ingestion run ${runId} disappeared after completing.`);
  return run;
}
