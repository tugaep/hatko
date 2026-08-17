import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { searchResponseSchema, sessionResponseSchema } from '@hatko/shared';

/**
 * The API surface, exercised through `app.request()`.
 *
 * Every request goes through the real routing and the real authorization
 * middleware — nothing is stubbed except the model provider. The point of this
 * file is the security axis: for each protected route, prove that an anonymous
 * caller gets 401, a regular user gets 403 where the route is admin-only, and an
 * admin gets through. A role check that exists but is not wired to a route is
 * worth nothing, and only a test that goes through the router can tell the
 * difference.
 */

process.env.BETTER_AUTH_SECRET ??= 'test-only-secret-not-used-outside-node-test-runs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-api-'));
process.env.DATABASE_PATH = path.join(dir, 'api.db');
// Keep the corpus small: these tests are about routing and authorization, and
// ingesting all 142 documents for each would only slow them down.
process.env.CORPUS_PATH = path.join(dir, 'corpus');
fs.mkdirSync(process.env.CORPUS_PATH, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CORPUS_PATH, 'build-pipeline.md'),
  '# Build Pipeline\n\nSound assets are built separately from the main bundle. Audio is encoded ' +
    'in a dedicated pass and injected at the inline stage.\n',
);
fs.writeFileSync(
  path.join(process.env.CORPUS_PATH, 'sdk-notes-v2.md'),
  '# Lumen SDK v2 (DEPRECATED)\n\nStatus: deprecated since January 2026. See "Lumen SDK v3" for ' +
    'current guidance.\n',
);

const { getDb, closeDb, ingest, config, getAuth, upsertAccount, resolveApiKey } =
  await import('@hatko/core');
const { createApp } = await import('./app.ts');

const db = getDb();

const stubEmbedder = async (texts: string[]) =>
  texts.map((text) => {
    const seed = createHash('sha256').update(text).digest();
    return Array.from({ length: config.embeddingDimensions }, (_, i) => {
      const byte = seed[i % seed.length] ?? 0;
      return (byte / 255) * 2 - 1;
    });
  });

await ingest(db, { trigger: 'cli', embedder: stubEmbedder });

await upsertAccount(db, {
  email: 'admin@test.local',
  password: 'admin-password',
  name: 'Admin',
  role: 'admin',
});
await upsertAccount(db, {
  email: 'user@test.local',
  password: 'user-password',
  name: 'User',
  role: 'user',
});

const app = createApp();

async function cookieFor(email: string, password: string): Promise<string> {
  const response = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  assert.equal(response.status, 200, `sign-in failed for ${email}`);
  return response.headers.getSetCookie().join('; ');
}

const adminCookie = await cookieFor('admin@test.local', 'admin-password');
const userCookie = await cookieFor('user@test.local', 'user-password');

/**
 * Routes that embed a query reach the model provider, and there is no way to
 * inject a stub through HTTP. Those tests are skipped without a key so the suite
 * stays green — and free — on a fresh clone. Nothing about authorization is lost:
 * the 401 and 403 tables below reject before the handler runs and never touch the
 * network, and retrieval quality is covered in packages/core against a stub.
 */
const withProvider = resolveApiKey(getDb()) !== null ? test : test.skip;

