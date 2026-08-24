import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { mcp, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { can, roleSchema, type Permission, type Role, type SessionUser } from '@hatko/shared';
import { config, requireAppSecret } from '../config.ts';
import { getDb } from '../db/client.ts';
import { nodeSqliteDialect } from '../db/kysely-dialect.ts';

/**
 * Authentication and authorization.
 *
 * Better Auth owns credential handling — password hashing, session issuance and
 * verification, cookie flags. This module owns two things it does not: where the
 * role lives, and the rule that every protected operation resolves that role from
 * the session on the server.
 */

/** Sign-in page an unauthenticated OAuth authorize request is sent to. */
const MCP_LOGIN_PAGE = `${config.webUrl}/sign-in`;

/**
 * Written as a factory whose return type is inferred rather than annotated.
 * Annotating it `ReturnType<typeof betterAuth>` widens the options generic back to
 * `BetterAuthOptions` and loses `$context`, which `accounts.ts` needs for password
 * hashing.
 */
function buildAuth() {
  return betterAuth({
    database: { dialect: nodeSqliteDialect(getDb()), type: 'sqlite' },
    // Validated by the same gate that guards the settings encryption key, so the
    // `.env.example` placeholder cannot sign sessions. See config.ts.
    secret: requireAppSecret(),
    baseURL: config.apiUrl,
    // The browser app runs on a different origin from the API, so it must be named
    // explicitly; Better Auth rejects requests from origins not listed here.
    trustedOrigins: [config.webUrl],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // No verification mail in a local demo, and pretending otherwise would leave
      // seeded accounts unable to sign in.
      requireEmailVerification: false,
    },

    user: {
      additionalFields: {
        role: {
          type: 'string',
          defaultValue: 'user',
          /**
           * The security-critical line in this file. `input: false` means the role
           * is never read from request data, so a crafted sign-up or profile update
           * carrying `"role":"admin"` cannot grant it. Roles change only through a
           * deliberate server-side write — the seed script.
           */
          input: false,
        },

        /**
         * Deactivation, declared so Better Auth selects it with the session user —
         * otherwise `getSessionUser` could not see it and the check there would read
         * `undefined` for every account. `input: false` for the same reason as `role`:
         * nothing a client sends may change it.
         */
        disabled: {
          type: 'boolean',
          defaultValue: false,
          input: false,
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      // Cookies are readable only by the server and are not sent on cross-site
      // navigations, which is the baseline defence against session theft via XSS
      // and against CSRF on state-changing routes.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
      },
    },

    /**
     * Two ways for a non-browser client to authenticate, and exactly one place that
     * decides what it may then do — see `requireMcpPermission` below.
     */
    plugins: [
      /**
       * `Authorization: Bearer <session token>` as an alternative to the cookie.
       *
       * The simple path, and the one that keeps `curl` and CI usable: an MCP client
       * is not a browser, it has no cookie jar, and its config file holds headers.
       * The token is a real session, so it carries a real user, role, expiry and
       * revocation — signing out cuts the client off, which a static token in an env
       * var could never do.
       *
       * The plugin HMAC-verifies the token against `secret` before it becomes a
       * session, so an arbitrary bearer string is rejected rather than trusted. It
       * does not widen CSRF exposure: browsers do not attach `Authorization` headers
       * automatically, which is the whole reason cookies need SameSite.
       *
       * Its weakness, and why the OIDC flow below exists: the credential *is* the
       * user's session, so it cannot be scoped to one client or revoked without
       * ending every other session too.
       */
      bearer(),

      /**
       * OAuth 2.1 / OIDC authorization server, for MCP clients.
       *
       * hatko is its own provider rather than delegating to a hosted IdP, and that is
       * a constraint rather than a preference: the brief requires the system to run on
       * a fresh machine from the README, and an external identity provider would make
       * a network account a prerequisite for `npm install`.
       *
       * What this buys over the bearer path: an MCP client discovers the endpoints,
       * registers itself, and runs authorization-code + PKCE to get its own scoped,
       * revocable token — instead of being handed a copy of the user's session. The
       * bearer path stays for curl and CI. Both resolve to a role check through
       * `requireMcpPermission`, so there is still exactly one authorization decision.
       */
      mcp({
        /**
         * Where the authorize endpoint sends a caller who is not signed in. The web
         * app owns sign-in, so this is a path on WEB_URL, not on this API.
         *
         * Written twice — here and in `oidcConfig` — because the plugin's type
         * requires it in both, while its runtime applies this one *after* spreading
         * `oidcConfig` and so always wins. One constant feeds both rather than two
         * literals that could disagree about which sign-in page exists.
         */
        loginPage: MCP_LOGIN_PAGE,

        /**
         * The thing being protected. Defaults to this API's origin, which would be
         * wrong: clients must learn that the audience is the MCP endpoint, which is a
         * different process on a different port.
         */
        resource: config.mcpUrl,

        oidcConfig: {
          loginPage: MCP_LOGIN_PAGE,

          /**
           * MCP clients are not pre-registered — the spec has them register
           * themselves on first connection (RFC 7591). Without this, connecting a new
           * client would require an administrator to mint credentials by hand, which
           * is exactly the friction the MCP auth flow exists to remove.
           *
           * Registration only creates a client record. It grants nothing: no token
           * exists until a signed-in human approves the client on the consent screen,
           * and no query runs until that token also passes the role check.
           */
          allowDynamicClientRegistration: true,

          /**
           * Consent is rendered by the web app so it looks like the product and obeys
           * the design tokens. The alternative the library offers, `getConsentHTML`,
           * would mean an unstyled HTML string living in the API — a user-facing page
           * that matches nothing else the user has seen, at the exact moment we are
           * asking them to trust it.
           */
          consentPage: `${config.webUrl}/oauth/consent`,

          // Token lifetimes are left at the plugin's defaults — one hour for an access
          // token, seven days for a refresh token — which are the values this system
          // would have chosen anyway. Restating them here would read as a tightening
          // that had not happened.
        },
      }),
    ],
  });
}

let instance: ReturnType<typeof buildAuth> | undefined;

/**
 * The Better Auth instance, built on first use.
 *
 * Lazy because this module is re-exported from the `@hatko/core` barrel, and at
 * module scope the construction above both opens the database and calls
 * `requireAppSecret()`. That made `import('@hatko/core')` throw
 * "BETTER_AUTH_SECRET is not set to a real value" before any export was
 * reachable — so a consumer wanting only `hybridSearch` inherited a database
 * handle and a mandatory session secret. Step 7's MCP server is exactly that
 * consumer. Nothing else changes: the first call that needs auth still fails the
 * same way, with the same message.
 */
export function getAuth(): ReturnType<typeof buildAuth> {
  instance ??= buildAuth();
  return instance;
}

/** Better Auth's user record, before it is narrowed to the shared contract. */
interface RawUser {
  id: string;
  email: string;
  name: string;
  role?: unknown;
  disabled?: unknown;
  createdAt: Date | string;
}

/**
 * Whether an account has been deactivated by an administrator.
 *
 * Loose about the representation on purpose: this value arrives as an integer from raw
 * SQL, as a boolean through Better Auth's field mapping, and as `undefined` from any
 * row read before migration 008. Every one of those must resolve, and the only unsafe
 * mistake would be reading a disabled account as active — so anything that is not
 * recognisably falsy counts as disabled.
 */
function isDisabled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

/**
 * Narrow a Better Auth user onto the shared `SessionUser` contract.
 *
 * An unrecognised role degrades to `user` rather than throwing. A corrupt or
 * hand-edited row should cost that account its privileges, not lock every request
 * out of the application — and failing closed here is the safe direction.
 */
function toSessionUser(raw: RawUser): SessionUser {
  const parsed = roleSchema.safeParse(raw.role);
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name,
    role: parsed.success ? parsed.data : 'user',
    createdAt: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : String(raw.createdAt),
  };
}

