import { Hono } from 'hono';
import {
  SETTING_KEYS,
  activeModels,
  clearModelSettings,
  clearSecret,
  config,
  getApiKeyStatus,
  getChunksForDocument,
  getDashboardStats,
  getDb,
  getDocumentById,
  getEmbeddingMap,
  getUser,
  ingest,
  listDocumentsFiltered,
  listIngestionRuns,
  listModels,
  listUsers,
  mcpHostAllowlist,
  resolveApiKey,
  setSecret,
  setSetting,
  updateUser,
  upsertAccount,
} from '@hatko/core';
import {
  MCP_TOOL_NAME,
  MODEL_PRESETS,
  type McpReachability,
  adminUserSchema,
  createUserRequestSchema,
  documentDetailSchema,
  documentSchema,
  listDocumentsQuerySchema,
  listUsersQuerySchema,
  mcpInfoSchema,
  paginated,
  searchRequestSchema,
  setApiKeyRequestSchema,
  setModelsRequestSchema,
  triggerIngestionRequestSchema,
  updateUserRequestSchema,
} from '@hatko/shared';
import { z } from 'zod';
import { requires } from '../middleware.ts';
import { HttpError, jsonBody } from '../errors.ts';

/**
 * Admin surfaces: corpus management, ingestion control, statistics and the
 * provider API key.
 *
 * Every route here is gated on an admin-only permission. A regular user reaching
 * any of them gets 403 — the check is the middleware, not a conditional inside the
 * handler, so there is no path where the work happens first.
 */

export const adminRoutes = new Hono();

/**
 * The paged-documents contract, built from the shared `paginated` helper — which
 * until now had no caller anywhere, so the shape it describes and the shape this
 * route returned were only ever the same by inspection.
 */
const documentPageSchema = paginated(documentSchema);

adminRoutes.get('/documents', requires('documents:manage'), (c) => {
  const query = listDocumentsQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

  const { items, total } = listDocumentsFiltered(getDb(), {
    limit: query.limit,
    offset: query.offset,
    // Both have schema defaults, so they are always present rather than conditional.
    sort: query.sort,
    direction: query.direction,
    ...(query.status ? { status: query.status } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.q ? { q: query.q } : {}),
  });

  return c.json(
    documentPageSchema.parse({ items, total, limit: query.limit, offset: query.offset }),
  );
});

/** One document with its passages, so the dashboard can show what was indexed. */
adminRoutes.get('/documents/:id', requires('documents:manage'), (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const db = getDb();

  const document = getDocumentById(db, id);
  if (!document) throw new HttpError('not_found', `No document with id ${id}.`);

  return c.json(documentDetailSchema.parse({ document, chunks: getChunksForDocument(db, id) }));
});

adminRoutes.get('/ingestion/runs', requires('documents:manage'), (c) =>
  c.json({ items: listIngestionRuns(getDb(), 20) }),
);

/**
 * Trigger ingestion.
 *
 * Awaited rather than backgrounded. The sample corpus re-ingests in about three
 * seconds and skips unchanged files in milliseconds, so a synchronous response
 * carrying the real counts is more useful than a job id the client must poll — and
 * it avoids inventing a job runner for a task this size. If the corpus grew to
 * where this timed out, that is the point to add one.
 */
adminRoutes.post('/ingestion/run', requires('ingestion:trigger'), async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const body = triggerIngestionRequestSchema.parse(raw);

  const run = await ingest(getDb(), { trigger: 'api', force: body.force });
  return c.json({ run });
});

adminRoutes.get('/stats', requires('dashboard:view'), (c) => c.json(getDashboardStats(getDb())));

// --- provider API key -------------------------------------------------------

/**
 * Status only — the key itself is never returned.
 *
 * There is no endpoint that reads a stored secret back, deliberately. A browser
 * has no legitimate need for the value, and an endpoint that returned it would be
 * one XSS or one loose role check away from leaking a live credential.
 */
adminRoutes.get('/settings/api-key', requires('documents:manage'), (c) =>
  c.json(getApiKeyStatus(getDb())),
);

adminRoutes.put('/settings/api-key', requires('documents:manage'), async (c) => {
  const body = setApiKeyRequestSchema.parse(await jsonBody(c));
  const db = getDb();

  setSecret(db, SETTING_KEYS.openaiApiKey, body.apiKey, c.get('user').id);
  return c.json(getApiKeyStatus(db));
});

/** Remove the stored key, falling back to the environment variable if one is set. */
adminRoutes.delete('/settings/api-key', requires('documents:manage'), (c) => {
  const db = getDb();
  clearSecret(db, SETTING_KEYS.openaiApiKey);
  return c.json(getApiKeyStatus(db));
});

