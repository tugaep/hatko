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

const { getDb, closeDb, ingest, config, getAuth, upsertAccount } = await import('@hatko/core');
const { createApp } = await import('./app.ts');

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
  assert.equal(body.error?.code, -32001);
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
