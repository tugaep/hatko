import { serve } from '@hono/node-server';
import { closeDb, config, getDb } from '@hatko/core';
import { createApp } from './app.ts';

/**
 * `npm run dev:mcp` — start the MCP server.
 *
 * A separate process on its own port, not a route on the HTTP API. The two have
 * different callers (a browser on one, an MCP client on the other), different
 * protocols, and different reasons to be restarted, so coupling their lifecycles
 * would mean an MCP change can take the web app down. They share everything that
 * matters — the database, the retriever, the permission model — through
 * `@hatko/core`, which is the part worth sharing.
 */

const chunks = (getDb().prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n;

const server = serve({ fetch: createApp().fetch, port: config.mcpPort }, (info) => {
  console.log(`Hatko MCP on http://localhost:${info.port}/mcp`);
  console.log(`  corpus     ${Number(chunks)} passages indexed`);
  console.log(`  auth       OAuth 2.1 / OIDC, or Authorization: Bearer <session token>`);
  console.log(`  clients    point them at this URL; see docs/mcp.md`);
  if (Number(chunks) === 0) {
    console.log('\n  The index is empty. Run `npm run ingest` before connecting a client.');
  }
});

/** Same reason as the API: checkpoint the WAL instead of leaving sidecars behind. */
function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
