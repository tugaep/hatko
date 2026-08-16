import { z } from 'zod';
import { documentCategorySchema, timestampSchema } from './common.ts';
import { ingestionRunSchema } from './corpus.ts';

/** Index health: what is in the store and whether the last ingest was clean. */
export const indexHealthSchema = z.object({
  documentsTotal: z.number().int().min(0),
  documentsIndexed: z.number().int().min(0),
  documentsPending: z.number().int().min(0),
  documentsFailed: z.number().int().min(0),
  documentsDeprecated: z.number().int().min(0),
  chunksTotal: z.number().int().min(0),
  /** Vector rows present. Diverging from chunksTotal means the index is torn. */
  embeddingsTotal: z.number().int().min(0),
  avgChunksPerDocument: z.number().min(0),
  databaseBytes: z.number().int().min(0),
  lastRun: ingestionRunSchema.nullable(),
});
export type IndexHealth = z.infer<typeof indexHealthSchema>;

export const categoryBreakdownSchema = z.object({
  category: documentCategorySchema,
  documents: z.number().int().min(0),
  chunks: z.number().int().min(0),
});
export type CategoryBreakdown = z.infer<typeof categoryBreakdownSchema>;

export const searchStatsSchema = z.object({
  queriesTotal: z.number().int().min(0),
  queriesLast7Days: z.number().int().min(0),
  /** Share of queries that returned an honest "not covered". A useful corpus-gap signal. */
  abstainRate: z.number().min(0).max(1),
  avgLatencyMs: z.number().min(0),
  p95LatencyMs: z.number().min(0),
  topQueries: z.array(
    z.object({
      query: z.string(),
      count: z.number().int().min(1),
      abstainedCount: z.number().int().min(0),
    }),
  ),
  /** Queries that found nothing — the shortlist of documents worth writing. */
  recentAbstains: z.array(z.object({ query: z.string(), createdAt: timestampSchema })),
  volumeByDay: z.array(z.object({ day: z.string(), count: z.number().int().min(0) })),
});
export type SearchStats = z.infer<typeof searchStatsSchema>;

export const dashboardStatsSchema = z.object({
  index: indexHealthSchema,
  byCategory: z.array(categoryBreakdownSchema),
  search: searchStatsSchema,
});
export type DashboardStats = z.infer<typeof dashboardStatsSchema>;