/**
 * Resolve the signed-in user from request headers, or null.
 *
 * Headers are passed through to Better Auth, which verifies the session cookie
 * against the stored session. Nothing here trusts a client-supplied user id or
 * role — the only input is an opaque signed token.
 */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session?.user) return null;

  const raw = session.user as RawUser;

  /**
   * A deactivated account has no identity, even holding a valid session.
   *
   * This is the line that makes deactivation a revocation rather than a note. Checking
   * only at sign-in would leave every session and OAuth token issued beforehand
   * working — for up to seven days — which is not what an administrator pressing
   * "Disable" is asking for. Because both the web app and the MCP server resolve
   * identity through here, one check covers both surfaces.
   *
   * Returning null rather than throwing keeps it indistinguishable from being signed
   * out, which is also the honest description: there is no session to speak of.
   */
  if (isDisabled(raw.disabled)) return null;

  return toSessionUser(raw);
}

/** Thrown when a request lacks a session, or has one without the required role. */
export class AuthorizationError extends Error {
  readonly status: 401 | 403;
  readonly code: 'unauthorized' | 'forbidden';

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
    this.code = status === 401 ? 'unauthorized' : 'forbidden';
  }
}

/**
 * Require a signed-in user holding `permission`, returning them.
 *
 * The distinction between 401 and 403 is kept because it is the difference
 * between "sign in" and "your account cannot do this", and collapsing them makes
 * the UI unable to tell the user which.
 *
 * Permissions come from the shared PERMISSIONS map, so the server and the browser
 * cannot disagree about what a role may do — but this check is the one that
 * counts. The client copy only decides what to render.
 */
