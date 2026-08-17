import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { documentCategorySchema } from '@sorrel/shared';
import { categoryOf, detectDeprecation, readDocument, scanCorpus, titleOf } from './corpus.ts';

test('category comes from the top-level directory', () => {
  assert.equal(categoryOf('guides/sdk-notes-v3.md'), 'guides');
  assert.equal(categoryOf('delivery-reports/2025-05-bubble-bakery.md'), 'delivery-reports');
  // A corpus organised differently must still ingest — nothing is enumerated.
  assert.equal(categoryOf('runbooks/oncall/escalation.md'), 'runbooks');
});

test('files at the corpus root fall back to uncategorised', () => {
  assert.equal(categoryOf('build-pipeline.md'), 'uncategorised');
});

/**
 * The write path is raw SQL and does not apply the schema, so a category the
 * schema would reject is writable and then permanently unreadable — it takes out
 * the admin list, the dashboard, the next ingest's diff, and search itself, all of
 * which parse a document row. Asserting against the schema rather than against the
 * number 64 so the two cannot drift apart.
 */
test('a directory name too long for the schema is clamped, not written whole', () => {
  const category = categoryOf(`${'a'.repeat(200)}/doc.md`);

  assert.doesNotThrow(
    () => documentCategorySchema.parse(category),
    'every category this produces must survive the round trip back out of the database',
  );
  assert.ok(category.startsWith('aaa'), 'the surviving prefix still identifies the directory');
});

// --- scanCorpus --------------------------------------------------------------

const corpusFixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-scan-'));
  fs.mkdirSync(path.join(root, 'corpus', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(root, 'corpus', 'guides', 'real.md'), '# Real\n\nbody');
  return root;
};

/**
 * Following symlinks is how a file outside CORPUS_PATH reaches the index. It is
 * the same defect as the tooling `CLAUDE.md` that got ingested, arriving by a
 * route the ignore list cannot see: the offending path is not in the corpus at all.
 */
test('a symlink out of the corpus does not pull foreign documents into it', (t) => {
  const root = corpusFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'private'));
  fs.writeFileSync(path.join(root, 'private', 'salaries.md'), '# Salaries\n\n500k');
  fs.symlinkSync(path.join(root, 'private'), path.join(root, 'corpus', 'linked'), 'dir');

  const { files, ignored } = scanCorpus(path.join(root, 'corpus'));

  assert.deepEqual(files, ['guides/real.md'], 'nothing outside the corpus root is a document');
  assert.ok(
    ignored.some((entry) => entry.startsWith('linked')),
    'and the skip is reported rather than silent',
  );
});

/**
 * The exclusion list is returned so the pipeline can name what it skipped — an
 * exclusion nobody can see is indistinguishable from a document that failed to
 * index. Not descending into an excluded directory made its contents invisible
 * rather than merely unindexed; naming the directory once keeps it visible without
 * `node_modules` producing thousands of lines.
 */
