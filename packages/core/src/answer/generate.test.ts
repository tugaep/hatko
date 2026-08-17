import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SearchResult } from '@sorrel/shared';
import { config } from '../config.ts';
import { openDb } from '../db/client.ts';
import { ingest } from '../ingest/pipeline.ts';
import { RELEVANCE } from '../retrieval/rerank.ts';
import {
  ABSTAIN_MESSAGE,
  answerQuestion,
  deprecationNoticesFor,
  validateCitations,
} from './generate.ts';

/**
 * The answer path, with the model stubbed.
 *
 * What is asserted here is the part that must hold regardless of which model runs
 * or how it is prompted: citations resolve to passages that were actually
 * supplied, an answer nobody can check is not published, and abstention happens
 * for the right reason. A prompt can be ignored by a model; these checks cannot.
 */

const stubEmbedder = async (text: string) => {
  const seed = createHash('sha256').update(text).digest();
  return Array.from({ length: config.embeddingDimensions }, (_, i) => {
    const byte = seed[i % seed.length] ?? 0;
    return (byte / 255) * 2 - 1;
  });
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-answer-'));
const db = openDb(path.join(dir, 'answer.db'));
await ingest(db, {
  trigger: 'cli',
  corpusPath: config.corpusPath,
  embedder: (texts) => Promise.all(texts.map(stubEmbedder)),
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Grade everything as directly relevant, so support is never the thing under test. */
const allRelevant = async (_q: string, c: SearchResult[]): Promise<Map<number, number>> =>
  new Map(c.map((r) => [r.chunkId, RELEVANCE.DIRECT]));
const noneRelevant = async (_q: string, c: SearchResult[]): Promise<Map<number, number>> =>
  new Map(c.map((r) => [r.chunkId, RELEVANCE.UNRELATED]));

const ask = (
  query: string,
  generator: (q: string, p: SearchResult[]) => Promise<string>,
  grader = allRelevant,
) => answerQuestion(db, query, { arm: 'keyword', generator, grader });

// --- citation validation ----------------------------------------------------

const fakePassages = (n: number): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    chunkId: i + 1,
    documentId: i + 1,
    documentTitle: `Doc ${i + 1}`,
    sourcePath: `doc-${i + 1}.md`,
    category: 'guides',
    heading: null,
    content: 'body',
    ordinal: 0,
    score: 1,
    vectorScore: null,
    keywordScore: null,
    rerankScore: 1,
    isDeprecated: false,
    supersededBy: null,
  }));

test('valid markers resolve to the passages that were supplied', () => {
  const result = validateCitations('Limit is 5 MB [1] and it ships inline [2].', fakePassages(3));

  assert.equal(result.invented, 0);
  assert.deepEqual(
    result.citations.map((c) => c.index),
    [1, 2],
  );
  assert.equal(result.citations[0]?.sourcePath, 'doc-1.md');
});

test('a marker pointing past the supplied passages is removed, not rendered', () => {
  // The core "invents no citation" guarantee. A [7] against six passages would
  // otherwise render as a link to a source that was never consulted.
  const result = validateCitations('Grounded [1]. Invented [7].', fakePassages(3));

  assert.equal(result.invented, 1);
  assert.deepEqual(
    result.citations.map((c) => c.index),
    [1],
  );
  assert.ok(!result.answer.includes('[7]'), 'the dangling marker is gone from the text');
  assert.equal(result.answer, 'Grounded [1]. Invented.');
});

test('a grouped marker keeps its valid members and drops the rest', () => {
  const result = validateCitations('Both sources agree [1,9].', fakePassages(3));

  assert.equal(result.invented, 1);
  assert.deepEqual(
    result.citations.map((c) => c.index),
    [1],
  );
  assert.equal(result.answer, 'Both sources agree [1].');
});

test('zero and negative markers are rejected', () => {
  const result = validateCitations('Nonsense [0] and [1].', fakePassages(3));
  assert.equal(result.invented, 1);
  assert.deepEqual(
    result.citations.map((c) => c.index),
    [1],
  );
});

test('a citation is listed once however many times it is used', () => {
  const result = validateCitations('First [1]. Again [1]. Still [1].', fakePassages(2));
  assert.equal(result.citations.length, 1);
});

// --- abstention -------------------------------------------------------------

