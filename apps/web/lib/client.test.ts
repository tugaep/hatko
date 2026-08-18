import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ApiRequestError, isAuthError } from './api.ts';
import { apiStream } from './client.ts';

/**
 * The browser side of a streamed answer.
 *
 * Streaming moved the failure modes, which is the reason this is tested separately from
 * `parseResponse`. A refusal that arrives *before* the stream — 401 on an expired
 * session, 429 out of allowance — still has a status and must throw like any other call.
 * A failure *after* the first byte cannot: the 200 was committed, so it arrives as a
 * payload, and the only thing standing between a malformed payload and a component
 * rendering `undefined` as an answer is the per-event schema check here.
 *
 * `fetch` is stubbed rather than a server started: what is under test is how this
 * function reads a response, and a real server would test the API instead.
 */

const event = z.object({ type: z.literal('token'), text: z.string() });

/** A response whose body is a real ReadableStream, framed as Server-Sent Events. */
const sseResponse = (payloads: string[], status = 200) =>
  new Response(payloads.map((p) => `data: ${p}\n\n`).join(''), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });

const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
};

const collect = async <T>(stream: AsyncGenerator<T>): Promise<T[]> => {
  const seen: T[] = [];
  for await (const item of stream) seen.push(item);
  return seen;
};

const thrownBy = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => null,
    (error: unknown) => error,
  );

test('events arrive parsed, in order, and typed', async () => {
  await withFetch(
    async () => sseResponse(['{"type":"token","text":"Play"}', '{"type":"token","text":"ables"}']),
    async () => {
      const events = await collect(apiStream('/api/answer', event, { query: 'x' }));
      assert.deepEqual(
        events.map((e) => e.text),
        ['Play', 'ables'],
      );
    },
  );
});

test('a refusal before the stream throws with its status, not an empty answer', async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({ error: { code: 'rate_limited', message: 'Try again in 12 seconds.' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    async () => {
      const error = await thrownBy(() => collect(apiStream('/api/answer', event, {})));

      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'rate_limited');
      assert.match(error.message, /12 seconds/, 'the wait reaches the person who has to wait');
    },
  );
});

test('an expired session mid-request is recognisable as one', async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in again.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    async () => {
      const error = await thrownBy(() => collect(apiStream('/api/answer', event, {})));
      assert.equal(isAuthError(error), true);
    },
  );
});

/**
 * The one that fails silently. A payload the page cannot read must stop the stream,
 * because the alternative is a component rendering `undefined` into an answer the user
 * has no reason to distrust.
 */
test('an unreadable event stops the stream instead of yielding a hole', async () => {
  await withFetch(
    async () =>
      sseResponse([
        '{"type":"token","text":"Play"}',
        '{"type":"token"}',
        '{"type":"token","text":"!"}',
      ]),
    async () => {
      const seen: unknown[] = [];
      const error = await thrownBy(async () => {
        for await (const e of apiStream('/api/answer', event, {})) seen.push(e);
      });

      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'malformed');
      assert.equal(seen.length, 1, 'events before the bad one were delivered, none after it');
    },
  );
});

test('a payload that is not JSON is the same failure, not a parse crash', async () => {
  await withFetch(
    async () => sseResponse(['not json at all']),
    async () => {
      const error = await thrownBy(() => collect(apiStream('/api/answer', event, {})));
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'malformed');
    },
  );
});

test('an unreachable API names the address rather than saying "failed to fetch"', async () => {
  await withFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      const error = await thrownBy(() => collect(apiStream('/api/answer', event, {})));

      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'network');
      assert.match(error.message, /http:\/\/localhost:4000/, 'the address to check is in the text');
    },
  );
});

/**
 * An abort is the user navigating away or asking a new question. It is not a fault, and
 * turning it into one would put "Could not reach the API" on screen every time someone
 * changes their mind.
 */
test('an aborted stream propagates the abort rather than a network error', async () => {
  await withFetch(
    async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    },
    async () => {
      const error = await thrownBy(() =>
        collect(apiStream('/api/answer', event, {}, AbortSignal.abort())),
      );
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, 'AbortError');
    },
  );
});
