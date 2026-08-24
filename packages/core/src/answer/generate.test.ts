import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SearchResult } from '@hatko/shared';
import { config } from '../config.ts';
import { openDb } from '../db/client.ts';
import { ingest } from '../ingest/pipeline.ts';
import { ProviderError } from '../providers/openai.ts';
import { RELEVANCE } from '../retrieval/rerank.ts';
import {
  ABSTAIN_MESSAGE,
  answerQuestion,
  deprecationNoticesFor,
  validateCitations,
  type AnswerGenerator,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-answer-'));
const db = openDb(path.join(dir, 'answer.db'));
await ingest(db, {
  trigger: 'cli',
  corpusPath: config.corpusPath,
  embedder: (texts) => Promise.all(texts.map(stubEmbedder)),
});

/**
 * A second index over the fixture corpus in `../testing`, for the two deprecation
 * tests below. They need a document that declares itself superseded, which no real
 * corpus can be relied on to contain.
 */
const fixtureDb = openDb(path.join(dir, 'fixture.db'));
await ingest(fixtureDb, {
  trigger: 'cli',
  corpusPath: path.join(import.meta.dirname, '..', 'testing', 'fixture-corpus'),
  embedder: (texts) => Promise.all(texts.map(stubEmbedder)),
});

test.after(() => {
  db.close();
  fixtureDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Grade everything as directly relevant, so support is never the thing under test. */
const allRelevant = async (_q: string, c: SearchResult[]): Promise<Map<number, number>> =>
  new Map(c.map((r) => [r.chunkId, RELEVANCE.DIRECT]));
const noneRelevant = async (_q: string, c: SearchResult[]): Promise<Map<number, number>> =>
  new Map(c.map((r) => [r.chunkId, RELEVANCE.UNRELATED]));

const ask = (query: string, generator: AnswerGenerator, grader = allRelevant) =>
  answerQuestion(db, query, { arm: 'keyword', generator, grader });

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

test('a provider failure keeps its type so the API can answer 502, not 500', async () => {
  // The API maps ProviderError to "the model provider could not be reached, try again in a
  // moment". Wrapped in a plain Error it became a generic 500 instead, which tells the
  // reader to wait for an engineer when what they should do is press the button again.
  await assert.rejects(
    ask('Why are sound assets built in a separate pass?', async () => {
      throw new ProviderError('upstream 503');
    }),
    (error: unknown) => error instanceof ProviderError,
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
  await answerQuestion(fixtureDb, 'How do I initialize the widget client?', {
    arm: 'keyword',
    limit: 10,
    grader: allRelevant,
    generator: async (_q, passages) => {
      seen = passages
        .map((p) => `${p.sourcePath}:${p.isDeprecated}:${p.supersededBy ?? ''}`)
        .join('|');
      return 'Call widget.init [1].';
    },
  });

  assert.match(seen, /widget-api-v1\.md:true:Widget API v2/, 'the model is told v1 is superseded');
});

test('a deprecated source produces a notice regardless of what the model wrote', async () => {
  // The model was asked three separate ways to mention that the older document is
  // superseded and declined every time, answering correctly from the current one
  // while omitting the fact. The notice is therefore computed from ingest
  // metadata, not parsed out of prose.
  const response = await answerQuestion(fixtureDb, 'How do I initialize the widget client?', {
    arm: 'keyword',
    limit: 10,
    grader: allRelevant,
    generator: async () => 'Call widget.init(config) [1].',
  });

  const notice = response.deprecationNotices.find(
    (n) => n.sourcePath === 'guides/widget-api-v1.md',
  );
  assert.ok(notice, 'the superseded document is reported');
  assert.equal(notice.supersededBy, 'Widget API v2');
});

// --- streaming ---------------------------------------------------------------

/**
 * Streaming changes when an answer arrives, never what it is allowed to claim.
 *
 * That is the whole risk of the feature. Every guarantee in this file is enforced on the
 * *complete* text, after the last fragment — so a streamed answer can be halfway through a
 * confident sentence and still end as an abstention. The tests below are the ones that
 * fail if someone ever "optimises" the abstain decision to run on partial text, or lets
 * the deltas become the published answer.
 */

/** A generator that reports its text one word at a time, as a real one does. */
const streaming =
  (text: string): AnswerGenerator =>
  async (_q, _p, onDelta) => {
    for (const word of text.split(' ')) onDelta?.(`${word} `);
    return text;
  };

test('the streamed fragments reassemble into the answer that was published', async () => {
  const deltas: string[] = [];
  const response = await answerQuestion(db, 'Why are sound assets built in a separate pass?', {
    arm: 'keyword',
    grader: allRelevant,
    generator: streaming('Audio is encoded in a dedicated pass [1].'),
    onDelta: (text) => deltas.push(text),
  });

  assert.ok(deltas.length > 1, 'the fragments arrived separately, not as one block');
  assert.equal(deltas.join('').trim(), 'Audio is encoded in a dedicated pass [1].');
  assert.equal(response.answer, 'Audio is encoded in a dedicated pass [1].');
  assert.equal(response.citations.length, 1);
});

test('a streamed answer that cites nothing still abstains', async () => {
  // The important one. Forty words of plausible prose reached the reader's screen, and the
  // published result is still "no documents cover this" — because nothing in it can be
  // checked against a passage. A client that treats the fragments as the answer publishes
  // a claim this system refused to make.
  const deltas: string[] = [];
  const response = await answerQuestion(db, 'Why are sound assets built in a separate pass?', {
    arm: 'keyword',
    grader: allRelevant,
    generator: streaming(
      'Sound assets are built separately because the encoder is single-threaded.',
    ),
    onDelta: (text) => deltas.push(text),
  });

  assert.ok(deltas.length > 1, 'the unverifiable text was streamed');
  assert.equal(response.abstained, true);
  assert.equal(response.answer, ABSTAIN_MESSAGE);
  assert.deepEqual(response.citations, []);
});

test('an invented marker is stripped from the published answer after being streamed', async () => {
  // The deltas are raw model output, so `[42]` does reach the reader mid-stream. What must
  // not happen is it surviving into the validated answer as a citation to nowhere.
  let streamed = '';
  const response = await answerQuestion(db, 'Why are sound assets built in a separate pass?', {
    arm: 'keyword',
    grader: allRelevant,
    generator: streaming('Encoded in a dedicated pass [1], single-threaded [42].'),
    onDelta: (text) => {
      streamed += text;
    },
  });

  assert.match(streamed, /\[42\]/, 'the raw fragment carried the invented marker');
  assert.ok(!response.answer.includes('[42]'), 'the published answer does not');
  assert.deepEqual(
    response.citations.map((c) => c.index),
    [1],
  );
});

test('the passages are reported before generation starts', async () => {
  // This is what lets a client show the evidence during the wait. The order matters: after
  // generation it would be worthless, since the answer it was meant to accompany is
  // already there.
  const order: string[] = [];
  let reported: SearchResult[] = [];

  const response = await answerQuestion(db, 'Why are sound assets built in a separate pass?', {
    arm: 'keyword',
    grader: allRelevant,
    onPassages: (passages) => {
      order.push('passages');
      reported = passages;
    },
    generator: async () => {
      order.push('generate');
      return 'Encoded in a dedicated pass [1].';
    },
  });

  assert.deepEqual(order, ['passages', 'generate']);
  assert.deepEqual(
    reported.map((p) => p.chunkId),
    response.sources.map((p) => p.chunkId),
    'the rows shown early are the rows the answer was written from',
  );
});

test('the passages are reported even when the answer is withheld', async () => {
  // An abstention the reader cannot inspect is one they have to take on faith. The near
  // misses are how they judge whether the corpus really lacks the answer.
  let reported = 0;
  const response = await answerQuestion(db, 'What is the starting salary for a junior developer?', {
    arm: 'keyword',
    grader: noneRelevant,
    onPassages: (passages) => {
      reported = passages.length;
    },
    generator: async () => {
      throw new Error('the generator must not be called when support is absent');
    },
  });

  assert.equal(response.abstained, true);
  assert.ok(reported > 0, 'the nearest passages were reported before the abstain decision');
  assert.equal(reported, response.sources.length);
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
