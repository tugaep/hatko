import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogNumber,
  formatBytes,
  formatMs,
  highlightSegments,
  passageBody,
} from './format.ts';

/**
 * `highlightSegments` is the one piece of logic here that can fail without anyone
 * noticing: it takes user input into a regular expression and reassembles a passage from
 * the pieces. A bad escape throws mid-render, and a bad reassembly silently drops or
 * duplicates document text — which in a system whose whole promise is "here is the
 * passage" is a correctness bug, not a cosmetic one.
 */

const PASSAGE = 'Language is auto-detected from the device locale, with English as the fallback.';

test('highlighting never alters the passage it marks', () => {
  for (const query of ['language fallback', 'THE DEVICE', 'nothing matches here', '']) {
    const rebuilt = highlightSegments(PASSAGE, query)
      .map((segment) => segment.text)
      .join('');
    assert.equal(rebuilt, PASSAGE, `query ${JSON.stringify(query)} changed the passage`);
  }
});

test('regex metacharacters in a query are escaped, not executed', () => {
  // `C++ (v2)` is an invalid pattern unescaped — this used to throw while rendering.
  const segments = highlightSegments('Upgrade C++ (v2) builds now.', 'C++ (v2) builds');
  assert.equal(segments.map((s) => s.text).join(''), 'Upgrade C++ (v2) builds now.');
  assert.ok(segments.some((s) => s.match && s.text === 'builds'));
});

test('common words are not marked', () => {
  const marked = highlightSegments(PASSAGE, 'which languages must every playable ship with')
    .filter((segment) => segment.match)
    .map((segment) => segment.text.toLowerCase());

  assert.ok(marked.includes('language'), 'the discriminative term should be marked');
  for (const noise of ['with', 'every', 'must', 'the']) {
    assert.ok(!marked.includes(noise), `${noise} should not be marked`);
  }
});

test('matched segments are flagged case-insensitively', () => {
  const segments = highlightSegments('English serves as the fallback.', 'ENGLISH');
  assert.deepEqual(segments[0], { text: 'English', match: true });
});

test('byte and duration formatting cross their unit boundaries', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(6_710_886), '6.4 MB');

  assert.equal(formatMs(0), '0ms');
  assert.equal(formatMs(999), '999ms');
  assert.equal(formatMs(1000), '1.0s');
  assert.equal(formatMs(12_000), '12s');
});

test('catalog numbers are zero-padded to a fixed width', () => {
  assert.equal(catalogNumber('DOC', 42), 'DOC-0042');
  assert.equal(catalogNumber('RUN', 7), 'RUN-0007');
  // Beyond the width the number wins; a truncated catalog number would collide.
  assert.equal(catalogNumber('DOC', 123456), 'DOC-123456');
});

/**
 * `passageBody` deletes text from a passage, which is the one operation this file must be
 * most careful about: the product's promise is that what is shown is what was indexed. It
 * may only ever remove a heading that says nothing the title has not already said.
 */

test('a leading heading that repeats the title is dropped, with its blank line', () => {
  const passage = '# Build Pipeline\n\nLumen builds run through the internal CLI.';
  assert.equal(passageBody(passage, 'Build Pipeline'), 'Lumen builds run through the internal CLI.');
});

test('punctuation and case do not stop it matching', () => {
  const passage = '## Lumen SDK v2 (DEPRECATED)\n\nStatus: deprecated since January.';
  assert.equal(passageBody(passage, 'Lumen SDK v2 (deprecated)'), 'Status: deprecated since January.');
});

test('a heading that carries its own words is left alone', () => {
  for (const [passage, title] of [
    ['# Build Pipeline: stages\n\nBody.', 'Build Pipeline'],
    ['# Stages\n\nBody.', 'Build Pipeline'],
    ['Body with no heading at all.', 'Build Pipeline'],
    ['#NotAHeading\n\nBody.', 'NotAHeading'],
  ] as const) {
    assert.equal(passageBody(passage, title), passage, `dropped content for ${title}`);
  }
});

test('nothing but the heading leaves an empty body rather than throwing', () => {
  assert.equal(passageBody('# Build Pipeline', 'Build Pipeline'), '');
  assert.equal(passageBody('', 'Build Pipeline'), '');
});
