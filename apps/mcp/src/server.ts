import { serve } from '@hono/node-server';
import { closeDb, config, getDb } from '@hatko/core';
import { allowedHosts, createApp } from './app.ts';

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

/**
 * A failure to listen, reported rather than thrown.
 *
 * `serve()` returns a Node server whose `error` event is unhandled by default, so an
 * occupied port exited through `throw er` in `node:events` with twenty lines of Node
 * internals and no mention of the port. Measured, not imagined — it is how this audit
 * started. §4 of the working agreement lists error handling as non-negotiable and every
 * other boundary in the system names its own fix, so this one should too.
 *
 * Exit code 1, because a service that cannot bind has not started and a supervisor or CI
 * step needs to know that.
 */
function reportListenFailure(error: NodeJS.ErrnoException, port: number, variable: string): never {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${port} is already in use, so the MCP server could not start.\n` +
        `Stop whatever is listening there, or set ${variable} in .env to a free port.`,
    );
  } else if (error.code === 'EACCES') {
    console.error(
      `\nNot permitted to listen on port ${port}.\n` +
        `Ports below 1024 need elevated privileges; set ${variable} in .env to a port above 1024.`,
    );
  } else {
    console.error(`\nthe MCP server could not listen on port ${port}: ${error.message}`);
  }
  process.exit(1);
}

const server = serve({ fetch: createApp().fetch, port: config.mcpPort }, (info) => {
  console.log(`hatko MCP on http://localhost:${info.port}/mcp`);
  console.log(`  corpus     ${Number(chunks)} passages indexed`);
  console.log(`  auth       OAuth 2.1 / OIDC, or Authorization: Bearer <session token>`);
  // Same allowance the HTTP API reports, charged to the same account — a client's tool
  // calls and a person's web searches spend from one budget.
  console.log(
    `  rate limit ${
      config.rateLimitMax > 0
        ? `${config.rateLimitMax} tool calls per ${config.rateLimitWindowSeconds}s per account`
        : 'DISABLED (RATE_LIMIT_MAX=0) — provider spend is unbounded'
    }`,
  );
  // Printed because it is the only place an operator can see it. Behind a reverse proxy
  // the public hostname has to be in MCP_ALLOWED_HOSTS or every authenticated client gets
  // a 403 — and an unauthenticated curl cannot reveal that, because the host guard runs
  // after the bearer check.
  console.log(`  hosts      ${allowedHosts.join(', ')}`);
  console.log(`  clients    point them at this URL; see docs/mcp.md`);
  if (Number(chunks) === 0) {
    console.log('\n  The index is empty. Run `npm run ingest` before connecting a client.');
  }
});

server.on('error', (error: NodeJS.ErrnoException) =>
  reportListenFailure(error, config.mcpPort, 'MCP_PORT'),
);

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
