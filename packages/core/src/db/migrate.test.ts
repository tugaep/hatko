import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './client.ts';
import { runMigrations } from './migrate.ts';
import { config } from '../config.ts';

/**
 * The vector column's width is the one schema decision that fails silently.
 *
 * It is a literal in the vec0 declaration, it cannot be altered afterwards, and it
 * became configurable so a self-hosted 768-dimension model could be used in place of
 * OpenAI's 1536. A mismatch between the stored width and the configured one is not a
 * loud failure on the read path: the query embedding simply cannot be compared to what
 * is stored, and the vector arm returns nothing while the keyword arm carries on. The
 * system stays up and quietly gets worse, which is the failure mode worth a test.
 */

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-migrate-'));
  return {
    path: (name: string) => path.join(dir, name),
    [Symbol.dispose]() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The width vec0 actually recorded, read back from the stored DDL. */
function storedWidth(db: ReturnType<typeof openDb>): number {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
    .get() as { sql: string };
  return Number(/float\s*\[\s*(\d+)\s*\]/.exec(row.sql)![1]);
}

test('the vector column is created at the configured width, not a hard-coded one', () => {
  using dir = tempDir();
  const db = openDb(dir.path('fresh.db'));

  try {
    // Migration 001 carries a placeholder rather than 1536. If the substitution is ever
    // dropped, this reads 0 or NaN — `float[{{EMBEDDING_DIMENSIONS}}]` is not valid vec0
    // syntax, so the failure would in fact be loud — and the assertion still holds the
    // line that the width follows configuration.
    assert.equal(storedWidth(db), config.embeddingDimensions);
  } finally {
    db.close();
  }
});

test('a database whose vectors are a different width is refused, with the fix in the message', () => {
  using dir = tempDir();
  const file = dir.path('stale.db');

  const db = openDb(file);
  try {
    // Stand in for the real sequence — indexed with one embedding model, then reopened
    // after EMBEDDING_MODEL was pointed at another of a different width. Recreating the
    // table is the only way to reach that state, because vec0 has no ALTER for it.
    const other = config.embeddingDimensions === 768 ? 1536 : 768;
    db.exec('DROP TABLE chunks_vec');
    db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0 (embedding float[${other}] distance_metric=cosine)`,
    );

    assert.throws(
      () => runMigrations(db),
      (error: Error) => {
        assert.match(error.message, /db:reset/, 'says how to rebuild');
        assert.match(
          error.message,
          new RegExp(String(config.embeddingDimensions)),
          'names the configured width',
        );
        return true;
      },
    );
  } finally {
    db.close();
  }
});
