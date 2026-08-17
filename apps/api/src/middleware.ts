import { requirePermission, retrievalRateLimiter, type SessionUser } from '@hatko/core';
import type { Permission } from '@hatko/shared';
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

/**
 * Cap how often one account may reach a route that spends money at the model provider.
 *
 * Must be mounted *after* `requires`, and reads the user it put on the context rather
 * than resolving the session a second time. That ordering is the point: an anonymous
 * caller is refused by authorization before consuming anyone's allowance, so a flood of
 * unauthenticated requests cannot exhaust a real account's budget — which is what
 * limiting before authenticating would allow.
 *
 * Throws `RateLimitError`, which the app's error handler answers as 429 with
 * `Retry-After`. Counting happens here rather than inside the handler, so a refused
 * request never reaches the retriever.
 */
export function throttle(): MiddlewareHandler {
  return async (c, next) => {
    retrievalRateLimiter.check(c.get('user').id);
    await next();
  };
}