test('an excluded directory is named once, not enumerated and not silent', (t) => {
  const root = corpusFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');

  fs.mkdirSync(path.join(corpus, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(corpus, '.obsidian'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(corpus, 'node_modules', 'dep', `d${i}.md`), '# Dep\n\nvendored');
  }
  fs.writeFileSync(path.join(corpus, '.obsidian', 'workspace.md'), '# Tooling\n\nstate');

  const { files, ignored } = scanCorpus(corpus);

  assert.deepEqual(files, ['guides/real.md']);
  assert.deepEqual(ignored, ['.obsidian/', 'node_modules/'], 'one entry each, not six');
});

test('a symlink that could not have been content is skipped quietly', (t) => {
  const root = corpusFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');

  fs.writeFileSync(path.join(corpus, 'logo.png'), 'binary');
  fs.symlinkSync(path.join(corpus, 'logo.png'), path.join(corpus, 'alias.png'));

  // An ordinary .png is skipped without comment, so a link to one should be too.
  assert.deepEqual(scanCorpus(corpus).ignored, []);
});

test('a symlink loop does not multiply one document into many', (t) => {
  const root = corpusFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.symlinkSync(path.join(root, 'corpus'), path.join(root, 'corpus', 'loop'), 'dir');

  const { files } = scanCorpus(path.join(root, 'corpus'));

  // Following the loop returned the same file sixteen times, under sixteen paths,
  // each of which would be embedded and stored as a separate document.
  assert.deepEqual(files, ['guides/real.md']);
});

test('title comes from the first level-1 heading', () => {
  assert.equal(
    titleOf(
      'delivery-reports/2025-05-bubble-bakery.md',
      '# Delivery Report: Bubble Bakery, 2025-05\n\nClient: ...',
    ),
    'Delivery Report: Bubble Bakery, 2025-05',
  );
});

test('title falls back to a humanised filename when there is no heading', () => {
  assert.equal(
    titleOf('guides/asset-naming.md', 'Some body text with no heading.'),
    'Asset Naming',
  );
});

/**
 * A BOM sits before the first `#`, so the heading regex misses it and the document
 * loses its title to the filename fallback and its level-1 heading to the chunker.
 * Read through `readDocument` rather than by calling `titleOf` directly, because
 * the strip happens at the decode and this is the boundary that has to hold.
 */
test('a byte-order mark does not cost a document its title', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-bom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'notes.md'), '﻿# Release Notes\n\nbody');

  const document = readDocument(dir, 'notes.md');

  assert.equal(document.title, 'Release Notes', 'not the filename-derived "Notes"');
  assert.ok(document.body.startsWith('# '), 'the heading is a heading to the chunker too');
  // The hash is over the raw bytes, so adding a BOM is still a change to the file.
  assert.notEqual(
    document.contentHash,
    readDocument(
      (() => {
        fs.writeFileSync(path.join(dir, 'plain.md'), '# Release Notes\n\nbody');
        return dir;
      })(),
      'plain.md',
    ).contentHash,
  );
});

/**
 * The direction of the supersede relationship is the whole point of this
 * detector, and getting it backwards is silent: it would mark the *current* SDK
 * document deprecated and leave the actually-deprecated one unflagged, which is
 * precisely the failure sample question 2 is built to catch.
 */
test('detects a document that declares itself deprecated', () => {
  // Verbatim from sample_dataset/corpus/sdk-notes-v2.md.
  const body =
    '# Lumen SDK v2 (DEPRECATED)\n\n' +
    'Status: deprecated since January 2026. Do not use for new playables. Kept for ' +
    'maintenance of legacy projects only. See "Lumen SDK v3" for current guidance.\n';

  const result = detectDeprecation('Lumen SDK v2 (DEPRECATED)', body);

  assert.equal(result.isDeprecated, true);
  assert.equal(result.supersededBy, 'Lumen SDK v3');
});

test('does NOT flag the current document that supersedes another', () => {
  // Verbatim from sample_dataset/corpus/sdk-notes-v3.md. This is the trap: the
  // active voice ("It supersedes v2") appears in the document that is current.
  const body =
    '# Lumen SDK v3 (current)\n\n' +
    'v3 is the current SDK for all new playables, mandatory since January 2026. ' +
    'It supersedes v2 and is not backward compatible.\n';

  const result = detectDeprecation('Lumen SDK v3 (current)', body);

  assert.equal(result.isDeprecated, false, 'the superseding document is not the deprecated one');
  assert.equal(result.supersededBy, null);
});

test('recognises the passive phrasing as well', () => {
  const result = detectDeprecation(
    'Old Build Guide',
    'Status: deprecated. This guide was superseded by the Lumen Build 4 Handbook.',
  );
  assert.equal(result.isDeprecated, true);
  assert.equal(result.supersededBy, 'the Lumen Build 4 Handbook');
});

test('a passing mention of deprecation deep in the body is not a status', () => {
  const body =
    '# Build Pipeline\n\n' +
    'The pipeline has four stages: bundle, compress, inline, verify.\n\n'.repeat(8) +
    'Note: the old --legacy flag is deprecated and will be removed.\n';

  assert.equal(
    detectDeprecation('Build Pipeline', body).isDeprecated,
    false,
    'only a status declaration near the top counts',
  );
});