/**
 * The corpus projected to three dimensions, for the dashboard's embedding view.
 *
 * Admin-only like every other route in this file, and for a reason beyond consistency:
 * the response carries every document's title and category, which is a listing of the
 * corpus. That is the same thing `/documents` returns and is gated the same way.
 *
 * Computed per request rather than cached. It is one exhaustive pass over 142 vectors,
 * and a cache would need invalidating on every ingest — see the note in embedding-map.ts
 * for where that stops being true.
 */
adminRoutes.get('/embedding-map', requires('documents:manage'), (c) =>
  c.json(getEmbeddingMap(getDb())),
);

// --- model selection --------------------------------------------------------

/**
 * The active models, plus what the configured server says it can actually serve.
 *
 * The probe is the point. Choosing a local preset in the dashboard installs nothing, so
 * without asking the server what it has, an admin selecting `qwen2.5:7b` on a machine
 * with no Ollama would see a saved, healthy-looking setting and discover the truth as a
 * 404 on somebody's first question. `listModels` never throws — an unreachable provider
 * is a state to report here, not a failed request.
 */
const modelSettings = async (probePresetId?: string) => {
  const db = getDb();
  const active = activeModels(db);

  /**
   * The probe follows the selection, not the saved configuration.
   *
   * Asking about the active provider and answering about the selected one is the bug
   * this parameter exists to prevent: the panel checked OpenAI's model list for
   * `qwen2.5:7b`, found it absent, and told an operator with Ollama correctly installed
   * to go and install it.
   *
   * A preset id rather than a URL, deliberately. The server fetches whatever address
   * this resolves to, and accepting an arbitrary one from the query string would make
   * a GET into a request forgery primitive. Saving a configuration can still point the
   * system anywhere — that is the feature — but it takes a deliberate PUT.
   */
  const preset = MODEL_PRESETS.find((candidate) => candidate.id === probePresetId);
  const baseUrl = preset?.baseUrl ?? active.baseUrl;

  return {
    active,
    availability: {
      probedBaseUrl: baseUrl,
      ...(await listModels(baseUrl, resolveApiKey(db))),
    },
  };
};

adminRoutes.get('/settings/models', requires('documents:manage'), async (c) =>
  c.json(await modelSettings(c.req.query('probe'))),
);

/**
 * Change the provider address and the two chat models.
 *
 * The embedding model is deliberately not settable here. It is pinned to the width of
 * the vector column, so changing it means rebuilding the index — an operation that
 * destroys and reindexes the corpus, which is a CLI action with a confirmation, not a
 * side effect of saving a form. The panel shows the current value and the commands.
 */
adminRoutes.put('/settings/models', requires('documents:manage'), async (c) => {
  const body = setModelsRequestSchema.parse(await jsonBody(c));
  const db = getDb();
  const userId = c.get('user').id;

  setSetting(db, SETTING_KEYS.modelBaseUrl, body.baseUrl, userId);
  setSetting(db, SETTING_KEYS.answerModel, body.answerModel, userId);
  setSetting(db, SETTING_KEYS.rerankModel, body.rerankModel, userId);

  return c.json(await modelSettings());
});

/** Drop the stored selection and go back to whatever `.env` specifies. */
adminRoutes.delete('/settings/models', requires('documents:manage'), async (c) => {
  clearModelSettings(getDb());
  return c.json(await modelSettings());
});

// --- MCP ---------------------------------------------------------------------

/**
 * Is the MCP server answering, and how.
 *
 * Unauthenticated on purpose. A 401 with `WWW-Authenticate` *is* the healthy response —
 * it is what starts a client's OAuth flow — so the probe needs no credential and cannot
 * be made to do anything on the caller's behalf.
 *
 * What it cannot tell you is whether `MCP_ALLOWED_HOSTS` is right. The rebinding guard
 * runs after the bearer check, so an anonymous request is refused with 401 under every
 * `Host`, including the one that was forgotten. That is why the response carries the host
 * list itself rather than a verdict about it.
 */
async function probeMcp(): Promise<{ status: McpReachability; detail: string | null }> {
  try {
    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      // Short, because this runs while an admin waits for a page. A server that has not
      // answered in three seconds is a fault worth reporting, not worth waiting out.
      signal: AbortSignal.timeout(3000),
    });

    if (response.status === 401 && response.headers.get('www-authenticate')) {
      return { status: 'authenticating', detail: null };
    }
    return {
      status: 'unexpected',
      detail: `The endpoint answered ${response.status} instead of the expected 401 challenge.`,
    };
  } catch (error) {
    // Never rethrown: an MCP server that is down is a state this page reports, not a
    // reason the dashboard fails to load.
    return {
      status: 'unreachable',
      detail: error instanceof Error ? error.message : 'The endpoint could not be reached.',
    };
  }
}

