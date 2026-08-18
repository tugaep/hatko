import { NextResponse, type NextRequest } from 'next/server';
import { PATHNAME_HEADER } from './lib/pathname-header.ts';

/**
 * Publish the requested path to the server components that render it.
 *
 * `proxy.ts`, not `middleware.ts`: the middleware convention is deprecated in Next 16 and
 * renamed, with the same behaviour and a different export name.
 *
 * This exists to fix one bug. `app/(app)/layout.tsx` is the gate for every authenticated
 * page, and a layout is not given the pathname — so it redirected signed-out visitors to
 * `/sign-in?next=/chat` with a hardcoded destination. Because a layout resolves before the
 * page inside it, `dashboard/page.tsx` passing the correct `/dashboard` never got the
 * chance to run: an admin following a link to the dashboard signed in and landed on the
 * chat page instead. The whole `?next=` round trip — which `sign-in/page.tsx` validates
 * against open redirects and otherwise honours correctly — was inert for every route but
 * one.
 *
 * A request header rather than a cookie: it is per-request by construction, so two tabs
 * navigating at once cannot read each other's destination.
 *
 * Nothing here authorizes anything, and deliberately so. This code may run at a CDN edge
 * before the session can be verified against the database, and a gate there would be a
 * second authorization decision in a place that cannot make it properly. The checks stay
 * in `lib/session.ts` and, authoritatively, on the API.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Search params are dropped. The destination is a route, and `?next=` is validated as a
  // path — carrying a query through would widen what the sign-in page has to make safe.
  headers.set(PATHNAME_HEADER, request.nextUrl.pathname);

  return NextResponse.next({ request: { headers } });
}

/**
 * Only the routes whose layout needs the path. Matching everything would rewrite the
 * headers of every asset request in the app to serve two pages.
 *
 * Written out rather than imported from `GATED_ROUTES`, which is where it belongs and
 * where the directory-listing test checks it. Next reads this object statically, before
 * it resolves a single import, so an imported value fails the build outright. The copy is
 * held to the original by `lib/pathname-header.test.ts`, which reads this file.
 */
export const config = {
  matcher: ['/chat/:path*', '/dashboard/:path*'],
};
