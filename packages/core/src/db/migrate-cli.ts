import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { openDb } from './client.ts';

/**
 * `npm run db:migrate`, or `npm run db:reset` to drop the file and rebuild.
 *
 * This lives apart from migrate.ts because client.ts imports runMigrations from
 * it; putting an entrypoint in that module would close an import cycle and hang
 * on the top-level await.
 */

const reset = process.argv.includes('--reset');
const relative = path.relative(config.repoRoot, config.databasePath);

if (reset) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${config.databasePath}${suffix}`, { force: true });
  }
  console.log(`Removed ${relative}`);
}

// openDb applies any pending migrations as part of opening the connection.
const db = openDb(config.databasePath);
const applied = db
  .prepare('SELECT name, applied_at FROM _migrations ORDER BY name')
  .all() as Array<{
  name: string;
  applied_at: string;
}>;

console.log(`Database: ${relative}`);
for (const m of applied) console.log(`  ${m.name}  (applied ${m.applied_at})`);
console.log(`${applied.length} migration(s) in place.`);

db.close();
