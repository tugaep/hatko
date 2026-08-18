/**
 * The request header `proxy.ts` stamps with the path being rendered.
 *
 * Its own module, importing nothing, because the two sides that need it run in different
 * places. Next's proxy documentation is explicit that a proxy "is meant to be invoked
 * separately of your render code and in optimized cases deployed to your CDN" and should
 * not rely on shared modules — and `lib/session.ts`, the natural home, imports
 * `next/headers` and `next/navigation`. Declaring the name in either the proxy or the
 * layout would drag that runtime's imports into the other's bundle; four lines with no
 * imports is what keeps one definition without doing that.
 */
export const PATHNAME_HEADER = 'x-hatko-pathname';

/**
 * The routes `app/(app)/layout.tsx` gates, and therefore the routes `proxy.ts` must
 * stamp the path onto.
 *
 * The matcher is the half of the fix that rots. A new page under `app/(app)/` inherits
 * the gate automatically and inherits the matcher not at all, so it silently returns to
 * the bug this whole mechanism exists to fix: asked for the new route, signed in, landed
 * on `/chat`. Declared here, it can be checked against the directory listing by a test.
 *
 * `proxy.ts` cannot import this. Next parses `export const config` statically, before any
 * module resolution, so an imported matcher is not a value it can see and the build fails
 * with "matcher needs to be a static string". The literal is therefore restated there and
 * `pathname-header.test.ts` reads it back off disk and compares it to this list.
 */
export const GATED_ROUTES = ['/chat', '/dashboard'] as const;
