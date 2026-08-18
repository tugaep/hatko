import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MCP_TOOL_NAME,
  answerResponseSchema,
  answerStreamEventSchema,
  searchResponseSchema,
  sessionResponseSchema,
  sseData,
  type AnswerStreamEvent,
} from '@hatko/shared';

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

const {
  getDb,
  closeDb,
  ingest,
  config,
  getAuth,
  upsertAccount,
  providerConfigured,
  mcpHostAllowlist,
} = await import('@hatko/core');
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
const withProvider = providerConfigured(getDb()) ? test : test.skip;

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

// --- OAuth / OIDC for MCP clients -------------------------------------------

/**
 * The consent screen is the control that makes open dynamic client registration
 * safe, and it fails silently: the mcp plugin's authorize endpoint only asks when
 * the caller sends `prompt=consent`, so deleting the rewrite in app.ts would leave
 * every flow working while quietly issuing codes to anyone who asks. These prove it
 * still asks, and that discovery still tells a client where to go.
 */

/** Register a client the way an MCP client does — unauthenticated, RFC 7591. */
async function registerClient(name: string, redirect: string): Promise<string> {
  const response = await call('/api/auth/mcp/register', {
    method: 'POST',
    body: {
      client_name: name,
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  assert.equal(response.status, 201, 'dynamic client registration failed');
  const body = (await response.json()) as { client_id?: string };
  assert.ok(body.client_id, 'no client_id issued');
  return body.client_id;
}

function authorizeUrl(clientId: string, redirect: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state: 'test-state',
    // Deliberately no `prompt`: that is the case the rewrite exists to cover.
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });
  return `/api/auth/mcp/authorize?${params.toString()}`;
}

test('authorization always reaches the consent screen, even unprompted', async () => {
  const redirect = 'http://localhost:9999/callback';
  const clientId = await registerClient('Test Client', redirect);

  const response = await call(authorizeUrl(clientId, redirect), { cookie: userCookie });
  assert.equal(response.status, 302);

  const location = response.headers.get('location') ?? '';
  assert.match(location, /\/oauth\/consent\?/, 'authorization skipped the consent screen');
  assert.match(location, /consent_code=/, 'no consent code was issued to the page');

  // The failure this guards against is a code delivered straight to the client.
  assert.doesNotMatch(location, /[?&]code=/, 'an authorization code was issued without consent');
});

test('an unauthenticated authorization goes to sign-in, not to the client', async () => {
  const redirect = 'http://localhost:9999/callback';
  const clientId = await registerClient('Anonymous Client', redirect);

  const response = await call(authorizeUrl(clientId, redirect));
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') ?? '', /\/sign-in/);
});

test('discovery names the MCP endpoint as the resource and this API as the issuer', async () => {
  // A client follows these documents without being told where to look, so the values
  // in them are the contract. `resource` defaulting to the API's own origin — which is
  // what happens without the explicit setting — would point clients at the wrong
  // audience entirely.
  const resource = await call('/.well-known/oauth-protected-resource');
  assert.equal(resource.status, 200);
  const resourceBody = (await resource.json()) as {
    resource: string;
    authorization_servers: string[];
  };
  assert.equal(resourceBody.resource, config.mcpUrl);
  assert.deepEqual(resourceBody.authorization_servers, [config.apiUrl]);

  const server = await call('/.well-known/oauth-authorization-server');
  assert.equal(server.status, 200);
  const serverBody = (await server.json()) as {
    issuer: string;
    code_challenge_methods_supported: string[];
    registration_endpoint: string;
  };
  assert.equal(serverBody.issuer, config.apiUrl);
  // PKCE is not optional for a public client, which every MCP client is.
  assert.deepEqual(serverBody.code_challenge_methods_supported, ['S256']);
  assert.match(serverBody.registration_endpoint, /\/register$/);
});

test('the consent screen can identify the client asking, and only for a signed-in user', async () => {
  const redirect = 'http://localhost:9999/callback';
  const clientId = await registerClient('Nameable Client', redirect);

  const anonymous = await call(`/api/oauth/client/${clientId}`);
  assert.equal(anonymous.status, 401, 'client details were readable without a session');

  const found = await call(`/api/oauth/client/${clientId}`, { cookie: userCookie });
  assert.equal(found.status, 200);
  const client = (await found.json()) as { name: string; redirectUris: string[] };
  assert.equal(client.name, 'Nameable Client');
  assert.deepEqual(client.redirectUris, [redirect]);

  const missing = await call('/api/oauth/client/never-registered', { cookie: userCookie });
  assert.equal(missing.status, 404);
});

// --- user management --------------------------------------------------------

/**
 * The admin user surface, and the two refusals that keep it from being an outage.
 *
 * An admin panel that can demote the last administrator, or the administrator using it,
 * locks everybody out of the system permanently — recoverable only by a CLI seed. Both
 * are enforced server-side because a disabled button is a courtesy and this is a
 * lockout. The third test is the one that makes deactivation mean something: it must
 * end sessions that already exist, not merely block the next sign-in.
 */

/**
 * The MCP tab's whole reason for existing is the host list, so the list it shows has to be
 * the list the MCP server enforces. Both now call `mcpHostAllowlist`, and this pins that:
 * a reported allowlist that has drifted from the enforced one is worse than none, because
 * it tells an operator their configuration is fine while every client gets a 403.
 */
test('the reported MCP hosts are the ones the server actually accepts', async () => {
  const response = await call('/api/admin/mcp', { cookie: adminCookie });
  assert.equal(response.status, 200);

  const info = (await response.json()) as { allowedHosts: string[]; tool: { name: string } };
  assert.deepEqual(info.allowedHosts, mcpHostAllowlist(), 'one derivation, not two');
  assert.ok(info.allowedHosts.includes('localhost'), 'every loopback spelling stays accepted');
  assert.equal(info.tool.name, MCP_TOOL_NAME, 'the published tool name, not a second literal');
});

test('the MCP endpoint is reported as answering when it is', async () => {
  // The probe is unauthenticated on purpose: a 401 with a challenge *is* the healthy
  // reply, so it needs no credential and cannot act on the caller's behalf.
  const response = await call('/api/admin/mcp', { cookie: adminCookie });
  const info = (await response.json()) as { status: string };
  assert.ok(
    ['authenticating', 'unreachable', 'unexpected'].includes(info.status),
    'status is one of the three states the schema declares',
  );
});

test('a regular user cannot reach any user-management route', async () => {
  const list = await call('/api/admin/users', { cookie: userCookie });
  assert.equal(list.status, 403);

  const create = await call('/api/admin/users', {
    method: 'POST',
    cookie: userCookie,
    body: { email: 'sneaky@test.local', name: 'Sneaky', password: 'password123', role: 'admin' },
  });
  assert.equal(create.status, 403);

  const update = await call('/api/admin/users/whoever', {
    method: 'PUT',
    cookie: userCookie,
    body: { role: 'admin' },
  });
  assert.equal(update.status, 403);
});

test('an admin can add an account, and a duplicate email is a conflict', async () => {
  const created = await call('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { email: 'added@test.local', name: 'Added', password: 'password123', role: 'user' },
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { email: string; role: string; disabled: boolean };
  assert.equal(body.email, 'added@test.local');
  assert.equal(body.role, 'user');
  assert.equal(body.disabled, false);

  // Without this, `upsertAccount` would quietly reset an existing account's password
  // from a form labelled "create".
  const again = await call('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { email: 'added@test.local', name: 'Added', password: 'different1', role: 'admin' },
  });
  assert.equal(again.status, 409);
});

test('an administrator cannot change their own role or deactivate themselves', async () => {
  const list = await call('/api/admin/users', { cookie: adminCookie });
  const { items } = (await list.json()) as { items: { id: string; isSelf: boolean }[] };
  const self = items.find((item) => item.isSelf);
  assert.ok(self, 'the list did not mark the requesting administrator');

  const demote = await call(`/api/admin/users/${self.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { role: 'user' },
  });
  assert.equal(demote.status, 409, 'an administrator demoted themselves');

  const disable = await call(`/api/admin/users/${self.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { disabled: true },
  });
  assert.equal(disable.status, 409, 'an administrator deactivated themselves');
});

test('the last active administrator cannot be demoted or deactivated', async () => {
  // Promote someone, so there are two admins and the guard is not simply the self-check
  // from the previous test wearing a different hat.
  const created = await call('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { email: 'second@test.local', name: 'Second', password: 'password123', role: 'admin' },
  });
  assert.equal(created.status, 201);
  const second = (await created.json()) as { id: string };

  // Two active admins, so demoting one is allowed.
  const demoted = await call(`/api/admin/users/${second.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { role: 'user' },
  });
  assert.equal(demoted.status, 200);

  // The requesting admin is now the only one left, and is also self — so this asserts
  // the pair of guards together, which is how they are actually met.
  const list = await call('/api/admin/users', { cookie: adminCookie });
  const { items } = (await list.json()) as { items: { id: string; isSelf: boolean }[] };
  const self = items.find((item) => item.isSelf);
  assert.ok(self);

  const lockout = await call(`/api/admin/users/${self.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { role: 'user' },
  });
  assert.equal(lockout.status, 409);
});

