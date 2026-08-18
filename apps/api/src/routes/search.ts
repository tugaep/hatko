import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  answerQuestion,
  getDb,
  hasGroundedSupport,
  recordSearchQuery,
  retrieveAndRerank,
} from '@hatko/core';
import {
  answerRequestSchema,
  answerResponseSchema,
  searchRequestSchema,
  searchResponseSchema,
  type AnswerResponse,
  type AnswerStreamEvent,
  type ApiError,
} from '@hatko/shared';
import { requires, throttle } from '../middleware.ts';
import { jsonBody, toErrorResponse } from '../errors.ts';

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

  // Graded before it is truncated: `limit` decides how many passages come back, never how
  // many the reranker was allowed to read. See retrieveAndRerank.
  const results = await retrieveAndRerank(db, body.query, {
    limit: body.limit,
    ...(body.category ? { category: body.category } : {}),
  });
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

/**
 * One question, in two representations.
 *
 * `Accept: text/event-stream` gets the answer as it is written; anything else gets the
 * same answer in one JSON body. Content negotiation rather than a second route or a
 * `stream: true` flag, because that is what the header is for and because it keeps a
 * single documented endpoint — `curl` and the eval keep working untouched, and the
 * browser opts in by asking for a different representation of the same resource.
 *
 * Both paths run the *same* `answerQuestion` call and record the same analytics. Nothing
 * about what may be claimed depends on which one the caller chose: citation validation
 * and the abstain decision run against the complete text either way, so the streaming
 * path can only change when a reader sees an answer, never what it is allowed to say.
 */
searchRoutes.post('/answer', requires('answer:generate'), throttle(), async (c) => {
  const body = answerRequestSchema.parse(await jsonBody(c));
  const db = getDb();
  const userId = c.get('user').id;

  const record = (response: AnswerResponse) =>
    recordSearchQuery(db, {
      userId,
      source: 'web',
      query: body.query,
      resultCount: response.sources.length,
      topScore: response.sources[0]?.score ?? null,
      abstained: response.abstained,
      latencyMs: response.latencyMs,
    });

  if (!c.req.header('accept')?.includes('text/event-stream')) {
    const response = await answerQuestion(db, body.query);
    record(response);
    // An abstention is a correct outcome, not an error, so it is a 200 carrying
    // `abstained: true`. Returning 4xx would make the client treat honest
    // uncertainty as a failure and probably retry it.
    return c.json(answerResponseSchema.parse(response));
  }

  return streamSSE(c, async (stream) => {
    /**
     * Writes are chained rather than fired concurrently.
     *
     * `onPassages` and `onDelta` are synchronous callbacks but writing a frame is not, so
     * without this a delta arriving mid-write would be free to interleave its bytes with
     * the frame in flight — and half an SSE event is not something a reader can recover
     * from. Chaining also means awaiting the terminal event awaits every event before it.
     * Hono's writer swallows write failures, so a disconnected client breaks the loop via
     * the abort signal below rather than by rejecting this chain.
     */
    let queued: Promise<unknown> = Promise.resolve();
    const send = (event: AnswerStreamEvent): Promise<unknown> =>
      (queued = queued.then(() => stream.writeSSE({ data: JSON.stringify(event) })));

    try {
      const response = await answerQuestion(db, body.query, {
        // A closed tab should stop costing money. This is the one place in the system
        // where a client hanging up can cancel work already paid for in flight.
        signal: c.req.raw.signal,
        onPassages: (sources) => void send({ type: 'passages', sources }),
        onDelta: (text) => void send({ type: 'delta', text }),
      });

      record(response);
      await send({ type: 'answer', response: answerResponseSchema.parse(response) });
    } catch (error) {
      /**
       * Classified by the same function every other route uses, and deliberately so.
       *
       * The rule that matters here is that an unrecognised error becomes a generic 500
       * with its detail logged and withheld — and a second, hand-rolled translation in
       * the streaming path is exactly how the streaming path becomes the one that leaks a
       * stack trace. The status it computes is discarded: the 200 was sent before the
       * first passage, so the envelope travels as an event instead.
       */
      const { error: envelope } = (await toErrorResponse(error, c).json()) as ApiError;
      await send({ type: 'error', error: envelope });
    }
  });
});
