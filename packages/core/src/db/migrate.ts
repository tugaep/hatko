import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * Forward-only migrations, applied in filename order and recorded so they run once.
 *
 * There is no down-migration path. For a corpus that can be rebuilt from files on
 * disk in a few seconds, `npm run db:reset && npm run ingest` is a faster and more
 * trustworthy recovery than a hand-written rollback that is never exercised.
 */
export function runMigrations(db: DatabaseSync): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((row) => row.name as string),
  );

  const pending = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));

  const record = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      record.run(name);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  return pending;
}
