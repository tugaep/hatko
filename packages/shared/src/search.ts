import { z } from 'zod';
import { apiErrorSchema, documentCategorySchema } from './common.ts';

export const searchRequestSchema = z.object({
  query: z.string().trim().min(2).max(500),
  /** Passages returned after reranking. */
  limit: z.coerce.number().int().min(1).max(20).default(8),
  category: documentCategorySchema.optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/**
 * A retrieved passage with its provenance and the scores that produced it.
 *
 * The individual retrieval scores are deliberately part of the public contract.
 * The product promise is "show your work" — a result the user cannot interrogate
 * is a result they have to take on faith, which is the failure mode this whole
 * system exists to avoid.
 */
export const searchResultSchema = z.object({
  chunkId: z.number().int(),
  documentId: z.number().int(),
  documentTitle: z.string(),
  sourcePath: z.string(),
  category: documentCategorySchema,
  heading: z.string().nullable(),
  content: z.string(),
  ordinal: z.number().int().min(0),

  /** Fused rank score across vector + keyword retrieval. Primary ordering. */
  score: z.number(),
  /** Cosine similarity, 0..1. Null if the passage was found by keyword search only. */
  vectorScore: z.number().nullable(),
  /** Normalised BM25. Null if the passage was found by vector search only. */
  keywordScore: z.number().nullable(),
  /** Relevance judged by the rerank pass, 0..1. Null when reranking is disabled. */
  rerankScore: z.number().nullable(),

  isDeprecated: z.boolean(),
  supersededBy: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
  latencyMs: z.number().int().min(0),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** A numbered reference from the answer text back to the passage that supports it. */
export const citationSchema = z.object({
  /** 1-based marker as it appears in the answer, e.g. `[1]`. */
  index: z.number().int().min(1),
  chunkId: z.number().int(),
  documentId: z.number().int(),
  documentTitle: z.string(),
  sourcePath: z.string(),
  isDeprecated: z.boolean(),
});
export type Citation = z.infer<typeof citationSchema>;

export const answerRequestSchema = z.object({
  query: z.string().trim().min(2).max(500),
});
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

/**
 * A superseded document among the passages behind an answer.
 *
 * Derived from ingest-time metadata rather than from the answer text. Asking the
 * model to volunteer "v2 is deprecated" proved unreliable — it kept answering the
 * question correctly from the current document while silently omitting that the
 * old one is retired — and the deprecation is a fact the system already knows for
 * certain, so it does not need to be inferred from prose.
 */
export const deprecationNoticeSchema = z.object({
  documentTitle: z.string(),
  sourcePath: z.string(),
  supersededBy: z.string().nullable(),
});
export type DeprecationNotice = z.infer<typeof deprecationNoticeSchema>;

export const answerResponseSchema = z.object({
  query: z.string(),
  /** Empty string when `abstained` is true. */
  answer: z.string(),
  /** Superseded documents among the sources. Rendered as a banner beside the answer. */
  deprecationNotices: z.array(deprecationNoticeSchema),
  /**
   * True when the corpus does not support an answer. This is a correct outcome,
   * not an error: the response is still 200 and `sources` still carries the
   * nearest passages so the user can judge the miss themselves.
   */
  abstained: z.boolean(),
  citations: z.array(citationSchema),
  sources: z.array(searchResultSchema),
  latencyMs: z.number().int().min(0),
});
export type AnswerResponse = z.infer<typeof answerResponseSchema>;

/**
 * One event on the streamed form of an answer.
 *
 * The sequence is `passages` once, then `delta` any number of times, then exactly one
 * terminal event — `answer` or `error`. A client that renders nothing until the terminal
 * event arrives is still correct; the two earlier kinds exist only to fill the wait.
 *
 * **The `answer` event is the authoritative one, and the deltas are not.** Delta text has
 * not been through citation validation, so it may contain a marker pointing at a passage
 * that does not exist, and the answer may yet be withheld entirely — an answer that cites
 * nothing becomes an abstention, which means the terminal event can carry
 * `abstained: true` after a hundred deltas of confident prose. Whatever a client shows
 * from deltas must be labelled as in progress and replaced wholesale on arrival.
 *
 * `error` carries the same envelope as a non-2xx body, because by the time a failure is
 * known the 200 and its headers are long gone: a stream that dies has no status line left
 * to fail with, and a client that only handled HTTP status would see a truncated answer as
 * a complete one.
 */
export const answerStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('passages'), sources: z.array(searchResultSchema) }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('answer'), response: answerResponseSchema }),
  z.object({ type: z.literal('error'), error: apiErrorSchema.shape.error }),
]);
export type AnswerStreamEvent = z.infer<typeof answerStreamEventSchema>;
