import { z } from 'zod';
import {
  documentCategorySchema,
  documentStatusSchema,
  ingestionStatusSchema,
  ingestionTriggerSchema,
  paginationSchema,
  timestampSchema,
} from './common.ts';

/** A source file in the corpus. One row per file on disk. */
export const documentSchema = z.object({
  id: z.number().int(),
  /** Path relative to CORPUS_PATH, e.g. `guides/sdk-notes-v3.md`. Stable identity across re-ingests. */
  sourcePath: z.string(),
  title: z.string(),
  category: documentCategorySchema,
  /**
   * sha256 of the file contents. Ingestion compares this against the stored value
   * to skip unchanged files, which is what makes re-running ingest cheap and idempotent.
   */
  contentHash: z.string(),
  byteSize: z.number().int().min(0),
  status: documentStatusSchema,
  /**
   * Set when the document announces its own obsolescence (the `sdk-notes-v2` case).
   * Retrieval still returns deprecated documents — suppressing them would hide
   * legitimately relevant history — but the answer prompt and the UI must flag them.
   */
  isDeprecated: z.boolean(),
  supersededBy: z.string().nullable(),
  /** Populated when status is `failed`. */
  error: z.string().nullable(),
  chunkCount: z.number().int().min(0),
  indexedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Document = z.infer<typeof documentSchema>;

/** A retrievable passage. Chunks are cut on markdown headings — see packages/core/src/ingest. */
export const chunkSchema = z.object({
  id: z.number().int(),
  documentId: z.number().int(),
  /** Position within the parent document, 0-based. Used to show neighbouring context. */
  ordinal: z.number().int().min(0),
  /** The markdown heading this passage sits under, if any. */
  heading: z.string().nullable(),
  content: z.string(),
  tokenCount: z.number().int().min(0),
});
export type Chunk = z.infer<typeof chunkSchema>;

/**
 * One document with every passage that was indexed from it.
 *
 * The shape `GET /api/admin/documents/:id` has always returned, declared here because it
 * now has a second reader: clicking a point in the embedding plot opens the document that
 * passage came from. It was the one admin route answering with an unvalidated object
 * literal — fine while a single component consumed it by inspection, not fine as a
 * contract two surfaces parse.
 */
export const documentDetailSchema = z.object({
  document: documentSchema,
  chunks: z.array(chunkSchema),
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

/**
 * One execution of the ingestion pipeline. The brief requires ingestion to be
 * "repeatable and observable"; this table is the observable part, and the
 * per-outcome counts are what the dashboard renders.
 */
export const ingestionRunSchema = z.object({
  id: z.number().int(),
  trigger: ingestionTriggerSchema,
  status: ingestionStatusSchema,
  docsTotal: z.number().int().min(0),
  docsIndexed: z.number().int().min(0),
  docsUpdated: z.number().int().min(0),
  docsSkipped: z.number().int().min(0),
  docsDeleted: z.number().int().min(0),
  docsFailed: z.number().int().min(0),
  error: z.string().nullable(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  durationMs: z.number().int().min(0).nullable(),
});
export type IngestionRun = z.infer<typeof ingestionRunSchema>;

/**
 * Sortable columns, as an enum rather than a free string.
 *
 * This is the security-relevant line in this file. `ORDER BY` cannot be parameterised in
 * SQL — the column has to be interpolated into the statement — so the only safe design is
 * one where the client never supplies a column name at all. It supplies a key from this
 * closed set, and the repository maps the key to a column through a lookup it owns. An
 * unrecognised key fails validation at the boundary and never reaches the query.
 *
 * `sourcePath` is the default because it is a document's stable identity across
 * re-ingests, and sorting by it groups the corpus by directory, which is how someone
 * looking at a directory tree expects to find one.
 */
export const documentSortSchema = z.enum([
  'sourcePath',
  'title',
  'category',
  'status',
  'chunkCount',
  'byteSize',
  'indexedAt',
]);
export type DocumentSort = z.infer<typeof documentSortSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const listDocumentsQuerySchema = paginationSchema.extend({
  status: documentStatusSchema.optional(),
  category: documentCategorySchema.optional(),
  /** Substring match against title and source path. */
  q: z.string().trim().max(200).optional(),
  // The defaults live here rather than on the enums, so `documentSortSchema.options` stays
  // enumerable — the UI builds its sortable columns from it, and a test walks every key.
  sort: documentSortSchema.default('sourcePath'),
  direction: sortDirectionSchema.default('asc'),
});

export const triggerIngestionRequestSchema = z.object({
  /** Re-embed every document even if its content hash is unchanged. */
  force: z.boolean().default(false),
});
