import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config.ts';
import { runMigrations } from './migrate.ts';

export type Db = DatabaseSync;

let singleton: Db | undefined;

/**
 * Open a database and prepare it for use: load sqlite-vec, apply pragmas, and
 * bring the schema up to date.
 *
 * `allowExtension` is required before `loadExtension` will run, and sqlite-vec is
 * what provides the vec0 virtual table the schema depends on — so a connection
 * without it cannot even apply migration 001.
 */
export function openDb(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath, { allowExtension: true });
  sqliteVec.load(db);
  // Re-lock extension loading once sqlite-vec is in. Nothing else should be able
  // to pull native code into this connection afterwards.
  db.enableLoadExtension(false);

  // WAL lets the API read while an ingest writes, instead of blocking on it.
  db.exec('PRAGMA journal_mode = WAL');
  // Off by default in SQLite, and the chunks -> documents cascade depends on it.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  runMigrations(db);
  return db;
}

/**
 * Process-wide connection. SQLite handles one writer at a time and node:sqlite is
 * synchronous, so a single connection is both sufficient and the simplest thing
 * that cannot deadlock against itself.
 */
export function getDb(): Db {
  singleton ??= openDb(config.databasePath);
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = undefined;
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * node:sqlite has no transaction helper of its own, and ingestion needs one:
 * a document's rows must land in chunks, chunks_fts and chunks_vec together or
 * not at all, or retrieval starts returning passages whose vectors are missing.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Serialise an embedding for a vec0 `float[N]` column. */
export function toVectorBlob(embedding: readonly number[]): Uint8Array {
  if (embedding.length !== config.embeddingDimensions) {
    throw new Error(
      `Embedding has ${embedding.length} dimensions, expected ${config.embeddingDimensions}. ` +
        `EMBEDDING_MODEL and the vector column width in migration 001 must agree.`,
    );
  }
  return new Uint8Array(Float32Array.from(embedding).buffer);
}
