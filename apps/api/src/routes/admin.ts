import { Hono } from 'hono';
import {
  SETTING_KEYS,
  clearSecret,
  getApiKeyStatus,
  getChunksForDocument,
  getDashboardStats,
  getDb,
  getDocumentById,
  ingest,
  getUser,
  listDocumentsFiltered,
  listIngestionRuns,
  listUsers,
  setSecret,
  updateUser,
  upsertAccount,
} from '@hatko/core';
import {
  adminUserSchema,
  createUserRequestSchema,
  documentSchema,
  listDocumentsQuerySchema,
  listUsersQuerySchema,
  paginated,
  setApiKeyRequestSchema,
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

  return c.json({ document, chunks: getChunksForDocument(db, id) });
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
