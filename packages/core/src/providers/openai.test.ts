import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Retrying a stalled response body.
 *
 * `post` retries around `fetch`, which settles when the response *headers* arrive.
 * Reading the body is a separate transfer and it is the half that hangs on a lossy
 * path: a 200 whose body stalls past the timeout used to abort a whole ingestion,
 * because the retry loop had already exited successfully. What matters here is that
 * a body failure is retried at all, and that a caller's own abort still is not.
 *
 * config.ts snapshots process.env when it is imported and static imports hoist above
 * every statement, so the environment has to be complete before the module graph
 * loads — hence the dynamic imports.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-provider-'));
process.env.BETTER_AUTH_SECRET ??= 'test-only-secret-not-used-outside-node-test-runs';
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.OPENAI_API_KEY = 'test-key-never-sent-anywhere';

const { getDb } = await import('../db/client.ts');
const { runMigrations } = await import('../db/migrate.ts');
runMigrations(getDb());
const { config } = await import('../config.ts');
const { embed } = await import('./openai.ts');

const width = config.embeddingDimensions;

/** A 200 whose body read behaves however the test needs. */
function response(json: () => Promise<unknown>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json,
    text: async () => '',
  } as unknown as Response;
}

function payload(count: number) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: width }, () => 0.1),
    })),
  };
}

function stallOnce() {
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    return calls === 1
      ? response(async () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        })
      : response(async () => payload(1));
  };
  return { fetchMock, calls: () => calls };
}

test('a response whose body stalls is retried rather than failing the caller', async () => {
  const original = globalThis.fetch;
  const { fetchMock, calls } = stallOnce();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const vectors = await embed(['one passage']);
    assert.equal(vectors.length, 1, 'the retry should produce the embedding');
    assert.equal(vectors[0]?.length, width);
    assert.equal(calls(), 2, 'the request should have been sent twice');
  } finally {
    globalThis.fetch = original;
  }
});

test("the caller's own abort is not retried", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    controller.abort();
    return response(async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(() => embed(['one passage'], controller.signal));
    assert.equal(calls, 1, 'a cancelled request must not burn the remaining attempts');
  } finally {
    globalThis.fetch = original;
  }
});