export async function requirePermission(
  headers: Headers,
  permission: Permission,
): Promise<SessionUser> {
  const user = await getSessionUser(headers);
  if (!user) throw new AuthorizationError(401, 'Sign in to continue.');

  return authorize(user, permission);
}

/**
 * The role check itself, once an identity is established.
 *
 * Split out so the OAuth path below cannot accidentally implement a second, kinder
 * version of it. Whichever credential a caller presents, the question "may this role
 * do this" is answered here and only here.
 */
function authorize(user: SessionUser, permission: Permission): SessionUser {
  if (!can(user.role, permission)) {
    throw new AuthorizationError(403, 'Your account does not have access to this.');
  }
  return user;
}

/**
 * Load a user by id, for credentials that identify a user without carrying a session.
 *
 * Read straight from the `user` table because that is where Better Auth keeps it and
 * this project has no ORM; the row goes through the same `toSessionUser` narrowing as
 * a session user, so an unrecognised role fails closed to `user` in both paths rather
 * than only one.
 */
function getUserById(id: string): SessionUser | null {
  const row = getDb()
    .prepare(
      'SELECT "id", "email", "name", "role", "disabled", "createdAt" FROM "user" WHERE "id" = ?',
    )
    .get(id) as RawUser | undefined;

  if (!row) return null;
  // The OAuth path does not go through `getSessionUser`, so the deactivation check has
  // to be repeated here or an MCP client would keep working after its owner was
  // disabled — the exact gap this column exists to close.
  if (isDisabled(row.disabled)) return null;

  return toSessionUser(row);
}

/**
 * Require `permission` from an MCP caller, accepting either supported credential.
 *
 * Two credentials, one decision. An OAuth access token issued through the OIDC flow
 * identifies a user but carries no session, so the user is loaded and graded here; a
 * Better Auth session token presented as a bearer resolves through the ordinary
 * `requirePermission`. Both end at `authorize`, which is the point — the alternative
 * is two role checks that drift, and the one that drifts is always the one nobody
 * looks at.
 *
 * OAuth is tried first because it is the specific case: an OAuth token is not a valid
 * session token, so `getSession` would reject it and the error would name the wrong
 * problem. Nothing here reads a role, a user id or a scope from the request body —
 * only an opaque credential that must match a stored row.
 */