test.after(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Options = { cookie?: string; method?: string; body?: unknown };

const call = (route: string, options: Options = {}) =>
  app.request(route, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

/**
 * Every route that must not be public, with the method and a valid body.
 *
 * Kept as data so a new route cannot be added without a decision about who may
 * reach it — an admin-only route missing from this table is a route nobody
 * checked.
 */
const PROTECTED = [
  { route: '/api/search', method: 'POST', body: { query: 'sound assets' }, adminOnly: false },
  { route: '/api/answer', method: 'POST', body: { query: 'sound assets' }, adminOnly: false },
  { route: '/api/admin/documents', method: 'GET', adminOnly: true },
  { route: '/api/admin/documents/1', method: 'GET', adminOnly: true },
  { route: '/api/admin/ingestion/runs', method: 'GET', adminOnly: true },
  { route: '/api/admin/ingestion/run', method: 'POST', body: {}, adminOnly: true },
  { route: '/api/admin/stats', method: 'GET', adminOnly: true },
  { route: '/api/admin/settings/api-key', method: 'GET', adminOnly: true },
  {
    route: '/api/admin/settings/api-key',
    method: 'PUT',
    body: { apiKey: 'sk-test-value-long-enough-to-pass' },
    adminOnly: true,
  },
  { route: '/api/admin/settings/api-key', method: 'DELETE', adminOnly: true },
] as const;

// --- anonymous access -------------------------------------------------------

test('every protected route refuses an anonymous caller with 401', async () => {
  for (const entry of PROTECTED) {
    const response = await call(entry.route, {
      method: entry.method,
      ...('body' in entry ? { body: entry.body } : {}),
    });

    assert.equal(
      response.status,
      401,
      `${entry.method} ${entry.route} returned ${response.status} to an anonymous caller`,
    );
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'unauthorized');
  }
});

test('the anonymous 401 leaks no corpus content', async () => {
  const response = await call('/api/search', { method: 'POST', body: { query: 'sound assets' } });
  const text = await response.text();

  assert.ok(!text.includes('Sound assets'), 'a rejected request must not return passages');
});

// --- role separation --------------------------------------------------------

test('a regular user is refused every admin-only route with 403, not 401', async () => {
  // 403 rather than 401 matters: the user is authenticated, so telling them to
  // sign in would be wrong and would send the UI into a redirect loop.
  for (const entry of PROTECTED.filter((e) => e.adminOnly)) {
    const response = await call(entry.route, {
      method: entry.method,
      cookie: userCookie,
      ...('body' in entry ? { body: entry.body } : {}),
    });

    assert.equal(
      response.status,
      403,
      `${entry.method} ${entry.route} returned ${response.status} to a regular user`,
    );
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'forbidden');
  }
});

withProvider('a regular user can search and get an answer', async () => {
  const search = await call('/api/search', {
    method: 'POST',
    cookie: userCookie,
    body: { query: 'sound assets separate pass' },
  });

  assert.equal(search.status, 200);
  const payload = (await search.json()) as { results: Array<{ sourcePath: string }> };
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0]?.sourcePath, 'build-pipeline.md');
});

test('an admin reaches every admin route', async () => {
  for (const entry of PROTECTED.filter((e) => e.adminOnly && e.method === 'GET')) {
    const response = await call(entry.route, { method: entry.method, cookie: adminCookie });
    assert.ok(
      response.status < 400,
      `${entry.method} ${entry.route} returned ${response.status} to an admin`,
    );
  }
});

// --- validation and error shape ---------------------------------------------

test('a malformed search body is rejected with field-level detail', async () => {
  const response = await call('/api/search', {
    method: 'POST',
    cookie: userCookie,
    body: { query: 'x' },
  });

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: { code: string; details?: object } };
  assert.equal(payload.error.code, 'bad_request');
  assert.ok(payload.error.details, 'validation failures name the offending field');
});

/**
 * A malformed body is the client's mistake, and `c.req.json()` throws a
 * `SyntaxError` rather than a `ZodError` — which reached the generic handler and was
 * answered with 500 `internal` plus a logged stack trace. Every route that requires
 * a body is checked, because the fix is per-route and one left out is one that still
 * reports an outage when someone sends a stray character.
 */
test('a body that is not JSON is the caller’s fault, not a 500', async () => {
  const routes = ['/api/search', '/api/answer', '/api/admin/settings/api-key'] as const;

  for (const route of routes) {
    for (const body of ['not json at all', '', '{"unterminated":']) {
      const response = await app.request(route, {
        method: route.includes('settings') ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body,
      });

      assert.equal(
        response.status,
        400,
        `${route} answered ${response.status} to a malformed body (${JSON.stringify(body)})`,
      );
      const payload = (await response.json()) as { error: { code: string } };
      assert.equal(payload.error.code, 'bad_request');
    }
  }
});