adminRoutes.get('/mcp', requires('documents:manage'), async (c) => {
  const { status, detail } = await probeMcp();
  const origin = config.apiUrl.replace(/\/+$/, '');

  return c.json(
    mcpInfoSchema.parse({
      url: config.mcpUrl,
      discovery: {
        protectedResource: `${origin}/.well-known/oauth-protected-resource`,
        authorizationServer: `${origin}/.well-known/oauth-authorization-server`,
      },
      // The same function the MCP server enforces, not a second derivation of it. A
      // reported allowlist that has drifted from the enforced one is worse than none.
      allowedHosts: mcpHostAllowlist(),
      tool: {
        name: MCP_TOOL_NAME,
        queryMaxChars: searchRequestSchema.shape.query.maxLength ?? 500,
        limitMax: 20,
      },
      rateLimit: { max: config.rateLimitMax, windowSeconds: config.rateLimitWindowSeconds },
      status,
      statusDetail: detail,
    }),
  );
});

// --- user management --------------------------------------------------------

/**
 * Accounts: list, add, change role, deactivate.
 *
 * Gated on `users:manage`, which only `admin` holds — so a regular user reaching any of
 * these gets 403 before the handler runs, the same as every other route in this file.
 *
 * There is no route that returns a password, and no route that accepts a role on a
 * *creation* path from anywhere but this admin surface. Better Auth's `input: false` on
 * the role field means a self-registered role is impossible even if sign-up reopened;
 * these routes are the only way a role changes at runtime.
 */

const usersResponseSchema = paginated(adminUserSchema);

adminRoutes.get('/users', requires('users:manage'), (c) => {
  const query = listUsersQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams.entries()),
  );

  const { items, total } = listUsers(getDb(), c.get('user').id, {
    limit: query.limit,
    offset: query.offset,
    ...(query.q ? { q: query.q } : {}),
  });

  return c.json(
    usersResponseSchema.parse({ items, total, limit: query.limit, offset: query.offset }),
  );
});

/**
 * Add an account.
 *
 * Called "add" rather than "invite" because there is no mail service here: the
 * administrator sets an initial password and passes it on themselves. Creation goes
 * through `upsertAccount`, which is the one path that hashes a password through Better
 * Auth — the same path `npm run seed` uses, and the only one with a test pinning its
 * hashing.
 *
 * 409 rather than 200 when the email is taken. `upsertAccount` would otherwise reset an
 * existing account's password, which is a very different operation from adding someone
 * and must not happen by accident from a "create" form.
 */
adminRoutes.post('/users', requires('users:manage'), async (c) => {
  const body = createUserRequestSchema.parse(await jsonBody(c));
  const db = getDb();

  const existing = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(body.email);
  if (existing) {
    throw new HttpError('conflict', `An account already exists for ${body.email}.`);
  }

  await upsertAccount(db, {
    email: body.email,
    password: body.password,
    name: body.name,
    role: body.role,
  });

  const created = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(body.email) as
    { id: string } | undefined;
  if (!created) throw new HttpError('internal', 'The account could not be created.');

  const user = getUser(db, created.id, c.get('user').id);
  if (!user) throw new HttpError('internal', 'The account could not be read back.');

  return c.json(adminUserSchema.parse(user), 201);
});

/**
 * Change a role, deactivate, or reactivate.
 *
 * PUT rather than PATCH: the API's CORS allow-list does not include PATCH and the
 * browser client's method union does not either, so a PATCH would have failed at the
 * preflight rather than in the handler. Widening both to gain the more precise verb buys
 * nothing here — the body is already a partial update either way.
 *
 * The two refusals that matter live in core, not here: an administrator cannot change
 * their own account, and the last active administrator cannot be demoted or disabled.
 * Both are enforced in the same place the write happens rather than in the UI, because a
 * disabled button is a courtesy and this is a lockout.
 */
adminRoutes.put('/users/:id', requires('users:manage'), async (c) => {
  const body = updateUserRequestSchema.parse(await jsonBody(c));

  const user = updateUser(getDb(), c.req.param('id'), c.get('user').id, {
    ...(body.role !== undefined ? { role: body.role } : {}),
    ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
  });

  return c.json(adminUserSchema.parse(user));
});