export async function requireMcpPermission(
  headers: Headers,
  permission: Permission,
): Promise<SessionUser> {
  const token = await getAuth().api.getMcpSession({ headers });

  if (token?.userId) {
    const user = getUserById(token.userId);
    // A token whose user has since been deleted. The cascade in migration 007 should
    // have removed the token with them, so this is the belt to that braces — and it
    // fails closed rather than trusting the token's own claim about who it is.
    if (!user) throw new AuthorizationError(401, 'This authorization is no longer valid.');
    return authorize(user, permission);
  }

  return requirePermission(headers, permission);
}

/**
 * The two OAuth discovery documents, as plain fetch handlers.
 *
 * Exported from here rather than letting the API import `better-auth/plugins/mcp`
 * directly, because the API workspace does not depend on Better Auth and should not
 * start: every other auth concern reaches it through this module, and a route file
 * importing the auth library would be the first crack in that. `better-auth` is a
 * dependency of `@hatko/core` alone, and importing it from a workspace that does not
 * declare it would work only by hoisting.
 */
/**
 * Correct the two claims Better Auth's metadata makes on our behalf that are not true here.
 *
 * Both documents are generated assuming the asymmetric setup its JWT plugin provides:
 * they advertise `jwks_uri` and `RS256`. This system deliberately runs neither — migration
 * 007 records why, and it is the right call: access tokens are opaque and validated by a
 * database read this process already performs, which means a token can be revoked by
 * deleting a row where a self-contained JWT cannot. But the metadata was never brought in
 * line, so it pointed clients at `/api/auth/mcp/jwks`, which answers 404, and promised
 * RS256 while the issued `id_token` is in fact signed HS256. Verified against the running
 * server, not inferred.
 *
 * Discovery is a contract. A client that fetches the JWKS to validate an ID token — which
 * a strict OIDC client does — fails on a document we published. So `jwks_uri` is removed
 * rather than pointed somewhere: HS256 is symmetric, there is no public key to publish,
 * and omitting the field is how a provider says so. `id_token_signing_alg_values_supported`
 * becomes the algorithm actually in use. `resource_signing_alg_values_supported` describes
 * signed resource *responses*, which this server does not produce at all, so it goes too.
 *
 * The alternative was installing the JWT plugin to make the original claims true. That
 * would trade revocable tokens for a `jwks` table and a signing key to rotate, in order to
 * satisfy a document nothing in the MCP flow reads — the wrong direction.
 */
async function withCorrectedSigningMetadata(
  response: Response,
  corrections: Record<string, unknown>,
): Promise<Response> {
  // A non-JSON or failed response is the library reporting a problem; forward it untouched
  // rather than trying to edit it.
  if (!response.ok) return response;

  let document: Record<string, unknown>;
  try {
    document = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    return response;
  }

  for (const [key, value] of Object.entries(corrections)) {
    if (value === undefined) delete document[key];
    else document[key] = value;
  }

  // Headers are carried over so CORS and cache directives the plugin sets survive.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(document), { status: response.status, headers });
}

export const oauthProtectedResourceMetadata = async (request: Request): Promise<Response> =>
  withCorrectedSigningMetadata(await oAuthProtectedResourceMetadata(getAuth())(request), {
    jwks_uri: undefined,
    resource_signing_alg_values_supported: undefined,
  });

export const oauthAuthorizationServerMetadata = async (request: Request): Promise<Response> =>
  withCorrectedSigningMetadata(await oAuthDiscoveryMetadata(getAuth())(request), {
    jwks_uri: undefined,
    id_token_signing_alg_values_supported: ['HS256'],
  });

export type { Permission, Role, SessionUser };