/**
 * The corpus is internal, so the account list is not self-service. Better Auth
 * mounts its own routes under a wildcard, so this proves the block is registered
 * ahead of that mount and actually reached — a guard behind the wildcard would be
 * inert and would look identical in the diff.
 */
test('sign-up is closed to the public', async () => {
  const response = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'stranger@nowhere.test',
      password: 'stranger-password',
      name: 'Stranger',
    }),
  });

  assert.equal(response.status, 403);
  const payload = (await response.json()) as { error: { code: string } };
  assert.equal(payload.error.code, 'forbidden');

  const created = db
    .prepare('SELECT count(*) n FROM "user" WHERE email = ?')
    .get('stranger@nowhere.test') as { n: number };
  assert.equal(Number(created.n), 0, 'no account may be created through the public route');
});

/** Sign-in still works — closing sign-up must not close the door for seeded accounts. */
test('sign-in is unaffected by the sign-up block', async () => {
  const response = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@test.local', password: 'user-password' }),
  });

  assert.equal(response.status, 200);
});

test('an unknown route returns the standard error envelope', async () => {
  const response = await call('/api/does-not-exist');

  assert.equal(response.status, 404);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'not_found');
});

test('a missing document returns 404 rather than an empty success', async () => {
  const response = await call('/api/admin/documents/99999', { cookie: adminCookie });
  assert.equal(response.status, 404);
});

// --- session ----------------------------------------------------------------

test('session reports null when signed out and the user when signed in', async () => {
  const anonymous = await call('/api/session');
  assert.equal(anonymous.status, 200, 'signed out is an answer, not a failure');
  assert.deepEqual(await anonymous.json(), { user: null });

  const signedIn = await call('/api/session', { cookie: adminCookie });
  const payload = (await signedIn.json()) as { user: { email: string; role: string } };
  assert.equal(payload.user.email, 'admin@test.local');
  assert.equal(payload.user.role, 'admin');
});

test('health is public and reports the index size', async () => {
  const response = await call('/health');
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { status: string; indexedChunks: number };
  assert.equal(payload.status, 'ok');
  assert.ok(payload.indexedChunks > 0);
});

// --- admin behaviour --------------------------------------------------------

test('the API key can be set and cleared but never read back', async () => {
  const put = await call('/api/admin/settings/api-key', {
    method: 'PUT',
    cookie: adminCookie,
    body: { apiKey: 'sk-a-secret-value-that-must-not-come-back' },
  });

  assert.equal(put.status, 200);
  const body = await put.text();
  assert.ok(!body.includes('sk-a-secret-value'), 'the response must not echo the key');

  const status = (await (
    await call('/api/admin/settings/api-key', { cookie: adminCookie })
  ).json()) as {
    configured: boolean;
    source: string;
    hint: string;
  };
  assert.equal(status.configured, true);
  assert.equal(status.source, 'database');
  assert.equal(status.hint, '…back', 'only the last four characters');

  await call('/api/admin/settings/api-key', { method: 'DELETE', cookie: adminCookie });
  const cleared = (await (
    await call('/api/admin/settings/api-key', { cookie: adminCookie })
  ).json()) as { source: string };
  assert.notEqual(cleared.source, 'database');
});

test('stats report index health and keep vectors in step with chunks', async () => {
  const response = await call('/api/admin/stats', { cookie: adminCookie });
  const stats = (await response.json()) as {
    index: { documentsTotal: number; chunksTotal: number; embeddingsTotal: number };
    byCategory: Array<{ category: string }>;
    search: { queriesTotal: number };
  };

  assert.equal(stats.index.documentsTotal, 2);
  assert.equal(
    stats.index.embeddingsTotal,
    stats.index.chunksTotal,
    'a divergence here means retrieval is silently broken',
  );
  assert.ok(stats.byCategory.length > 0);
  // The searches performed earlier in this file were recorded.
  assert.ok(stats.search.queriesTotal > 0);
});

