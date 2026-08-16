import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf, detectDeprecation, titleOf } from './corpus.ts';

test('category comes from the top-level directory', () => {
  assert.equal(categoryOf('guides/sdk-notes-v3.md'), 'guides');
  assert.equal(categoryOf('delivery-reports/2025-05-bubble-bakery.md'), 'delivery-reports');
  // A corpus organised differently must still ingest — nothing is enumerated.
  assert.equal(categoryOf('runbooks/oncall/escalation.md'), 'runbooks');
});

test('files at the corpus root fall back to uncategorised', () => {
  assert.equal(categoryOf('build-pipeline.md'), 'uncategorised');
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
