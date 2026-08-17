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
  listDocumentsFiltered,
  listIngestionRuns,
  setSecret,
} from '@sorrel/core';
import { listDocumentsQuerySchema, triggerIngestionRequestSchema } from '@sorrel/shared';
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

adminRoutes.get('/documents', requires('documents:manage'), (c) => {
  const query = listDocumentsQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

  const { items, total } = listDocumentsFiltered(getDb(), {
    limit: query.limit,
    offset: query.offset,
    ...(query.status ? { status: query.status } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.q ? { q: query.q } : {}),
  });

  return c.json({ items, total, limit: query.limit, offset: query.offset });
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

const apiKeyBodySchema = z.object({
  // Length only. Validating the format against a vendor prefix would break the
  // moment the vendor changes it, and the real test is whether the provider
  // accepts it.
  apiKey: z.string().trim().min(20).max(400),
});

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
  const body = apiKeyBodySchema.parse(await jsonBody(c));
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