test('documents can be filtered and paginated', async () => {
  const all = (await (await call('/api/admin/documents', { cookie: adminCookie })).json()) as {
    total: number;
    items: Array<{ sourcePath: string }>;
  };
  assert.equal(all.total, 2);

  const filtered = (await (
    await call('/api/admin/documents?q=sdk', { cookie: adminCookie })
  ).json()) as { total: number; items: Array<{ sourcePath: string; isDeprecated: boolean }> };

  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.sourcePath, 'sdk-notes-v2.md');
  assert.equal(filtered.items[0]?.isDeprecated, true);

  const paged = (await (
    await call('/api/admin/documents?limit=1&offset=0', { cookie: adminCookie })
  ).json()) as { items: unknown[]; total: number };
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 2, 'total counts all matches, not the page');
});

/**
 * The search text is bound as a parameter, so it can never alter the statement — but
 * that is only half the job. LIKE reads `%` and `_` inside the *value* as wildcards,
 * so a search for `_` matched every document and `%` matched the whole corpus. The
 * text a user types has to be matched as text.
 *
 * Neither fixture document contains either character, in its path or its title, so
 * every search below must find nothing.
 */
test('LIKE wildcards typed into document search are matched literally', async () => {
  for (const needle of ['%', '_', 'sdk_notes', '%pipeline%', '\\']) {
    const response = await call(`/api/admin/documents?q=${encodeURIComponent(needle)}`, {
      cookie: adminCookie,
    });

    assert.equal(response.status, 200, `q=${needle} should be a valid search`);
    const payload = (await response.json()) as { total: number };
    assert.equal(
      payload.total,
      0,
      `q=${JSON.stringify(needle)} matched ${payload.total} documents`,
    );
  }

  // The escaping must not break ordinary substring search.
  const real = (await (
    await call('/api/admin/documents?q=pipeline', { cookie: adminCookie })
  ).json()) as { total: number; items: Array<{ sourcePath: string }> };
  assert.equal(real.total, 1);
  assert.equal(real.items[0]?.sourcePath, 'build-pipeline.md');
});

test('ingestion can be triggered by an admin and returns real counts', async () => {
  const response = await call('/api/admin/ingestion/run', {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    run: { status: string; trigger: string; docsSkipped: number };
  };
  assert.equal(payload.run.status, 'succeeded');
  assert.equal(payload.run.trigger, 'api', 'the run is attributed to the API, not the CLI');
  assert.equal(payload.run.docsSkipped, 2, 'unchanged documents are skipped');
});

/**
 * Responses are parsed against the shared schemas on the way out.
 *
 * They were not before: `c.json()` accepts any object, so renaming `results` to
 * `resultz` type-checked clean and would have shipped. Rows were already validated
 * coming *out* of the database, which left the contract enforced only in the
 * direction the browser does not consume. Asserting through the schema rather than
 * by naming fields, so this test and the client agree by construction.
 */
withProvider('search and session responses match the shared contract exactly', async () => {
  const search = await call('/api/search', {
    method: 'POST',
    cookie: userCookie,
    body: { query: 'why are sound assets built separately' },
  });
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.doesNotThrow(() => searchResponseSchema.parse(searchBody));

  const session = await call('/api/session', { cookie: userCookie });
  const sessionBody = await session.json();
  assert.doesNotThrow(() => sessionResponseSchema.parse(sessionBody));
});

test('a response cannot carry a field the contract does not declare', async () => {
  const response = await call('/api/admin/documents?limit=1', { cookie: adminCookie });
  const body = (await response.json()) as Record<string, unknown>;

  // Zod strips unknown keys, so parsing on the way out also bounds what leaves.
  assert.deepEqual(
    Object.keys(body).sort(),
    ['items', 'limit', 'offset', 'total'],
    'the paged shape is exactly what `paginated(documentSchema)` declares',
  );
});
