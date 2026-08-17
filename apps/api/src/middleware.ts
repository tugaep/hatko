import { requirePermission, type SessionUser } from '@sorrel/core';
import type { Permission } from '@sorrel/shared';
import type { MiddlewareHandler } from 'hono';

/**
 * Route-level authorization.
 *
 * Every protected route declares the permission it needs, and the check runs
 * server-side against the session before the handler is entered. There is no path
 * where a handler runs first and checks later, and no route that trusts a role
 * from a header or body — the only client input is an opaque signed cookie.
 */

declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser;
  }
}

/**
 * Require `permission`, and put the resolved user on the context.
 *
 * Throws AuthorizationError, which the app's error handler maps to 401 or 403.
 * Those stay distinct because the difference — "sign in" versus "your account
 * cannot do this" — is one the UI has to convey.
 */
export function requires(permission: Permission): MiddlewareHandler {
  return async (c, next) => {
    const user = await requirePermission(c.req.raw.headers, permission);
    c.set('user', user);
    await next();
  };
}
