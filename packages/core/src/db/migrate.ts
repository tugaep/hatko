import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * The only value substituted into migration SQL, and it exists because vec0 column
 * widths are literals: `float[1536]` cannot be a bound parameter or altered later.
 *
 * Deliberately not a general template engine. One placeholder, one value, no
 * expressions — enough to let a self-hosted 768-dimension model create its own schema,
 * and not enough to turn .sql files into a language.
 */
const substitute = (sql: string) =>
  sql.replaceAll('{{EMBEDDING_DIMENSIONS}}', String(config.embeddingDimensions));

/**
 * Fail when the vector store's width disagrees with the configured one.
 *
 * This is the failure that would otherwise be silent. sqlite-vec rejects a wrongly
 * sized vector on insert, so an ingest against a re-pointed EMBEDDING_MODEL fails
 * loudly — but the query side is worse: an existing index full of 1536-wide vectors
 * with a 768-wide query embedding yields errors or nothing at all, per query, with
 * nothing to say the two were never comparable. Refusing to open the database says it
 * once, at the point the mistake was made.
 *
 * The width is read back from the stored DDL because vec0 does not report it through
 * PRAGMA table_info, which returns the column with no type.
 */
function assertVectorWidth(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
    .get() as { sql: string } | undefined;
  if (!row) return;

  const width = Number(/embedding\s+float\s*\[\s*(\d+)\s*\]/i.exec(row.sql)?.[1]);
  if (!Number.isInteger(width) || width === config.embeddingDimensions) return;

  throw new Error(
    `This database stores ${width}-dimension vectors but EMBEDDING_DIMENSIONS is ` +
      `${config.embeddingDimensions}. A vector column has one fixed width, and vectors from ` +
      'two embedding models are not comparable, so switching models means rebuilding:\n\n' +
      '  npm run db:reset && npm run ingest\n\n' +
      `To keep the existing index instead, set EMBEDDING_DIMENSIONS=${width} and point ` +
      'EMBEDDING_MODEL back at the model that produced it.',
  );
}

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
    const sql = substitute(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
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

  // After, not before: a fresh database has no chunks_vec to check until 001 has run,
  // and an existing one is checked on every open, which is the case that matters.
  assertVectorWidth(db);

  return pending;
}
