import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { openDb } from '../db/client.ts';
import { listDocuments, listIngestionRuns } from '../db/repository.ts';
import { ingest, type Embedder } from './pipeline.ts';

/**
 * End-to-end ingestion against the real sample corpus.
 *
 * The embedder is stubbed — deterministically, derived from a hash of the text —
 * so the whole pipeline runs without a network call or an API key. Everything
 * except the HTTP request to OpenAI is genuinely exercised: scanning, hash
 * diffing, chunking, transactional writes, pruning and the run ledger.
 *
 * The idempotency assertions are the important ones. "Repeatable" is a stated
 * requirement, and a re-ingest that silently re-embeds every document would still
 * look correct from the outside while costing money and time on every run.
 */

/** Deterministic pseudo-embedding: same text always yields the same vector. */
const stubEmbedder: Embedder = async (texts) =>
  texts.map((text) => {
    const seed = createHash('sha256').update(text).digest();
    return Array.from({ length: config.embeddingDimensions }, (_, i) => {
      const byte = seed[i % seed.length] ?? 0;
      return (byte / 255) * 2 - 1;
    });
  });

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-ingest-'));
  const db = openDb(path.join(dir, 'test.db'));
  return {
    db,
    [Symbol.dispose]() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A throwaway copy of the corpus, so tests that delete files leave the real one alone. */
function tempCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-corpus-'));
  fs.cpSync(config.corpusPath, dir, { recursive: true });
  return {
    path: dir,
    [Symbol.dispose]() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const run = (db: ReturnType<typeof openDb>, corpusPath: string, force = false) =>
  ingest(db, { trigger: 'cli', corpusPath, embedder: stubEmbedder, force });

test('indexes the whole sample corpus', async () => {
  using ctx = tempDb();
  const result = await run(ctx.db, config.corpusPath);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.docsFailed, 0, 'no document should fail to index');
  assert.equal(result.docsIndexed, result.docsTotal, 'every document indexed on a cold run');
  assert.ok(result.docsTotal > 100, `expected the full corpus, got ${result.docsTotal}`);

  const chunks = ctx.db.prepare('SELECT count(*) n FROM chunks').get() as { n: number };
  const vectors = ctx.db.prepare('SELECT count(*) n FROM chunks_vec').get() as { n: number };
  assert.ok(chunks.n >= result.docsTotal, 'at least one chunk per document');
  assert.equal(vectors.n, chunks.n, 'every chunk has exactly one vector');
});

test('re-running skips everything — ingestion is repeatable and cheap', async () => {
  using ctx = tempDb();
  await run(ctx.db, config.corpusPath);

  let embedCalls = 0;
  const countingEmbedder: Embedder = async (texts) => {
    embedCalls += texts.length;
    return stubEmbedder(texts);
  };

  const second = await ingest(ctx.db, {
    trigger: 'cli',
    corpusPath: config.corpusPath,
    embedder: countingEmbedder,
  });

  assert.equal(second.docsSkipped, second.docsTotal, 'unchanged content is skipped wholesale');
  assert.equal(second.docsIndexed, 0);
  assert.equal(second.docsUpdated, 0);
  assert.equal(embedCalls, 0, 're-ingest must not re-embed a single unchanged passage');
});

test('--force re-embeds despite unchanged hashes', async () => {
  using ctx = tempDb();
  const first = await run(ctx.db, config.corpusPath);

  const forced = await run(ctx.db, config.corpusPath, true);

  assert.equal(forced.docsSkipped, 0, 'force ignores the content hash');
  assert.equal(forced.docsUpdated, first.docsTotal, 'existing documents count as updates');
  assert.equal(forced.docsIndexed, 0);
});

test('a changed file is re-indexed and its stale passages replaced', async () => {
  using ctx = tempDb();
  using corpus = tempCorpus();
  await run(ctx.db, corpus.path);

  const target = path.join(corpus.path, 'build-pipeline.md');
  fs.writeFileSync(
    target,
    '# Build Pipeline\n\nThe pipeline now has five stages: bundle, ' +
      'compress, inline, verify, notarise.\n',
  );

  const second = await run(ctx.db, corpus.path);

  assert.equal(second.docsUpdated, 1, 'exactly the changed document is re-indexed');
  assert.equal(second.docsSkipped, second.docsTotal - 1);

  const hits = ctx.db
    .prepare("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'notarise'")
    .get() as { n: number };
  assert.equal(hits.n, 1, 'the new text is searchable');

  const stale = ctx.db
    .prepare("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'nondeterministic'")
    .get() as { n: number };
  assert.equal(stale.n, 0, 'the replaced text is gone from the index');
});

test('a file deleted from the corpus is pruned from all three stores', async () => {
  using ctx = tempDb();
  using corpus = tempCorpus();
  const first = await run(ctx.db, corpus.path);

  // Track the document's own rows rather than asserting on vocabulary: terms in
  // this corpus repeat heavily across documents ("glyph" appears in 14 of them),
  // so a keyword-based check would pass or fail for the wrong reason.
  const doomed = ctx.db
    .prepare(
      `SELECT c.id FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE d.source_path = 'localization-guide.md'`,
    )
    .all() as Array<{ id: number }>;
  assert.ok(doomed.length > 0, 'fixture document was indexed to begin with');
  const doomedIds = doomed.map((row) => Number(row.id));

  fs.rmSync(path.join(corpus.path, 'localization-guide.md'));
  const second = await run(ctx.db, corpus.path);

  assert.equal(second.docsDeleted, 1);
  assert.equal(second.docsTotal, first.docsTotal - 1);

  const placeholders = doomedIds.map(() => '?').join(',');
  const remaining = (table: string) =>
    Number(
      (
        ctx.db
          .prepare(`SELECT count(*) n FROM ${table} WHERE rowid IN (${placeholders})`)
          .get(...doomedIds) as { n: number }
      ).n,
    );

  assert.equal(remaining('chunks'), 0, 'passages removed');
  assert.equal(remaining('chunks_vec'), 0, 'vectors removed');
  assert.equal(remaining('chunks_fts'), 0, 'keyword postings removed');

  const vectors = ctx.db.prepare('SELECT count(*) n FROM chunks_vec').get() as { n: number };
  const chunks = ctx.db.prepare('SELECT count(*) n FROM chunks').get() as { n: number };
  assert.equal(vectors.n, chunks.n, 'vectors stay in step with chunks after a prune');
});

test('deprecation is detected in the right direction across the real SDK notes', async () => {
  using ctx = tempDb();
  await run(ctx.db, config.corpusPath);

  const documents = listDocuments(ctx.db);
  const v2 = documents.find((d) => d.sourcePath.endsWith('sdk-notes-v2.md'));
  const v3 = documents.find((d) => d.sourcePath.endsWith('sdk-notes-v3.md'));

  assert.ok(v2 && v3, 'both SDK documents are present');
  assert.equal(v2.isDeprecated, true);
  assert.equal(v2.supersededBy, 'Lumen SDK v3');
  assert.equal(v3.isDeprecated, false, 'the current document must not be flagged');

  // Exactly one document in the sample corpus declares itself deprecated. A
  // detector that started matching more is over-firing.
  assert.equal(documents.filter((d) => d.isDeprecated).length, 1);
});

test('categories are derived from the corpus directory layout', async () => {
  using ctx = tempDb();
  await run(ctx.db, config.corpusPath);

  const categories = new Set(listDocuments(ctx.db).map((d) => d.category));

  assert.ok(categories.has('delivery-reports'));
  assert.ok(categories.has('client-briefs'));
  assert.ok(categories.has('uncategorised'), 'root-level files fall back');
});

test('every run is recorded whether or not anything changed', async () => {
  using ctx = tempDb();
  await run(ctx.db, config.corpusPath);
  await run(ctx.db, config.corpusPath);

  const runs = listIngestionRuns(ctx.db);

  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'succeeded'));
  assert.ok(runs.every((r) => r.finishedAt !== null));
  assert.ok(runs.every((r) => r.durationMs !== null && r.durationMs >= 0));
  assert.ok(runs.every((r) => r.trigger === 'cli'));
});

test('an embedding failure marks the run failed rather than leaving it running', async () => {
  using ctx = tempDb();
  const failing: Embedder = async () => {
    throw new Error('provider unavailable');
  };

  await assert.rejects(
    ingest(ctx.db, { trigger: 'cli', corpusPath: config.corpusPath, embedder: failing }),
    /provider unavailable/,
  );

  const [latest] = listIngestionRuns(ctx.db);
  assert.equal(latest?.status, 'failed');
  assert.match(latest?.error ?? '', /provider unavailable/);
  assert.ok(latest?.finishedAt, 'a failed run is still closed out');
});