test('abstains when the reranker judges every passage irrelevant', async () => {
  const response = await ask(
    'What is the starting salary for a junior developer?',
    async () => {
      throw new Error('the generator must not be called when support is absent');
    },
    noneRelevant,
  );

  assert.equal(response.abstained, true);
  assert.equal(response.answer, ABSTAIN_MESSAGE);
  assert.deepEqual(response.citations, [], 'an abstention invents no citation');
  assert.ok(response.sources.length > 0, 'the nearest passages are still shown for judgement');
});

test('an answer that cites nothing is treated as an abstention', async () => {
  // An uncited claim cannot be checked against a source, which is the one thing
  // this system exists to guarantee, so it is withheld rather than published.
  const response = await ask(
    'Why are sound assets built in a separate pass?',
    async () => 'Sound assets are built separately because the encoder is single-threaded.',
  );

  assert.equal(response.abstained, true);
  assert.equal(response.answer, ABSTAIN_MESSAGE);
  assert.deepEqual(response.citations, []);
});

test('an answer whose every citation is invented abstains rather than publishing', async () => {
  const response = await ask(
    'Why are sound assets built in a separate pass?',
    async () => 'Because of the encoder [42].',
  );

  assert.equal(response.abstained, true, 'stripping the fake marker leaves nothing verifiable');
  assert.deepEqual(response.citations, []);
});

test('a grounded answer keeps its citations and does not abstain', async () => {
  const response = await ask(
    'Why are sound assets built in a separate pass?',
    async (_q, passages) =>
      `Audio is encoded in a dedicated pass [1]. Total passages: ${passages.length}.`,
  );

  assert.equal(response.abstained, false);
  assert.equal(response.citations.length, 1);
  assert.equal(response.citations[0]?.index, 1);
  assert.ok(response.sources.length > 0);
  assert.ok(response.latencyMs >= 0);
});

test('a generator failure raises rather than masquerading as an abstention', async () => {
  // "No documents cover this" would be a false statement about the corpus when
  // the real problem is that the provider is down.
  await assert.rejects(
    ask('Why are sound assets built in a separate pass?', async () => {
      throw new Error('provider unavailable');
    }),
    /Could not generate an answer.*provider unavailable/s,
  );
});

test('an unreachable grader does not cause a false abstention', async () => {
  // hasGroundedSupport returns null here, not false. Abstaining on a judgement
  // that never happened would turn an outage into a claim about the corpus.
  const response = await answerQuestion(db, 'Why are sound assets built in a separate pass?', {
    arm: 'keyword',
    grader: async () => {
      throw new Error('grader down');
    },
    generator: async () => 'Audio is encoded in a dedicated pass [1].',
  });

  assert.equal(response.abstained, false);
  assert.equal(response.citations.length, 1);
});

test('deprecation reaches the prompt so the answer can flag it', async () => {
  let seen = '';
  await answerQuestion(db, 'How do I initialize the Lumen SDK?', {
    arm: 'keyword',
    limit: 10,
    grader: allRelevant,
    generator: async (_q, passages) => {
      seen = passages
        .map((p) => `${p.sourcePath}:${p.isDeprecated}:${p.supersededBy ?? ''}`)
        .join('|');
      return 'Call LumenSDK.init [1].';
    },
  });

  assert.match(seen, /sdk-notes-v2\.md:true:Lumen SDK v3/, 'the model is told v2 is superseded');
});

test('a deprecated source produces a notice regardless of what the model wrote', async () => {
  // The model was asked three separate ways to mention that v2 is superseded and
  // declined every time, answering correctly from v3 while omitting the fact. The
  // notice is therefore computed from ingest metadata, not parsed out of prose.
  const response = await answerQuestion(db, 'How do I initialize the Lumen SDK?', {
    arm: 'keyword',
    limit: 10,
    grader: allRelevant,
    generator: async () => 'Call LumenSDK.init(config) [1].',
  });

  const notice = response.deprecationNotices.find((n) => n.sourcePath === 'sdk-notes-v2.md');
  assert.ok(notice, 'the superseded document is reported');
  assert.equal(notice.supersededBy, 'Lumen SDK v3');
});

test('no notice when nothing retrieved is deprecated', () => {
  assert.deepEqual(deprecationNoticesFor(fakePassages(3)), []);
});

test('a document deprecated in two passages is reported once', () => {
  const passages = fakePassages(2).map((p) => ({
    ...p,
    sourcePath: 'old.md',
    documentTitle: 'Old Guide',
    isDeprecated: true,
    supersededBy: 'New Guide',
  }));

  assert.equal(deprecationNoticesFor(passages).length, 1);
});
