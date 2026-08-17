import { betterAuth } from 'better-auth';
import { can, roleSchema, type Permission, type Role, type SessionUser } from '@sorrel/shared';
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
  });
}

let instance: ReturnType<typeof buildAuth> | undefined;

/**
 * The Better Auth instance, built on first use.
 *
 * Lazy because this module is re-exported from the `@sorrel/core` barrel, and at
 * module scope the construction above both opens the database and calls
 * `requireAppSecret()`. That made `import('@sorrel/core')` throw
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
  createdAt: Date | string;
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
  return toSessionUser(session.user as RawUser);
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

  if (!can(user.role, permission)) {
    throw new AuthorizationError(403, 'Your account does not have access to this.');
  }
  return user;
}

export type { Permission, Role, SessionUser };
