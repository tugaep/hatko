import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { can, sessionResponseSchema, type Permission, type SessionUser } from '@hatko/shared';
import { API_URL, parseResponse } from './api.ts';

/**
 * Who is asking, resolved on the server before a page renders.
 *
 * The API is the authority on authorization — every protected route there checks the
 * role from the verified session, and that check is what actually protects the data.
 * The gates here decide what a browser is sent, which is a separate job: without them
 * a regular user navigating to /dashboard would be handed the admin shell and watch
 * it fill with 403s. Server-side, so no admin markup is ever shipped to a client that
 * may not have it.
 *
 * Permissions come from the shared `PERMISSIONS` map, so the page gate and the route
 * guard cannot drift apart.
 */

/**
 * Forward the browser's cookies to the API.
 *
 * Better Auth's session cookie is httpOnly, so this process cannot inspect it — it
 * passes the header through and lets the API verify it. Sound while both run on
 * `localhost` (cookies ignore ports); split across domains, this becomes a shared
 * parent domain or a token exchange.
 */
async function forwardedCookies(): Promise<string> {
  return (await cookies()).toString();
}

export async function getSessionUser(): Promise<SessionUser | null> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/session`, {
      headers: { cookie: await forwardedCookies() },
      cache: 'no-store',
    });
  } catch {
    // The API being down is not "signed out". Callers that need a user redirect to
    // sign-in, where the failure is visible and retryable, rather than rendering a
    // shell full of broken panels.
    return null;
  }

  const { user } = await parseResponse(response, sessionResponseSchema);
  return user;
}

/** A signed-in user, or a redirect to sign-in that returns here afterwards. */
export async function requireUser(returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
  return user;
}

/**
 * A signed-in user holding `permission`.
 *
 * Lacking the permission redirects to /chat rather than rendering a 403 page: the
 * user has a working home in this application, and bouncing them to it is more useful
 * than a dead end. The nav never offers the link in the first place.
 *
 * `?denied=` carries the reason so the destination can say what happened. A silent
 * redirect is correct security and confusing product — the user typed a URL, something
 * moved them, and nothing told them why.
 */
export async function requirePermission(
  permission: Permission,
  returnTo: string,
): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (!can(user.role, permission)) redirect(`/chat?denied=${encodeURIComponent(permission)}`);
  return user;
}
