import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config, getAuth, getDb, getSessionUser } from '@sorrel/core';
import { sessionResponseSchema } from '@sorrel/shared';
import { HttpError, toErrorResponse, notFound } from './errors.ts';
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
   * Sign-up is closed, and this must be registered before the Better Auth mount
   * below so it runs first.
   *
   * The corpus is internal. A login anyone may create an account for is not access
   * control, it is a doorbell — and the audit confirmed the consequence: a stranger
   * could register and read all 142 documents. Accounts are created deliberately,
   * server-side, by `npm run seed`, for the same reason roles are.
   *
   * Blocked at the route rather than with Better Auth's `disableSignUp`, because
   * that flag would also disable `auth.api.signUpEmail` — the call the seed script
   * uses, and the one path whose password hashing is pinned by a test. Closing the
   * public door is the requirement; breaking the tested way in is not.
   */
  app.on(['GET', 'POST'], '/api/auth/sign-up/*', () => {
    throw new HttpError('forbidden', 'Sign-up is closed. Ask an administrator for an account.');
  });

  /**
   * Better Auth owns sign-in, sign-out and session endpoints under this prefix.
   * Its handler is a Web fetch handler and Hono speaks the same interface, so it
   * mounts directly with no adapter in between.
   */
  app.on(['GET', 'POST'], '/api/auth/*', (c) => getAuth().handler(c.req.raw));

  /**
   * Who am I. Returns `{ user: null }` rather than 401 when signed out, because
   * "not signed in" is the answer to this question, not a failure to answer it —
   * the client uses it to decide what to render on first load.
   */
  app.get('/api/session', async (c) =>
    c.json(sessionResponseSchema.parse({ user: await getSessionUser(c.req.raw.headers) })),
  );

  app.route('/api', searchRoutes);
  app.route('/api/admin', adminRoutes);

  return app;
}