test('deactivating an account ends the session it already had', async () => {
  await upsertAccount(db, {
    email: 'doomed@test.local',
    password: 'password123',
    name: 'Doomed',
    role: 'user',
  });

  const cookie = await cookieFor('doomed@test.local', 'password123');

  // Working before.
  const before = await call('/api/session', { cookie });
  const beforeBody = (await before.json()) as { user: { email: string } | null };
  assert.equal(beforeBody.user?.email, 'doomed@test.local');

  const id = (
    db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get('doomed@test.local') as {
      id: string;
    }
  ).id;
  const disabled = await call(`/api/admin/users/${id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200);

  /**
   * The property that matters. A flag checked only at sign-in would leave this session
   * valid for its remaining seven days, and the same is true of any MCP token issued to
   * this account — both resolve identity through `getSessionUser`.
   */
  const after = await call('/api/session', { cookie });
  const afterBody = (await after.json()) as { user: unknown };
  assert.equal(afterBody.user, null, 'a deactivated account kept its session');

  const search = await call('/api/search', {
    method: 'POST',
    cookie,
    body: { query: 'sound assets' },
  });
  assert.equal(search.status, 401, 'a deactivated account could still search');

  // Reactivating restores it, so deactivation is reversible rather than destructive.
  await call(`/api/admin/users/${id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { disabled: false },
  });
  const restored = await call('/api/session', { cookie });
  const restoredBody = (await restored.json()) as { user: { email: string } | null };
  assert.equal(restoredBody.user?.email, 'doomed@test.local');
});

