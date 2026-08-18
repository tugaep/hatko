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

/**
 * One chunk, placed in the projected space.
 *
 * Coordinates are already scaled into roughly [-1, 1] by one shared factor, so the
 * client draws them and does not decide what they mean. Axis-independent scaling would
 * be a client-side decision that changes the picture — stretching a third component
 * carrying a few percent of the variance to full width invents a cloud out of a plane.
 */
export const embeddingPointSchema = z.object({
  chunkId: z.number().int().positive(),
  documentId: z.number().int().positive(),
  title: z.string(),
  heading: z.string().nullable(),
  category: documentCategorySchema,
  isDeprecated: z.boolean(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type EmbeddingPoint = z.infer<typeof embeddingPointSchema>;

/**
 * The corpus as its vectors see it.
 *
 * `explained` is not decoration: three axes taken from a 1536-dimension space always
 * produce a picture, and the share of variance they carry is the only thing that says
 * whether the picture describes the space or is an artefact of looking at it side-on.
 * Shown next to the plot for that reason.
 */
export const embeddingMapSchema = z.object({
  points: z.array(embeddingPointSchema),
  /** Share of total variance on each of the three axes, largest first. */
  explained: z.tuple([z.number(), z.number(), z.number()]),
  /** Width of the vectors that were projected. Names what was reduced, and from what. */
  dimensions: z.number().int().min(0),
});
export type EmbeddingMap = z.infer<typeof embeddingMapSchema>;

/**
 * The public liveness response.
 *
 * Public on purpose, and therefore deliberately thin: a load balancer needs to know the
 * process is up, and `indexedChunks` is the one number that distinguishes "running" from
 * "running and actually able to answer anything". Nothing here is worth authenticating,
 * and nothing about the corpus's contents is disclosed by its size.
 *
 * Shared rather than inline in the route, because the chat page now reads it to decide
 * whether to tell someone the system is not set up yet — so two sides depend on the shape
 * and the repository's rule is that those live here.
 */
export const healthSchema = z.object({
  status: z.literal('ok'),
  indexedChunks: z.number().int().min(0),
});
export type Health = z.infer<typeof healthSchema>;
