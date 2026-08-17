import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The MCP surface, exercised through `app.request()`.
 *
 * Two things here fail silently, and they are what this file is for.
 *
 * The first is authorization. An MCP server that forgets to check its bearer token
 * still initializes, still lists its tool, and still answers — it just answers
 * anyone. Nothing about that looks broken from the outside, so it has to be proved
 * from the outside: an anonymous caller and a caller with a forged token must both
 * be refused, through the real router and the real permission check.
 *
 * The second is the published input schema. It is derived from the shared search
 * contract with `.unwrap()`, which is exactly the kind of expression that keeps
 * type-checking after it stops meaning what it meant — drop the bounds, or turn
 * `limit` back into a required field, and every client silently gets a worse
 * schema. `tools/list` is where a client actually reads it, so that is where it is
 * asserted.
 */

process.env.BETTER_AUTH_SECRET ??= 'test-only-secret-not-used-outside-node-test-runs';
// Set before @hatko/core is imported: config.ts snapshots the environment at import, and
// the DNS-rebinding allow-list is built from it at module scope.
process.env.MCP_ALLOWED_HOSTS = 'hatko.example.test,hatko.example.test:8443';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-mcp-'));
process.env.DATABASE_PATH = path.join(dir, 'mcp.db');
// Two documents is enough: this file is about the protocol and the gate in front of
// it, not about retrieval quality, which is measured in packages/core.
process.env.CORPUS_PATH = path.join(dir, 'corpus');
fs.mkdirSync(process.env.CORPUS_PATH, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CORPUS_PATH, 'localization-guide.md'),
  '# Localization Guide\n\nEvery playable ships with a minimum language set: English, Spanish and ' +
    'Japanese. Language is auto-detected from the device locale, with English as the fallback.\n',
);

const {
  getDb,
  closeDb,
  ingest,
  config,
  getAuth,
  upsertAccount,
  resolveApiKey,
  ProviderError,
  ConfigurationError,
} = await import('@hatko/core');
const { createApp, toToolErrorText } = await import('./app.ts');

const db = getDb();

/** Deterministic stand-in for the embedding provider, so the suite needs no network. */
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
  email: 'user@test.local',
  password: 'user-password',
  name: 'User',
  role: 'user',
});

const app = createApp();

/**
 * A bearer token for a real session.
 *
 * Read from the `set-auth-token` response header, which is the same way a person
 * following the README gets one — so if the bearer plugin were removed, this would
 * fail here rather than in a client six steps later.
 */
async function tokenFor(email: string, password: string): Promise<string> {
  const response = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  assert.equal(response.status, 200, `sign-in failed for ${email}`);
  const token = response.headers.get('set-auth-token');
  assert.ok(token, 'no set-auth-token header — is the bearer plugin still enabled?');
  return token;
}

const userToken = await tokenFor('user@test.local', 'user-password');

