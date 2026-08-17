import { Hono } from 'hono';
import {
  answerQuestion,
  getDb,
  hasGroundedSupport,
  hybridSearch,
  recordSearchQuery,
  rerank,
} from '@sorrel/core';
import { answerRequestSchema, searchRequestSchema } from '@sorrel/shared';
import { requires } from '../middleware.ts';
import { jsonBody } from '../errors.ts';

/**
 * Search and grounded answers. Both require a signed-in user of any role.
 *
 * Requests are validated against the shared Zod schemas rather than read
 * field-by-field, so the API and the browser cannot disagree about the contract,
 * and an oversized or malformed query is rejected at the boundary with field-level
 * detail instead of reaching the retriever.
 */

export const searchRoutes = new Hono();

searchRoutes.post('/search', requires('search:run'), async (c) => {
  const body = searchRequestSchema.parse(await jsonBody(c));
  const db = getDb();
  const started = performance.now();

  const retrieved = await hybridSearch(db, body.query, {
    limit: body.limit,
    ...(body.category ? { category: body.category } : {}),
  });
  const results = await rerank(body.query, retrieved);
  const latencyMs = Math.round(performance.now() - started);

  // Search analytics feed the dashboard. `abstained` here means the reranker found
  // nothing relevant enough to ground an answer on — the same judgement the answer
  // endpoint uses — so the abstain rate is comparable across both surfaces.
  recordSearchQuery(db, {
    userId: c.get('user').id,
    source: 'web',
    query: body.query,
    resultCount: results.length,
    topScore: results[0]?.score ?? null,
    abstained: hasGroundedSupport(results) === false,
    latencyMs,
  });

  return c.json({ query: body.query, results, latencyMs });
});

searchRoutes.post('/answer', requires('answer:generate'), async (c) => {
  const body = answerRequestSchema.parse(await jsonBody(c));
  const db = getDb();

  const response = await answerQuestion(db, body.query);

  recordSearchQuery(db, {
    userId: c.get('user').id,
    source: 'web',
    query: body.query,
    resultCount: response.sources.length,
    topScore: response.sources[0]?.score ?? null,
    abstained: response.abstained,
    latencyMs: response.latencyMs,
  });

  // An abstention is a correct outcome, not an error, so it is a 200 carrying
  // `abstained: true`. Returning 4xx would make the client treat honest
  // uncertainty as a failure and probably retry it.
  return c.json(response);
});
