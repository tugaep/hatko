import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extractTerms, toFtsQuery } from './query.ts';
import { EVAL_QUESTIONS } from '../eval/questions.ts';

/**
 * FTS5 has a query grammar, so this is a parser boundary rather than cosmetic
 * cleanup. The tests below run the generated expressions against a real FTS5
 * table: asserting on the string alone would not prove it parses.
 */

function ftsTable() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(heading, content, tokenize='porter unicode61')");
  db.exec(
    `INSERT INTO t (heading, content) VALUES
      ('Hard limits', 'Maximum file size: 5 MB for the final single HTML file'),
      ('Events', 'The old lumen.track calls from v2 are not recognized and fail silently')`,
  );
  return db;
}

const runMatch = (db: DatabaseSync, expression: string) =>
  db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(expression);

test('stopwords are dropped but meaningful terms survive', () => {
  assert.deepEqual(extractTerms('What is the maximum file size'), ['maximum', 'file', 'size']);
});

test('duplicate terms collapse', () => {
  assert.deepEqual(extractTerms('size size SIZE'), ['size']);
});

test('a query of only stopwords still yields terms rather than nothing', () => {
  // Dropping every term would remove the keyword arm with no explanation.
  assert.deepEqual(extractTerms('what is it'), ['what', 'is', 'it']);
});

test('identifiers survive intact', () => {
  // These are the most discriminating tokens in a technical corpus; splitting
  // `lumen.track` into `lumen` and `track` would throw that away.
  assert.ok(extractTerms('how do I call lumen.track').includes('lumen.track'));
  assert.ok(extractTerms('see sdk-notes-v3 please').includes('sdk-notes-v3'));
  assert.ok(extractTerms('lumen-build 4.2 changelog').includes('4.2'));
});

test('every sample question produces a parseable FTS5 expression', () => {
  const db = ftsTable();
  // The real questions are the point: a bare "and how does it ship?" is invalid
  // FTS5, so passing user text through unprocessed throws on ordinary input.
  for (const question of EVAL_QUESTIONS) {
    const expression = toFtsQuery(question.question);
    assert.ok(expression, `${question.id} produced no expression`);
    assert.doesNotThrow(() => runMatch(db, expression), `${question.id}: ${expression}`);
  }
  db.close();
});

test('FTS5 operators in user input are neutralised, not executed', () => {
  const db = ftsTable();

  // Each of these is either a syntax error or a structure-changing operator when
  // passed through raw.
  const hostile = [
    'file AND size',
    'file OR NOT size',
    'size NEAR/2 file',
    'file*',
    '"unbalanced quote',
    'content: size',
    '(file size',
    '-size',
    '^file',
    'a" OR t MATCH "b',
  ];

  for (const input of hostile) {
    const expression = toFtsQuery(input);
    assert.ok(expression, `no expression for ${input}`);
    assert.doesNotThrow(() => runMatch(db, expression), `${input} -> ${expression}`);
  }
  db.close();
});

test('an embedded quote cannot break out of its term', () => {
  const expression = toFtsQuery('say "hello" now');
  // Doubled per FTS5 string literal rules, so the term stays one literal.
  assert.ok(expression);
  const db = ftsTable();
  assert.doesNotThrow(() => runMatch(db, expression));
  db.close();
});

test('input with nothing matchable yields null rather than an empty expression', () => {
  // An empty string passed to MATCH is itself a syntax error, so callers need a
  // signal to fall back to vector-only rather than a blank expression.
  assert.equal(toFtsQuery('!!! ??? ...'), null);
  assert.equal(toFtsQuery(''), null);
  assert.equal(toFtsQuery('a b c'), null, 'single characters are not useful terms');
});

test('the generated expression actually matches the intended row', () => {
  const db = ftsTable();
  const hits = runMatch(db, toFtsQuery('What is the maximum file size?')!);
  assert.equal(hits.length, 1);
  assert.equal(Number((hits[0] as { rowid: number }).rowid), 1);
  db.close();
});
