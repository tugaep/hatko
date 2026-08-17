import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth, config, getDb, getSessionUser } from '@sorrel/core';
import { toErrorResponse, notFound } from './errors.ts';
import { searchRoutes } from './routes/search.ts';
import { adminRoutes } from './routes/admin.ts';

/**
 * The API.
 *
 * Built as an exported app rather than created inside the server entrypoint so the
 * whole surface can be exercised with `app.request()` in tests — no port, no
 * lifecycle, and every route tested through the same path a browser takes,
 * including the authorization middleware.
 */

export function createApp() {
  const app = new Hono();

  /**
   * The browser runs on a different origin, so it needs CORS — but only that one
   * origin, and with credentials enabled so the session cookie is sent. A
   * wildcard origin cannot be combined with credentials, and would in any case
   * invite any site to make authenticated requests on a signed-in user's behalf.
   */
  app.use(
    '*',
    cors({
      origin: config.webUrl,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['content-type'],
    }),
  );

  app.onError((error, c) => toErrorResponse(error, c));
  app.notFound((c) => toErrorResponse(notFound(`No route for ${c.req.method} ${c.req.path}.`), c));

  /** Unauthenticated on purpose: a health check that needs credentials is useless. */
  app.get('/health', (c) => {
    const chunks = getDb().prepare('SELECT count(*) n FROM chunks').get() as { n: number };
    return c.json({ status: 'ok', indexedChunks: Number(chunks.n) });
  });

  /**
   * Better Auth owns sign-in, sign-out and session endpoints under this prefix.
   * Its handler is a Web fetch handler and Hono speaks the same interface, so it
   * mounts directly with no adapter in between.
   */
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  /**
   * Who am I. Returns `{ user: null }` rather than 401 when signed out, because
   * "not signed in" is the answer to this question, not a failure to answer it —
   * the client uses it to decide what to render on first load.
   */
  app.get('/api/session', async (c) => c.json({ user: await getSessionUser(c.req.raw.headers) }));

  app.route('/api', searchRoutes);
  app.route('/api/admin', adminRoutes);

  return app;
}
