import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  config,
  getAuth,
  getDb,
  getSessionUser,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
} from '@hatko/core';
import { healthSchema, oauthClientSchema, sessionResponseSchema } from '@hatko/shared';
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
    return c.json(healthSchema.parse({ status: 'ok', indexedChunks: Number(chunks.n) }));
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
   * Refuse sign-in for a deactivated account, and say why.
   *
   * Not a security control — `getSessionUser` already refuses a disabled account, so a
   * session issued here would be inert. It is an error-handling one. Without it,
   * sign-in answered 200, set a cookie, and then every request behaved as signed out:
   * a loop with no explanation anywhere in it, which reads as a broken application
   * rather than a closed account.
   *
   * The email is read only to look up the account. It is not trusted for anything else,
   * and the password is never inspected here — Better Auth still performs the actual
   * authentication on the forwarded request, so this cannot become a way to probe
   * credentials. It does confirm that an address belongs to a deactivated account,
   * which is a deliberate trade: the alternative is the silent loop above, and someone
   * who was told their account is deactivated can act on that.
   */
  app.post('/api/auth/sign-in/email', async (c) => {
    const body = await c.req.raw.clone().text();

    const email = ((): string | null => {
      try {
        const parsed: unknown = JSON.parse(body);
        const value = (parsed as { email?: unknown } | null)?.email;
        return typeof value === 'string' ? value : null;
      } catch {
        // Malformed JSON is Better Auth's to reject, with its own message.
        return null;
      }
    })();

    if (email) {
      const row = getDb().prepare('SELECT "disabled" FROM "user" WHERE "email" = ?').get(email) as
        { disabled: number } | undefined;

      if (row && row.disabled !== 0) {
        throw new HttpError(
          'forbidden',
          'This account has been deactivated. Ask an administrator to restore it.',
        );
      }
    }

    // Forwarded with the body already read, since a Request body can only be consumed
    // once and Better Auth needs it intact.
    return getAuth().handler(
      new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body }),
    );
  });

  /**
   * Force a consent screen on every OAuth authorization, and register this before the
   * Better Auth mount below so it runs first.
   *
   * Measured, not assumed: the mcp plugin's authorize endpoint decides consent with
   * `requireConsent: query.prompt === "consent"`, so by default it issues an
   * authorization code and redirects without asking anyone anything. Combined with
   * open dynamic client registration — which the MCP flow requires — that is a real
   * hole rather than a theoretical one. Anybody can register a client, and a signed-in
   * user who follows one crafted link then silently hands that client a token good for
   * reading the whole corpus. PKCE and `state` do not help here: they protect the
   * client from token interception, not the user from authorizing a stranger.
   *
   * Rewriting the query is what closes it for *every* caller. Advertising a different
   * `authorization_endpoint` in the discovery document would only redirect
   * well-behaved clients, while the consent-free endpoint stayed mounted and reachable
   * by exactly the crafted link this is meant to stop.
   *
   * The cost is that a client is re-asked on each new authorization rather than only
   * the first, because that endpoint treats `prompt=consent` as "always ask". Refresh
   * tokens mean this is rare in practice, and for an internal corpus being asked twice
   * is the better failure.
   */
  app.get('/api/auth/mcp/authorize', (c) => {
    const url = new URL(c.req.url);
    url.searchParams.set('prompt', 'consent');
    return getAuth().handler(new Request(url, c.req.raw));
  });

  /**
   * Who is asking, for the consent screen.
   *
   * The authorize redirect carries only `client_id`, so without this the consent page
   * could show a user nothing but a 32-character random string and ask them to trust
   * it. A consent screen that cannot say *which application* is asking is decoration:
   * people approve what they cannot identify, and the control that was added to stop a
   * crafted link becomes a formality.
   *
   * Requires a session but no particular permission. A user whose role cannot search
   * still reaches this page — the page tells them so — and gating it on `search:run`
   * would replace that explanation with a bare failure.
   */
  app.get('/api/oauth/client/:clientId', async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) throw new HttpError('unauthorized', 'Sign in to continue.');

    const row = getDb()
      .prepare(
        `SELECT "clientId", "name", "redirectUrls" FROM "oauthApplication"
         WHERE "clientId" = ? AND "disabled" = 0`,
      )
      .get(c.req.param('clientId')) as
      { clientId: string; name: string; redirectUrls: string } | undefined;

    if (!row) throw notFound('No such application.');

    return c.json(
      oauthClientSchema.parse({
        clientId: row.clientId,
        name: row.name,
        // Stored as one comma-joined string by the library, not as JSON.
        redirectUris: row.redirectUrls.split(',').filter(Boolean),
      }),
    );
  });

  /**
   * OAuth 2.1 / OIDC discovery, for MCP clients.
   *
   * These live at the domain root rather than under `/api/auth`, because RFC 8414 and
   * RFC 9728 specify these exact paths and clients fetch them without being told
   * where to look — that is the whole point of discovery. The MCP server's 401 points
   * at `oauth-protected-resource`, which names this API as the authorization server,
   * and `oauth-authorization-server` then describes its endpoints.
   *
   * Both are unauthenticated by specification, and correctly so: they carry no user
   * data, only the addresses of endpoints that do their own checking. A client cannot
   * begin authenticating without them.
   */
  app.get('/.well-known/oauth-protected-resource', (c) =>
    oauthProtectedResourceMetadata(c.req.raw),
  );
  app.get('/.well-known/oauth-authorization-server', (c) =>
    oauthAuthorizationServerMetadata(c.req.raw),
  );

  /**
   * Better Auth owns sign-in, sign-out and session endpoints under this prefix, plus
   * the OAuth authorize, token, register and consent endpoints added by the mcp
   * plugin. Its handler is a Web fetch handler and Hono speaks the same interface, so
   * it mounts directly with no adapter in between.
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
