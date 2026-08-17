import { serve } from '@hono/node-server';
import { closeDb, config, getApiKeyStatus, getDb } from '@hatko/core';
import { createApp } from './app.ts';

/**
 * `npm run dev:api` — start the HTTP server.
 *
 * Reports the state of the two things that most often make a fresh install look
 * broken: an empty index and a missing API key. Both are recoverable and neither
 * should prevent the server from starting — an admin needs the server running in
 * order to set the key from the settings page.
 */

const db = getDb();
const chunks = (db.prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n;
const keyStatus = getApiKeyStatus(db);

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.apiPort }, (info) => {
  console.log(`Hatko API on http://localhost:${info.port}`);
  console.log(`  corpus     ${Number(chunks)} passages indexed`);
  console.log(
    `  model key  ${keyStatus.configured ? `${keyStatus.source} (${keyStatus.hint})` : 'not configured — set it in the admin settings page'}`,
  );
  // Printed because it is switchable, and a protection an operator believes is on when it
  // is off is worse than not having it. `RATE_LIMIT_MAX=0` says so here rather than only
  // in the file it was set in.
  console.log(
    `  rate limit ${
      config.rateLimitMax > 0
        ? `${config.rateLimitMax} search or answer requests per ${config.rateLimitWindowSeconds}s per account`
        : 'DISABLED (RATE_LIMIT_MAX=0) — provider spend is unbounded'
    }`,
  );
  if (Number(chunks) === 0) {
    console.log('\n  The index is empty. Run `npm run ingest`, or trigger it from the dashboard.');
  }
});

/**
 * SQLite holds a file handle and a WAL. Closing on shutdown checkpoints it,
 * rather than leaving -wal and -shm sidecars behind for the next start to recover.
 */
function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
