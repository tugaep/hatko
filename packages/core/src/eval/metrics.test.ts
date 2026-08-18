import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, type QuestionResult } from './metrics.ts';
import { ANSWERABLE, EVAL_QUESTIONS, UNANSWERABLE } from './questions.ts';

/**
 * The recall and MRR arithmetic, which is the evidence every retrieval decision in this
 * repository cites — the RRF constant, the candidate depth, the rerank pass. All three
 * were chosen by comparing these numbers between sweeps, so a metric that quietly
 * inflates would have justified the wrong design and reported success while doing it.
 *
 * Fixtures rather than the corpus: the point here is the arithmetic, and hand-built
 * ranks are the only way to assert a known answer. Retrieval quality against the real
 * documents is what `search.test.ts` and the eval script measure.
 */

const at = (rank: number | null, expected = ['answer.md']): QuestionResult => ({
  question: { id: 'q', question: 'q', expected, probes: '' },
  rank,
  topScore: null,
  topDocument: null,
  bestRelevance: null,
  contextHit: false,
});

/** An unanswerable question: no expected document, so recall is undefined for it. */
const unanswerable = (): QuestionResult => at(null, []);

test('a perfect run reports 100% and an MRR of exactly 1', () => {
  const s = summarise([at(1), at(1), at(1)], 5);
  assert.equal(s.recall1, 1);
  assert.equal(s.mrr, 1);
  assert.deepEqual(s.misses, []);
});

test('recall@k counts a hit at any rank up to k, and none beyond it', () => {
  const s = summarise([at(1), at(3), at(4), at(null)], 3);
  assert.equal(s.recall1, 0.25, 'one of four at rank 1');
  assert.equal(s.recall3, 0.5, 'two of four within the top three');
  assert.equal(s.recallK, 0.5, 'k=3 here, so recall@k is recall@3');
});

test('reciprocal rank is the reciprocal of the rank, averaged', () => {
  // 1/1 + 1/2 + 1/4 = 1.75 over three questions.
  assert.equal(summarise([at(1), at(2), at(4)], 5).mrr, 1.75 / 3);
});

/**
 * The convention that could silently flatter the numbers. Dropping a miss from the
 * denominator instead of scoring it zero would turn a retriever that finds one document
 * out of ten into a perfect one.
 */
test('a miss contributes zero to MRR rather than leaving the average', () => {
  const s = summarise([at(1), at(null)], 5);
  assert.equal(s.mrr, 0.5, 'one hit at rank 1 and one miss averages to 0.5, not 1.0');
  assert.equal(s.recall1, 0.5);
});

test('unanswerable questions are excluded, not scored as failures', () => {
  const withAbstentions = summarise([at(1), unanswerable(), unanswerable()], 5);
  assert.equal(withAbstentions.answerable, 1, 'only the answerable question is measured');
  assert.equal(withAbstentions.recall1, 1, 'a perfect retriever is not punished for abstaining');
  assert.equal(withAbstentions.mrr, 1);
  assert.deepEqual(withAbstentions.misses, [], 'an unanswerable question is never a miss');
});

test('a hit outside k is a miss even though it was retrieved', () => {
  const s = summarise([at(9)], 5);
  assert.equal(s.recallK, 0);
  assert.equal(s.misses.length, 1);
  assert.ok(s.mrr > 0, 'MRR still credits the rank, which is what makes it more sensitive');
});

test('an eval with nothing answerable reports zero rather than NaN', () => {
  const s = summarise([unanswerable()], 5);
  assert.equal(s.answerable, 0);
  for (const value of [s.recall1, s.recall3, s.recallK, s.mrr]) {
    assert.ok(Number.isFinite(value), 'a table of percentages must never print NaN');
    assert.equal(value, 0);
  }
});

/**
 * The eval set is a specification, not a sample — sample_questions.md names the
 * unanswerable cases explicitly and the brief says the private set is "in the same
 * style". A set that lost its unanswerable half would still report perfect recall while
 * measuring nothing about abstention, which is the behaviour most likely to be graded.
 */
test('the eval set keeps both halves it is meant to cover', () => {
  assert.equal(ANSWERABLE.length + UNANSWERABLE.length, EVAL_QUESTIONS.length);
  assert.ok(UNANSWERABLE.length >= 3, 'abstention is measured, not assumed');
  assert.ok(ANSWERABLE.length >= 5, 'the five sample questions at minimum');

  const ids = EVAL_QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique, so a result maps to one question');
  for (const q of ANSWERABLE) {
    assert.ok(
      q.expected.every((p) => p.endsWith('.md')),
      `${q.id} expects real corpus paths`,
    );
  }
});
