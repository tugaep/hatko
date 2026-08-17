import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { documentSortSchema, listDocumentsQuerySchema, type DocumentSort } from '@hatko/shared';
import { openDb } from './client.ts';
import { listDocumentsFiltered } from './repository.ts';

/**
 * Sorting a listing looks like presentation and is not.
 *
 * `ORDER BY` cannot be parameterised, so the column has to be interpolated into the
 * statement text — which makes the boundary between "key the client sent" and "column the
 * query names" the only thing standing between a dropdown and arbitrary SQL. These tests
 * pin that boundary, plus the two ordering properties that fail silently: unstable paging
 * across ties, and nulls sorting to the top.
 */

function tempDb() {
  // `openDb` applies migrations on the way in, so this is a full schema.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-listing-'));
  const db = openDb(path.join(dir, 'test.db'));
  return {
    db,
    [Symbol.dispose]() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface Seed {
  sourcePath: string;
  title: string;
  category: string;
  chunkCount: number;
  byteSize: number;
  indexedAt: string | null;
}

function seed(db: ReturnType<typeof openDb>, rows: Seed[]) {
  const insert = db.prepare(
    `INSERT INTO documents
       (source_path, title, category, content_hash, byte_size, status, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, ?, 'indexed', ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.sourcePath,
      row.title,
      row.category,
      `hash-${row.sourcePath}`,
      row.byteSize,
      row.chunkCount,
      row.indexedAt,
    );
  }
}

/** Three tied on chunk_count, deliberately inserted out of path order. */
const CORPUS: Seed[] = [
  {
    sourcePath: 'guides/zulu.md',
    title: 'Zulu',
    category: 'guides',
    chunkCount: 1,
    byteSize: 900,
    indexedAt: '2026-08-01T00:00:00Z',
  },
  {
    sourcePath: 'guides/alpha.md',
    title: 'Alpha',
    category: 'guides',
    chunkCount: 1,
    byteSize: 100,
    indexedAt: '2026-08-03T00:00:00Z',
  },
  {
    sourcePath: 'notes/mike.md',
    title: 'Mike',
    category: 'notes',
    chunkCount: 1,
    byteSize: 500,
    indexedAt: null,
  },
  {
    sourcePath: 'notes/bravo.md',
    title: 'Bravo',
    category: 'notes',
    chunkCount: 7,
    byteSize: 300,
    indexedAt: '2026-08-02T00:00:00Z',
  },
];

const page = (db: ReturnType<typeof openDb>, sort: DocumentSort, direction: 'asc' | 'desc') =>
  listDocumentsFiltered(db, { sort, direction, limit: 50, offset: 0 }).items.map(
    (doc) => doc.sourcePath,
  );

test('a sort key outside the enum is rejected at the boundary', () => {
  // The shapes an injection attempt takes, none of which reach the repository.
  for (const attempt of ['source_path; DROP TABLE documents', 'title--', 'rowid', '1', '']) {
    assert.equal(
      documentSortSchema.safeParse(attempt).success,
      false,
      `${JSON.stringify(attempt)} should not validate as a sort key`,
    );
  }

  // And the query schema supplies a safe default rather than passing the bad value on.
  const parsed = listDocumentsQuerySchema.safeParse({ sort: 'source_path; DROP TABLE documents' });
  assert.equal(parsed.success, false);
  assert.equal(listDocumentsQuerySchema.parse({}).sort, 'sourcePath');
  assert.equal(listDocumentsQuerySchema.parse({}).direction, 'asc');
});

test('every sortable key maps to a real column', () => {
  using fixture = tempDb();
  seed(fixture.db, CORPUS);

  // If a key in the shared enum had no column mapping, this is where it would throw.
  for (const sort of documentSortSchema.options) {
    for (const direction of ['asc', 'desc'] as const) {
      assert.equal(page(fixture.db, sort, direction).length, CORPUS.length, `${sort} ${direction}`);
    }
  }
});

test('sorting orders by the column asked for, in the direction asked for', () => {
  using fixture = tempDb();
  seed(fixture.db, CORPUS);

  assert.deepEqual(page(fixture.db, 'title', 'asc'), [
    'guides/alpha.md',
    'notes/bravo.md',
    'notes/mike.md',
    'guides/zulu.md',
  ]);
  assert.deepEqual(page(fixture.db, 'byteSize', 'desc'), [
    'guides/zulu.md',
    'notes/mike.md',
    'notes/bravo.md',
    'guides/alpha.md',
  ]);
});

test('ties break on source path, so paging cannot drop or duplicate a row', () => {
  using fixture = tempDb();
  seed(fixture.db, CORPUS);

  // Three documents share chunk_count = 1. Without a tiebreaker SQLite may return them in
  // a different order for each page, which loses rows across the boundary.
  const first = listDocumentsFiltered(fixture.db, {
    sort: 'chunkCount',
    direction: 'asc',
    limit: 2,
    offset: 0,
  }).items.map((doc) => doc.sourcePath);
  const second = listDocumentsFiltered(fixture.db, {
    sort: 'chunkCount',
    direction: 'asc',
    limit: 2,
    offset: 2,
  }).items.map((doc) => doc.sourcePath);

  assert.deepEqual([...first, ...second].sort(), CORPUS.map((row) => row.sourcePath).sort());
  assert.equal(new Set([...first, ...second]).size, CORPUS.length, 'no row appears twice');
});

test('a never-indexed document sorts last in both directions', () => {
  using fixture = tempDb();
  seed(fixture.db, CORPUS);

  // "never indexed" is not "indexed at the beginning of time". SQLite sorts NULL first
  // ascending, which would put a failed document above everything the reader asked for.
  assert.equal(page(fixture.db, 'indexedAt', 'asc').at(-1), 'notes/mike.md');
  assert.equal(page(fixture.db, 'indexedAt', 'desc').at(-1), 'notes/mike.md');
});

test('sorting composes with filtering rather than replacing it', () => {
  using fixture = tempDb();
  seed(fixture.db, CORPUS);

  const result = listDocumentsFiltered(fixture.db, {
    category: 'guides',
    sort: 'title',
    direction: 'desc',
    limit: 50,
    offset: 0,
  });

  assert.equal(result.total, 2, 'total counts the filtered set, not the whole corpus');
  assert.deepEqual(
    result.items.map((doc) => doc.title),
    ['Zulu', 'Alpha'],
  );
});
