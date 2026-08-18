import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GATED_ROUTES, PATHNAME_HEADER } from './pathname-header.ts';

/**
 * The proxy matcher against the routes it is supposed to cover.
 *
 * This is the regression test for a bug that produced no error: `app/(app)/layout.tsx`
 * gates every page under it and is not given a pathname, so it redirected signed-out
 * visitors to a hardcoded `/sign-in?next=/chat`. An admin following a link to the
 * dashboard signed in and arrived on the chat page. The proxy supplies the real path —
 * but only for the routes its matcher names, and a page added under `(app)/` inherits
 * the gate without inheriting the matcher. Nothing about that failure is loud: the sign
 * -in works, a page renders, it is simply the wrong one.
 *
 * `proxy.ts` itself is not imported here. It pulls in `next/server`, which resolves
 * under Next's bundler and not under plain Node, and the two lines it adds on top of
 * this module (read a pathname, set a header) are what `next build` already checks.
 * The part that can silently fall out of step is the list, so the list is checked twice:
 * against the directory it is supposed to cover, and against the copy of it that
 * `proxy.ts` is forced to restate because Next will not accept an imported matcher.
 */

const APP_DIR = path.join(import.meta.dirname, '..', 'app', '(app)');

/** Every route segment the gating layout wraps, read from disk rather than restated. */
const gatedDirectories = fs
  .readdirSync(APP_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  // Route groups `(x)` and private folders `_x` are not URL segments.
  .filter((entry) => !entry.name.startsWith('(') && !entry.name.startsWith('_'))
  .map((entry) => `/${entry.name}`);

test('every route behind the gating layout is stamped by the proxy', () => {
  assert.ok(gatedDirectories.length > 0, 'the (app) group has routes to check');

  for (const route of gatedDirectories) {
    assert.ok(
      GATED_ROUTES.includes(route as (typeof GATED_ROUTES)[number]),
      `${route} is gated by app/(app)/layout.tsx but is not in GATED_ROUTES, so a ` +
        'signed-out visitor asking for it would be sent to /chat instead',
    );
  }
});

/**
 * The matcher literal in `proxy.ts`, read as text.
 *
 * Parsing source is not something to reach for twice, but there is no import that would
 * do it: Next reads that file's `config` export statically, before module resolution, so
 * the literal cannot come from here and the duplication is forced. Reading it back is
 * what keeps the duplicate honest.
 */
function proxyMatcher(): string[] {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'proxy.ts'), 'utf8');
  const literal = /matcher:\s*\[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(literal, 'proxy.ts declares config.matcher as an array literal');
  return [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

test('the matcher in proxy.ts covers each gated route and everything below it', () => {
  // `:path*` matches zero segments, so this covers `/chat` as well as `/chat/anything`.
  assert.deepEqual(
    proxyMatcher(),
    GATED_ROUTES.map((route) => `${route}/:path*`),
    'proxy.ts restates GATED_ROUTES because Next rejects an imported matcher; the two ' +
      'have drifted, so a gated route is no longer stamped with the path it was asked for',
  );
});

test('the header name cannot be spoofed into looking like a standard one', () => {
  // Client-supplied headers reach the proxy, which overwrites this one unconditionally.
  // The prefix keeps it recognisably ours if it ever appears in a log or a proxy config.
  assert.match(PATHNAME_HEADER, /^x-hatko-/);
});
