import { Hono } from 'hono';
import {
  answerQuestion,
  getDb,
  hasGroundedSupport,
  hybridSearch,
  recordSearchQuery,
  rerank,
} from '@hatko/core';
import {
  answerRequestSchema,
  answerResponseSchema,
  searchRequestSchema,
  searchResponseSchema,
} from '@hatko/shared';
import { requires, throttle } from '../middleware.ts';
import { jsonBody } from '../errors.ts';

/**
 * Search and grounded answers. Both require a signed-in user of any role.
 *
 * Requests are validated against the shared Zod schemas rather than read
 * field-by-field, so the API and the browser cannot disagree about the contract,
 * and an oversized or malformed query is rejected at the boundary with field-level
 * detail instead of reaching the retriever.
 *
 * Responses are parsed against the same schemas on the way out, which they were
 * not before: `c.json()` accepts any object, so renaming `results` to `resultz`
 * type-checked clean and would have reached the browser. Rows were already
 * validated coming out of the database, leaving the contract enforced in the one
 * direction the client does not depend on. Parsing also strips any field not in
 * the schema, so a response cannot quietly grow one.
 *
 * Both routes are throttled after the role check. These are the two endpoints in the
 * system that spend money — a search costs an embedding and a rerank call, an answer
 * costs those plus a generation — and until now nothing bounded how fast one account
 * could spend it.
 */

export const searchRoutes = new Hono();

searchRoutes.post('/search', requires('search:run'), throttle(), async (c) => {
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

  return c.json(searchResponseSchema.parse({ query: body.query, results, latencyMs }));
});

searchRoutes.post('/answer', requires('answer:generate'), throttle(), async (c) => {
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
  return c.json(answerResponseSchema.parse(response));
});