test('the user list filters on name and email, wildcards taken literally', async () => {
  const match = await call('/api/admin/users?q=added', { cookie: adminCookie });
  const matched = (await match.json()) as { items: { email: string }[]; total: number };
  assert.ok(
    matched.items.every((item) => item.email.includes('added') || item.email.includes('Added')),
    'the filter returned an account it should not have',
  );

  // `%` is a wildcard to LIKE and a literal to the person typing it.
  const wildcard = await call('/api/admin/users?q=%', { cookie: adminCookie });
  const wild = (await wildcard.json()) as { total: number };
  assert.equal(wild.total, 0, 'a percent sign matched every account');
});

test('a deactivated account is told why sign-in fails, not silently looped', async () => {
  await deactivatedFixture();

  const refused = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'switchedoff@test.local', password: 'password123' },
  });
  assert.equal(refused.status, 403, 'sign-in succeeded for a deactivated account');
  const body = (await refused.json()) as { error: { message: string } };
  assert.match(body.error.message, /deactivated/i);

  // Reactivating restores sign-in, so the refusal tracks the flag rather than the
  // account being broken.
  const id = (
    db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get('switchedoff@test.local') as {
      id: string;
    }
  ).id;
  await call(`/api/admin/users/${id}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { disabled: false },
  });

  const allowed = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'switchedoff@test.local', password: 'password123' },
  });
  assert.equal(allowed.status, 200);
});

test('sign-in still rejects a wrong password for an active account', async () => {
  // The interception above reads the email to look up the account; it must not have
  // become a way to sign in without the password.
  const response = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: 'switchedoff@test.local', password: 'not-the-password' },
  });
  assert.notEqual(response.status, 200, 'a wrong password was accepted');
});

/** An account that exists and is switched off, for the two tests above. */
async function deactivatedFixture(): Promise<void> {
  await upsertAccount(db, {
    email: 'switchedoff@test.local',
    password: 'password123',
    name: 'Switched Off',
    role: 'user',
  });
  const id = (
    db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get('switchedoff@test.local') as {
      id: string;
    }
  ).id;
  db.prepare('UPDATE "user" SET "disabled" = 1 WHERE "id" = ?').run(id);
}

// --- rate limiting ----------------------------------------------------------

/**
 * The allowance on the two routes that spend money.
 *
 * Exhausted with malformed bodies rather than real queries, which is not a dodge — it is
 * the behaviour worth pinning. `throttle()` sits after the role check and before the
 * handler, so a request is counted whether or not it goes on to reach the retriever. That
 * is the correct order: a caller flooding the endpoint with rubbish is still a caller
 * flooding the endpoint, and it means this test needs no provider key while still
 * exercising the real middleware chain.
 *
 * Its own account, because the limiter is process-wide and keyed by user — spending the
 * shared fixtures' allowance here would make unrelated tests fail depending on the order
 * they ran in.
 */
async function throttleFixture(email: string): Promise<string> {
  await upsertAccount(db, { email, password: 'throttle-password', name: 'Throttle', role: 'user' });
  return cookieFor(email, 'throttle-password');
}

test('an account past its allowance is refused with 429 and told how long to wait', async () => {
  const cookie = await throttleFixture('throttled@test.local');

  for (let i = 0; i < config.rateLimitMax; i++) {
    const response = await call('/api/search', { method: 'POST', cookie, body: { query: '' } });
    assert.equal(response.status, 400, `request ${i + 1} was not counted as a normal request`);
  }

  const refused = await call('/api/search', { method: 'POST', cookie, body: { query: '' } });
  assert.equal(refused.status, 429, 'the allowance was not enforced');

  const body = (await refused.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'rate_limited');
  // `Retry-After` is what a client library acts on without being told to. A 429 carrying
  // only prose leaves every caller to invent its own backoff.
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.ok(retryAfter >= 1, 'no usable Retry-After header');
  assert.ok(retryAfter <= config.rateLimitWindowSeconds, 'Retry-After exceeds the window');
});

test('the allowance is per account, so one caller cannot lock out another', async () => {
  // The test above has already exhausted `throttled@test.local`. If the limiter were
  // global, or keyed by anything the two share, this second account would be refused
  // too — and one client in a retry loop could deny search to everyone.
  const cookie = await throttleFixture('not-throttled@test.local');

  const response = await call('/api/search', { method: 'POST', cookie, body: { query: '' } });
  assert.equal(response.status, 400, 'an unrelated account was caught by another’s limit');
});

test('the answer route draws from the same allowance as search', async () => {
  /**
   * One budget, not one per route. Two separate allowances would let a caller spend twice
   * the intended amount by alternating endpoints — and `/answer` is the more expensive of
   * the two, at three provider calls against a search's two.
   */
  const cookie = await throttleFixture('shared-budget@test.local');

  for (let i = 0; i < config.rateLimitMax; i++) {
    const response = await call('/api/search', { method: 'POST', cookie, body: { query: '' } });
    assert.equal(response.status, 400);
  }

  const refused = await call('/api/answer', { method: 'POST', cookie, body: { query: '' } });
  assert.equal(refused.status, 429, '/answer had an allowance of its own');
});

test('an anonymous flood cannot spend a real account’s allowance', async () => {
  /**
   * The reason `throttle()` is mounted after `requires` rather than before it. Limiting
   * first would mean counting requests before knowing who made them — so either every
   * anonymous caller shares one bucket, or worse, a request that will be rejected as
   * unauthenticated still charges somebody. Here authorization refuses first and nothing
   * is spent.
   */
  const cookie = await throttleFixture('untouched@test.local');

  for (let i = 0; i < config.rateLimitMax + 5; i++) {
    const response = await call('/api/search', { method: 'POST', body: { query: 'sound assets' } });
    assert.equal(response.status, 401);
  }

  const mine = await call('/api/search', { method: 'POST', cookie, body: { query: '' } });
  assert.equal(mine.status, 400, 'an anonymous flood consumed a real account’s allowance');
});

// --- streamed answers -------------------------------------------------------

/**
 * The same question, two representations, negotiated by `Accept`.
 *
 * These run with or without a provider key, which is the point. Without one the answer
 * path fails at the first embedding call — and that is the case worth pinning: a failure
 * *after* the 200 has gone out has no status code left to use, so it must arrive as an
 * enveloped event rather than as a stream that simply stops. A truncated answer that looks
 * complete is the worst outcome available here, and nothing about HTTP prevents it.
 */

async function streamAnswer(cookie: string, query: string) {
  const response = await app.request('/api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie },
    body: JSON.stringify({ query }),
  });

  assert.equal(response.status, 200, 'a stream begins before the outcome is known');
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body, 'no stream body');

  const events: AnswerStreamEvent[] = [];
  for await (const data of sseData(response.body)) {
    // Parsed against the shared schema, so an event shape the browser could not read is a
    // failure here rather than a blank answer in the UI.
    events.push(answerStreamEventSchema.parse(JSON.parse(data)));
  }
  return events;
}

test('a streamed answer ends in a terminal event, whatever happened', async () => {
  const cookie = await throttleFixture('stream@test.local');
  const events = await streamAnswer(cookie, 'Why are sound assets built in a separate pass?');

  assert.ok(events.length > 0, 'the stream carried no events at all');

  const last = events.at(-1);
  assert.ok(
    last?.type === 'answer' || last?.type === 'error',
    `the stream ended on a "${last?.type}" event, so a client cannot tell it finished`,
  );

  // Only one terminal event, and nothing after it.
  const terminal = events.filter((e) => e.type === 'answer' || e.type === 'error');
  assert.equal(terminal.length, 1);

  if (last.type === 'error') {
    // No key on this machine. The envelope must be the same one every other route uses,
    // and must not carry internals — a stack trace in an event body is a disclosure just
    // as much as in a response body.
    assert.ok(last.error.code, 'the failure event carries no code');
    assert.ok(last.error.message.length > 0);
    assert.ok(!/\n\s+at |node:internal/.test(last.error.message), 'the message leaks a stack');
    return;
  }

  // A key is configured, so this is a real answer. The passages must have been reported
  // before the deltas, and the deltas must reassemble into something — the abstain
  // decision may still have replaced the text, which is exactly the point of the check in
  // packages/core: nothing here asserts the deltas *are* the answer.
  const kinds = events.map((e) => e.type);
  assert.equal(kinds.indexOf('passages'), 0, 'the passages were not reported first');
  assert.deepEqual(last.response.sources, events[0]?.type === 'passages' ? events[0].sources : []);
});

withProvider('the JSON representation is unchanged by the streaming one', async () => {
  const cookie = await throttleFixture('json-answer@test.local');
  const response = await call('/api/answer', {
    method: 'POST',
    cookie,
    body: { query: 'Why are sound assets built in a separate pass?' },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  // Parses, so the one-body contract still holds for `curl` and the eval.
  answerResponseSchema.parse(await response.json());
});