test.after(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A JSON-RPC request against /mcp, with whatever authorization is being tested.
 *
 * The `Host` header is set explicitly because `app.request()` sends none, while a
 * real HTTP/1.1 request always carries one and the Node server always populates it.
 * The DNS-rebinding check rejects a missing Host, so without this every
 * authenticated case here would fail 403 for a reason that cannot occur over a
 * socket. Tests that care about the Host override it.
 */
async function rpc(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Both types: the transport may answer with either, and a client that
      // accepts only one gets a 406.
      accept: 'application/json, text/event-stream',
      host: `localhost:${config.mcpPort}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/**
 * The JSON-RPC envelope, typed loosely on purpose.
 *
 * These are assertions about another process's wire format, not about our own
 * domain, so there is nothing to gain from modelling the protocol in Zod here —
 * the assertions below are the check, and a missing field fails them.
 */
interface RpcEnvelope {
  result?: {
    serverInfo?: { name?: string };
    tools?: { name: string; inputSchema: JsonSchema; annotations?: Record<string, unknown> }[];
    content?: { text?: string }[];
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

interface JsonSchema {
  required?: string[];
  properties: Record<
    string,
    { minLength?: number; maxLength?: number; minimum?: number; maximum?: number }
  >;
}

const envelope = async (response: Response): Promise<RpcEnvelope> =>
  (await response.json()) as RpcEnvelope;

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1.0.0' },
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// --- the gate ---------------------------------------------------------------

test('an anonymous caller cannot initialize a session', async () => {
  const response = await rpc('initialize', INITIALIZE);
  assert.equal(response.status, 401);

  // Tells the client how to authenticate, not merely that it failed.
  assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);

  const body = await envelope(response);
  // Implementation-defined, and deliberately not -32000 or -32001: the SDK's own
  // ErrorCode enum already uses those for ConnectionClosed and RequestTimeout.
  assert.equal(body.error?.code, -32002);
});

test('a forged bearer token is refused rather than trusted', async () => {
  // The shape is plausible and the signature is not: this is the case that
  // separates "verifies the token" from "reads the token".
  const response = await rpc('initialize', INITIALIZE, bearer('bWFkZS11cA.bm90LWEtc2lnbmF0dXJl'));
  assert.equal(response.status, 401);
});

test('a token signed with the wrong secret is refused', async () => {
  const response = await rpc('initialize', INITIALIZE, bearer(`${userToken}tampered`));
  assert.equal(response.status, 401);
});

test('an anonymous caller cannot list tools either', async () => {
  // Listing is a separate method from initializing, and a gate applied per method
  // rather than per request is a gate with holes in it.
  const response = await rpc('tools/list', {});
  assert.equal(response.status, 401);
});

test('a signed-in user with search:run gets through', async () => {
  const response = await rpc('initialize', INITIALIZE, bearer(userToken));
  assert.equal(response.status, 200);

  const body = await envelope(response);
  assert.equal(body.result?.serverInfo?.name, 'hatko');
});

test('a request under a foreign Host is rejected', async () => {
  // DNS rebinding: a page in the user's browser resolving its own hostname to
  // 127.0.0.1 and posting here. Rejected on the Host header, before the body.
  const response = await rpc('initialize', INITIALIZE, {
    ...bearer(userToken),
    host: 'evil.example.com',
  });
  assert.equal(response.status, 403);
});

test('every loopback spelling of this host is accepted', async () => {
  // The other half of the check above. If this fails, the security control has
  // become an outage for anyone who wrote the address differently.
  for (const host of ['localhost', '127.0.0.1', `localhost:${config.mcpPort}`]) {
    const response = await rpc('initialize', INITIALIZE, { ...bearer(userToken), host });
    assert.equal(response.status, 200, `Host: ${host} was rejected`);
  }
});

// --- the published contract -------------------------------------------------

test('tools/list publishes search_corpus with the shared query bounds', async () => {
  const response = await rpc('tools/list', {}, bearer(userToken));
  assert.equal(response.status, 200);

  const { result } = await envelope(response);
  const tool = result?.tools?.find((t) => t.name === 'search_corpus');
  assert.ok(tool, 'search_corpus is not published');

  const { required, properties } = tool.inputSchema;

  // Only `query` is required. `limit` carrying a Zod default would land here as a
  // required field and make every caller supply a number it should not have to.
  assert.deepEqual(required, ['query']);

  const query = properties.query;
  const limit = properties.limit;
  assert.ok(query, 'query is not published');
  assert.ok(limit, 'limit is not published');

  // The bounds come from `searchRequestSchema`. If the derivation stops carrying
  // them, a client can send a 5000-character query and be rejected by a validator
  // it was never told about.
  assert.equal(query.maxLength, 500);
  assert.equal(query.minLength, 2);
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, 20);

  // Read-only and closed-world: a client is entitled to know the tool cannot
  // change anything before it decides whether to call it unattended.
  assert.equal(tool.annotations?.readOnlyHint, true);
});

test('an out-of-range argument is rejected by the protocol layer', async () => {
  // Proves the published bounds are enforced and not merely advertised.
  const response = await rpc(
    'tools/call',
    { name: 'search_corpus', arguments: { query: 'x'.repeat(501) } },
    bearer(userToken),
  );
  assert.equal(response.status, 200, 'tool errors are JSON-RPC errors, not HTTP errors');

  const body = await response.json();
  assert.match(JSON.stringify(body), /validation|too big|maxLength/i);
});

// --- the error boundary -----------------------------------------------------

/**
 * The SDK answers a throwing tool callback with `error.message` verbatim, which was
 * measured putting `SQLITE_ERROR: no such column: secret_key in /Users/…/hatko.db`
 * into a tool result. These assert the boundary that stops it, and they are the
 * reason `toToolErrorText` is exported at all: forcing a real provider outage or a
 * corrupt database through the transport is far more machinery than checking the
 * function that decides what a caller is allowed to read.
 */

test('an unexpected failure is generalised rather than forwarded', () => {
  const leak = 'SQLITE_ERROR: no such column: secret_key in /Users/someone/private/hatko.db';
  const text = toToolErrorText(new Error(leak));

  assert.doesNotMatch(text, /SQLITE|secret_key|\/Users\//, 'internal detail reached the caller');
  assert.match(text, /unexpected/i);
});

test('a provider outage is named without leaking the provider response', () => {
  const text = toToolErrorText(
    new ProviderError('OpenAI 401: Incorrect API key provided: sk-proj-abc123', { status: 401 }),
  );

  assert.doesNotMatch(text, /sk-proj|401/, 'the upstream response reached the caller');
  // Still actionable: the caller should retry rather than conclude the corpus is empty.
  assert.match(text, /provider/i);
});

test('a configuration error is forwarded, because it is the fix', () => {
  // Written to be actionable and carrying nothing internal — the one class of message
  // worth passing through. A caller who cannot see this reads a broken retriever as
  // an empty corpus.
  const text = toToolErrorText(new ConfigurationError('No OpenAI API key is set. Set it in .env.'));
  assert.match(text, /No OpenAI API key is set/);
});

/**
 * A tool call embeds and reranks the query, so it reaches the model provider and
 * there is no seam to inject a stub through HTTP. Skipped without a key so the suite
 * stays green — and free — on a fresh clone, the same convention
 * `apps/api/src/app.test.ts` uses. Nothing above depends on it: the gate and the
 * published schema never touch the network.
 */
const withProvider = resolveApiKey(getDb()) !== null ? test : test.skip;

withProvider('an abstention is not routed through the error boundary', async () => {
  // The product's most important behaviour must stay a *successful* result. If it
  // were ever answered with isError, every client would report the corpus being
  // honest as the tool being broken.
  const response = await rpc(
    'tools/call',
    { name: 'search_corpus', arguments: { query: 'parental leave policy in Portugal', limit: 2 } },
    bearer(userToken),
  );
  assert.equal(response.status, 200);

  const { result } = await envelope(response);
  assert.notEqual(result?.isError, true, 'an abstention was reported as an error');
  assert.match(result?.content?.[0]?.text ?? '', /does not cover|do not answer/i);
});

// --- the OAuth branch of the gate -------------------------------------------

/**
 * `requireMcpPermission` accepts two credentials, and the OAuth one is the branch a
 * session token can never exercise. What fails silently here is the *user* lookup: an
 * access token names a user id, and trusting that name without loading the row would
 * mean a token outliving its account keeps working. Rows are inserted directly because
 * running the whole authorization-code flow in-process to obtain one would test Better
 * Auth rather than this gate.
 */

const OAUTH_CLIENT_ID = 'test-client-fixture';

db.prepare(
  `INSERT INTO "oauthApplication"
     ("id", "name", "clientId", "redirectUrls", "type", "disabled", "createdAt", "updatedAt")
   VALUES (?, ?, ?, ?, 'public', 0, ?, ?)`,
).run(
  'app-fixture',
  'Fixture Client',
  OAUTH_CLIENT_ID,
  'http://localhost:9999/callback',
  new Date().toISOString(),
  new Date().toISOString(),
);

/** Issue an access token row directly. `expiresInMs` may be negative to make it stale. */
function issueToken(token: string, userId: string, expiresInMs: number): void {
  const now = new Date();
  db.prepare(
    `INSERT INTO "oauthAccessToken"
       ("id", "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt",
        "clientId", "userId", "scopes", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, 'openid profile email', ?, ?)`,
  ).run(
    `id-${token}`,
    token,
    `refresh-${token}`,
    new Date(now.getTime() + expiresInMs).toISOString(),
    new Date(now.getTime() + 604_800_000).toISOString(),
    OAUTH_CLIENT_ID,
    userId,
    now.toISOString(),
    now.toISOString(),
  );
}

/** The seeded user's id, which the token has to name for the lookup to resolve. */
const fixtureUserId = (
  db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get('user@test.local') as { id: string }
).id;

test('a valid OAuth access token authorizes an MCP session', async () => {
  issueToken('valid-oauth-token', fixtureUserId, 3_600_000);

  const response = await rpc('initialize', INITIALIZE, bearer('valid-oauth-token'));
  assert.equal(response.status, 200, 'a live OAuth token was refused');

  const body = await envelope(response);
  assert.equal(body.result?.serverInfo?.name, 'hatko');
});

test('an expired OAuth access token is refused', async () => {
  issueToken('expired-oauth-token', fixtureUserId, -1_000);

  const response = await rpc('initialize', INITIALIZE, bearer('expired-oauth-token'));
  assert.equal(response.status, 401, 'an expired token still worked');
});

test('a token cannot name a user who does not exist', () => {
  /**
   * Written first as "an orphan token is refused with 401", which failed — the insert
   * itself is impossible: `FOREIGN KEY constraint failed`. That is the stronger
   * guarantee, so it is what gets asserted. `requireMcpPermission` still handles the
   * null user, because `getUserById` returns `SessionUser | null` and something has to;
   * it fails closed, and the schema means it should never be reached.
   */
  assert.throws(
    () => issueToken('orphan-oauth-token', 'user-id-that-was-never-created', 3_600_000),
    /FOREIGN KEY/,
    'an access token could be created for a user who does not exist',
  );
});

test('deleting a user takes their OAuth tokens with them', async () => {
  // The cascade itself, since the check above depends on it being the belt rather than
  // the braces. A token surviving its account is a credential nobody can revoke.
  await upsertAccount(db, {
    email: 'temp@test.local',
    password: 'temp-password',
    name: 'Temporary',
    role: 'user',
  });
  const tempId = (
    db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get('temp@test.local') as { id: string }
  ).id;
  issueToken('doomed-oauth-token', tempId, 3_600_000);

  db.prepare('DELETE FROM "user" WHERE "id" = ?').run(tempId);

  const remaining = db
    .prepare('SELECT count(*) n FROM "oauthAccessToken" WHERE "userId" = ?')
    .get(tempId) as { n: number };
  assert.equal(Number(remaining.n), 0, 'an OAuth token outlived the account it belonged to');
});

test('a configured public host is accepted, and others still are not', async () => {
  /**
   * The deployment case. Behind a reverse proxy the `Host` is the public hostname, so
   * without `MCP_ALLOWED_HOSTS` a deployed server answers 403 to everything — the
   * failure that gets a security control switched off rather than configured.
   *
   * A second app instance is built because `allowedHosts` is read at module scope from
   * config, which snapshots the environment at import.
   */
  const { createApp: createConfigured } = await import('./app.ts');
  const configured = createConfigured();

  const send = (host: string) =>
    configured.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host,
        ...bearer(userToken),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE }),
    });

  for (const host of config.mcpAllowedHosts) {
    const response = await send(host);
    assert.equal(response.status, 200, `configured host ${host} was rejected`);
  }

  // Widening the list must not turn the check off.
  const foreign = await send('evil.example.com');
  assert.equal(foreign.status, 403, 'a foreign Host was accepted');
});
