import { z } from 'zod';

/**
 * Primitives shared across every contract in this package.
 *
 * Everything here is defined as a Zod schema first and the TypeScript type is
 * inferred from it. That gives one definition per concept: the API validates
 * requests with it, the client types responses with it, and the SQLite
 * repository layer parses rows with it. A field cannot drift between the
 * database, the server and the browser without the type check failing.
 */

/**
 * A document's category is its top-level directory within the corpus, discovered
 * at ingest time — deliberately an open string rather than an enum.
 *
 * The sample corpus happens to use guides/changelogs/client-briefs/delivery-reports/
 * meeting-notes/postmortems, but the brief requires that pointing ingestion at the
 * real corpus be straightforward. Enumerating the sample's folder names here would
 * make every document in a differently-organised corpus fail validation.
 *
 * Files at the corpus root fall back to CATEGORY_UNCATEGORISED.
 */
export const documentCategorySchema = z.string().min(1).max(64);
export type DocumentCategory = z.infer<typeof documentCategorySchema>;

export const CATEGORY_UNCATEGORISED = 'uncategorised';

export const documentStatusSchema = z.enum(['pending', 'indexed', 'failed']);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const ingestionStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export type IngestionStatus = z.infer<typeof ingestionStatusSchema>;

export const ingestionTriggerSchema = z.enum(['cli', 'api', 'startup']);
export type IngestionTrigger = z.infer<typeof ingestionTriggerSchema>;

/** Where a search came from. Separates MCP tool traffic from web traffic in analytics. */
export const searchSourceSchema = z.enum(['web', 'mcp']);
export type SearchSource = z.infer<typeof searchSourceSchema>;

/** SQLite stores timestamps as `datetime('now')` strings; the API re-serialises to ISO 8601. */
export const timestampSchema = z.string().describe('ISO 8601 timestamp');

/**
 * Every non-2xx API response uses this envelope, so the client has exactly one
 * error shape to handle rather than guessing per endpoint.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'rate_limited',
      'upstream_failed',
      'internal',
    ]),
    message: z.string(),
    /** Field-level detail for validation failures. */
    details: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Pagination = z.infer<typeof paginationSchema>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int(),
    offset: z.number().int(),
  });
}
