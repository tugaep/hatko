import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, transaction, toVectorBlob } from './client.ts';
import { config } from '../config.ts';

/**
 * The schema's non-obvious part is that one logical delete has to reach three
 * physical stores. `chunks` cascades from `documents` via a foreign key, but
 * `chunks_fts` is an external-content FTS5 table and `chunks_vec` is a vec0
 * virtual table — neither participates in foreign keys, so both are unwound by
 * trigger instead. If those triggers regress, retrieval keeps returning passages
 * for documents that were removed from the corpus, and nothing else fails loudly.
 *
 * These tests are that alarm.
 */

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  return {
    db,
    [Symbol.dispose]() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const vector = (seed: number) =>
  toVectorBlob(Array.from({ length: config.embeddingDimensions }, (_, i) => Math.sin(seed + i)));

function seedDocument(db: ReturnType<typeof openDb>, sourcePath: string, passages: string[]) {
  return transaction(db, () => {
    const docId = Number(
      db
        .prepare(
          `INSERT INTO documents (source_path, title, category, content_hash, byte_size, status)
           VALUES (?, ?, 'guides', ?, ?, 'indexed') RETURNING id`,
        )
        .get(sourcePath, sourcePath, `hash-${sourcePath}`, 100)!.id,
    );

    passages.forEach((content, ordinal) => {
      const chunkId = Number(
        db
          .prepare(
            `INSERT INTO chunks (document_id, ordinal, heading, content, token_count)
             VALUES (?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(docId, ordinal, `Section ${ordinal}`, content, content.split(/\s+/).length)!.id,
      );
      db.prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)').run(
        BigInt(chunkId),
        vector(chunkId),
      );
    });

    return docId;
  });
}

const count = (db: ReturnType<typeof openDb>, sql: string, ...params: unknown[]) =>
  Number((db.prepare(sql).get(...(params as never[])) as { n: number }).n);

test('migrations apply cleanly and are idempotent', () => {
  using ctx = tempDb();
  const applied = ctx.db
    .prepare('SELECT name FROM _migrations ORDER BY name')
    .all()
    .map((r) => r.name);

  // Compared against the directory rather than a hardcoded list, so adding a
  // migration does not require editing this test — and so a migration that
  // silently fails to apply is still caught.
  const onDisk = fs
    .readdirSync(path.join(import.meta.dirname, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  assert.deepEqual(applied, onDisk);
  assert.ok(onDisk.length > 0, 'there is at least one migration to apply');

  // No two indexes on the same table and columns. Migration 003 added a second
  // index on search_queries(user_id) identical to migration 001's, so every write
  // maintained the same B-tree twice; migration 005 drops it. Checked as a rule
  // rather than by name so the next duplicate is caught too.
  const indexes = ctx.db
    .prepare(
      `SELECT tbl_name, sql FROM sqlite_master
        WHERE type = 'index' AND sql IS NOT NULL`,
    )
    .all() as Array<{ tbl_name: string; sql: string }>;

  const columnsOf = (sql: string) => /\(([^)]*)\)\s*$/.exec(sql)?.[1]?.replace(/\s+/g, ' ').trim();
  const seen = new Set<string>();
  for (const index of indexes) {
    const key = `${index.tbl_name}(${columnsOf(index.sql)})`;
    assert.ok(!seen.has(key), `duplicate index on ${key}`);
    seen.add(key);
  }

  // Re-opening the same file must not attempt to re-apply anything.
  assert.doesNotThrow(() => {
    const again = openDb(ctx.db.location()!);
    again.close();
  });
});

test('inserting a chunk populates the FTS index via trigger', () => {
  using ctx = tempDb();
  seedDocument(ctx.db, 'guides/build-pipeline.md', [
    'Sound assets are built in a separate pass because the encoder is single-threaded.',
  ]);

  const hits = ctx.db
    .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'sound AND assets'")
    .all();

  assert.equal(hits.length, 1, 'FTS row should exist without an explicit insert');
});

test('keyword arm matches the real corpus wording for sample question 3', () => {
  using ctx = tempDb();
  // Verbatim from sample_dataset/corpus/build-pipeline.md.
  seedDocument(ctx.db, 'guides/build-pipeline.md', [
    'Sound assets are built separately from the main bundle. Audio is encoded in a ' +
      'dedicated pass and injected at the inline stage, because compressing audio ' +
      'together with textures produced nondeterministic size spikes.',
  ]);

  // Sample question 3 asks "Why are sound assets built in a separate pass?" — note
  // "separate" against the document's "separately". Porter bridges that pair, which
  // is what lets the keyword arm surface this document. It matters because the
  // corpus contains 78 near-identical delivery reports that crowd out the correct
  // answer on vector similarity alone; the lexical arm is what rescues this query.
  const hits = ctx.db
    .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'sound AND separate AND pass'")
    .all();

  assert.equal(hits.length, 1, 'porter should conflate separate/separately');
});

test('porter does not stem irregular verbs — a known retrieval limitation', () => {
  using ctx = tempDb();
  seedDocument(ctx.db, 'guides/build-pipeline.md', ['Sound assets are built separately.']);

  const match = (q: string) =>
    ctx.db.prepare('SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?').all(q).length;

  assert.equal(match('built'), 1);
  // "building" -> "build", but "built" stays "built", so the two never meet. This is
  // asserted rather than merely noted so the limitation is visible instead of being
  // rediscovered as a retrieval bug. The vector arm is what covers this gap, which is
  // a concrete reason the retrieval is hybrid rather than keyword-only.
  assert.equal(match('building'), 0, 'irregular forms are not conflated by the porter stemmer');
});

test('vector search returns the nearest chunk', () => {
  using ctx = tempDb();
  seedDocument(ctx.db, 'guides/a.md', ['first passage', 'second passage', 'third passage']);

  const target = Number(
    (ctx.db.prepare('SELECT id FROM chunks WHERE ordinal = 1').get() as { id: number }).id,
  );
  const hits = ctx.db
    .prepare('SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 3')
    .all(vector(target)) as Array<{ rowid: number; distance: number }>;

  assert.equal(Number(hits[0]!.rowid), target);
  assert.ok(hits[0]!.distance < 1e-5, 'identical vector should have ~zero cosine distance');
});

test('deleting a document unwinds chunks, FTS rows and vectors together', () => {
  using ctx = tempDb();
  const docId = seedDocument(ctx.db, 'guides/doomed.md', [
    'Sound assets are built in a separate pass.',
    'The verify stage measures the final inlined artifact.',
  ]);
  // A second document must survive, or the assertions below would also pass
  // if the delete simply wiped every table.
  seedDocument(ctx.db, 'guides/survivor.md', ['Localization ships seven languages.']);

  assert.equal(count(ctx.db, 'SELECT count(*) n FROM chunks'), 3);
  assert.equal(count(ctx.db, 'SELECT count(*) n FROM chunks_vec'), 3);

  ctx.db.prepare('DELETE FROM documents WHERE id = ?').run(docId);

  assert.equal(count(ctx.db, 'SELECT count(*) n FROM chunks'), 1, 'FK cascade removed chunks');
  assert.equal(
    count(ctx.db, 'SELECT count(*) n FROM chunks_vec'),
    1,
    'trigger removed orphaned vectors',
  );
  assert.equal(
    count(ctx.db, "SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'sound'"),
    0,
    'trigger removed orphaned FTS postings',
  );
  assert.equal(
    count(ctx.db, "SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'localization'"),
    1,
    'the surviving document is still searchable',
  );
});

test('updating a chunk re-indexes it rather than leaving both versions', () => {
  using ctx = tempDb();
  seedDocument(ctx.db, 'guides/sdk.md', ['Initialize with lumen.start(config).']);

  ctx.db
    .prepare('UPDATE chunks SET content = ? WHERE ordinal = 0')
    .run('Initialize with LumenSDK.init(config).');

  assert.equal(
    count(ctx.db, "SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'lumensdk'"),
    1,
    'new text is searchable',
  );
  // Quoted: an unquoted dot is an FTS5 syntax error, not a literal.
  assert.equal(
    count(ctx.db, `SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH '"lumen.start"'`),
    0,
    'stale text is gone',
  );
});

test('a chunk cannot claim a position twice in the same document', () => {
  using ctx = tempDb();
  const docId = seedDocument(ctx.db, 'guides/a.md', ['only passage']);

  assert.throws(
    () =>
      ctx.db
        .prepare('INSERT INTO chunks (document_id, ordinal, content) VALUES (?, 0, ?)')
        .run(docId, 'duplicate ordinal'),
    /UNIQUE/i,
  );
});

test('source_path is unique so re-ingesting a file cannot fork its identity', () => {
  using ctx = tempDb();
  seedDocument(ctx.db, 'guides/a.md', ['passage']);

  assert.throws(() => seedDocument(ctx.db, 'guides/a.md', ['passage']), /UNIQUE/i);
});
