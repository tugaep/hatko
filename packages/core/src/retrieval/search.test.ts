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
import { hybridSearch } from './search.ts';
import { RELEVANCE, hasGroundedSupport, rerank } from './rerank.ts';

/**
 * Retrieval against the real sample corpus.
 *
 * Embeddings are stubbed from a content hash, so the vector arm carries no
 * semantic signal here — these tests therefore assert what is verifiable without
 * a provider: the SQL mechanics of fusion, that each arm contributes what it
 * should, that metadata travels with results, and the rerank and abstain logic.
 * Semantic quality of the vector arm is measured by the eval script against a
 * real key, not asserted here where it would be meaningless.
 */

const stubEmbedder = async (text: string) => {
  const seed = createHash('sha256').update(text).digest();
  return Array.from({ length: config.embeddingDimensions }, (_, i) => {
    const byte = seed[i % seed.length] ?? 0;
    return (byte / 255) * 2 - 1;
  });
};

// Ingesting the corpus takes ~70ms, so one index is shared across the file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-search-'));
const db = openDb(path.join(dir, 'search.db'));
await ingest(db, {
  trigger: 'cli',
  corpusPath: config.corpusPath,
  embedder: (texts) => Promise.all(texts.map(stubEmbedder)),
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const search = (query: string, options = {}) =>
  hybridSearch(db, query, { embedder: stubEmbedder, ...options });

test('hybrid fusion returns results and every score field is populated coherently', async () => {
  const results = await search('What is the maximum file size for an AppLovin playable?');

  assert.ok(results.length > 0);
  for (const result of results) {
    // A result must have come from at least one arm.
    assert.ok(
      result.vectorScore !== null || result.keywordScore !== null,
      'result belongs to neither arm',
    );
    assert.ok(result.score > 0, 'fused score is positive');
    assert.equal(result.rerankScore, null, 'not reranked yet');
  }
});

test('the keyword arm finds the document the vector arm cannot', async () => {
  // Sample question 3. With stub embeddings the vector arm is noise, so a hit
  // here is entirely the lexical arm doing the work — which is the case for its
  // existence: 78 near-identical delivery reports otherwise bury this document.
  const results = await search('Why are sound assets built in a separate pass?', {
    arm: 'keyword',
  });

  assert.equal(results[0]?.sourcePath, 'build-pipeline.md');
});

test('fusion keeps a passage found by only one arm', async () => {
  // The whole point of a full outer join rather than an inner one.
  const results = await search('Which languages must every playable ship with?');
  const keywordOnly = results.filter((r) => r.vectorScore === null && r.keywordScore !== null);
  const vectorOnly = results.filter((r) => r.keywordScore === null && r.vectorScore !== null);

  assert.ok(
    keywordOnly.length + vectorOnly.length > 0,
    'expected at least one single-arm result to survive fusion',
  );
});

test('a query with no usable keyword terms falls back to vector-only', async () => {
  // "!!!" produces no FTS expression; passing an empty string to MATCH would be a
  // syntax error rather than an empty result.
  const results = await search('!!! ???');

  assert.ok(results.length > 0, 'vector arm still returns candidates');
  assert.ok(results.every((r) => r.keywordScore === null));
});

test('deprecation metadata travels with the result', async () => {
  const results = await search('lumen.track events v2', { arm: 'keyword', limit: 10 });
  const v2 = results.find((r) => r.sourcePath === 'sdk-notes-v2.md');

  assert.ok(v2, 'the deprecated document is retrievable — it is not filtered out');
  assert.equal(v2.isDeprecated, true);
  assert.equal(v2.supersededBy, 'Lumen SDK v3');
});

test('the category filter restricts results without emptying them', async () => {
  const results = await search('delivery report QA findings', { category: 'delivery-reports' });

  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.category === 'delivery-reports'));
});

test('an unknown category returns nothing, without paying for an embedding', async () => {
  let embedCalls = 0;
  const counting = async (text: string) => {
    embedCalls++;
    return stubEmbedder(text);
  };

  const results = await hybridSearch(db, 'anything at all', {
    category: 'no-such-category',
    embedder: counting,
  });

  assert.equal(results.length, 0);
  assert.equal(embedCalls, 0, 'a category that cannot match must not reach the provider');
});

/**
 * The filter runs after fusion, so a truncated candidate pool silently loses
 * in-category passages — and the loss is invisible, because the response is a
 * plausible shorter list rather than an error.
 *
 * The old pool was `max(candidates * 4, 100)`. This corpus is only 142 chunks, so the
 * hole was narrow; the fixture below reproduces the shape it takes at scale. 240
 * filler documents repeat the query phrase and crowd the top of the ranking, while
 * the single document in the target category mentions one term once and sits near the
 * bottom. Under a capped pool it never reaches the filter, and the facet returns
 * nothing at all for a category that plainly contains a match.
 *
 * Pinned to the keyword arm on purpose. Embeddings here are stubbed from a content
 * hash, so the vector arm orders documents effectively at random and would find the
 * target by luck often enough to make this pass without the fix — which is how the
 * first version of this test fooled me. BM25 over these fixtures is deterministic.
 */
test('a category filter finds a passage that ranks low across the whole corpus', async () => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-deep-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-deep-db-'));
  const deepDb = openDb(path.join(scratch, 'deep.db'));

  fs.mkdirSync(path.join(corpus, 'filler'));
  for (let i = 0; i < 240; i++) {
    fs.writeFileSync(
      path.join(corpus, 'filler', `note-${String(i).padStart(3, '0')}.md`),
      `# Filler Note ${i}\n\n` +
        'Quarterly telemetry calibration report. '.repeat(6) +
        `Revision ${i}.\n`,
    );
  }

  fs.mkdirSync(path.join(corpus, 'target'));
  fs.writeFileSync(
    path.join(corpus, 'target', 'buried.md'),
    '# Buried Document\n\n' +
      'Assorted unrelated prose about scheduling and staffing, mentioning ' +
      'calibration exactly once, padded so its length matches the filler notes ' +
      'and cannot win on brevity alone. '.repeat(2) +
      '\n',
  );

  await ingest(deepDb, {
    trigger: 'cli',
    corpusPath: corpus,
    embedder: (texts) => Promise.all(texts.map(stubEmbedder)),
  });

  const results = await hybridSearch(deepDb, 'quarterly telemetry calibration report', {
    arm: 'keyword',
    category: 'target',
  });

  assert.equal(results.length, 1, 'the only document in the category must be found');
  assert.equal(results[0]?.sourcePath, 'target/buried.md');

  deepDb.close();
  fs.rmSync(corpus, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('limit is respected', async () => {
  const results = await search('playable build pipeline', { limit: 3 });
  assert.ok(results.length <= 3);
});

/**
 * A blank query has nothing to match, and every arm treated it as one that did:
 * no keyword terms means the vector-only fallback, which embedded the empty string
 * and returned whichever passages sat nearest the origin. `/api/search` is guarded
 * by the schema's two-character minimum, but this function is exported and step 7's
 * MCP tool is a second caller with its own boundary.
 */
test('a blank query returns nothing rather than arbitrary passages', async () => {
  for (const query of ['', '   ', '\n\t']) {
    assert.deepEqual(await search(query), [], `"${query}" should retrieve nothing`);
  }
});

/**
 * Both are interpolated into SQL. `rrfK = 0` divides by zero at rank 1, which
 * SQLite returns as NULL and COALESCE turns into a score of zero — so the best hit
 * sorts last and the ranking inverts without erroring.
 */
test('retrieval knobs are rejected rather than producing a silently wrong order', async () => {
  await assert.rejects(search('build', { candidates: -5 }), /non-negative integer/);
  await assert.rejects(search('build', { rrfK: 0 }), /greater than zero/);
  await assert.rejects(search('build', { rrfK: -1 }), /greater than zero/);
});

// --- rerank -----------------------------------------------------------------

const gradeBy = (grades: Record<string, number>) => async (_q: string, c: SearchResult[]) =>
  new Map(c.map((r) => [r.chunkId, grades[r.sourcePath] ?? RELEVANCE.UNRELATED]));

test('reranking reorders by graded relevance, not by fusion rank', async () => {
  const results = await search('How do I initialize the current Lumen SDK?', {
    arm: 'keyword',
    limit: 10,
  });

  // The measured failure: BM25 ranks the deprecated v2 above the current v3,
  // because v2 mentions lumen.track more prominently than its replacement does.
  const reranked = await rerank('How do I initialize the current Lumen SDK?', results, {
    grader: gradeBy({
      'sdk-notes-v3.md': RELEVANCE.DIRECT,
      'sdk-notes-v2.md': RELEVANCE.SAME_TOPIC,
    }),
  });

  assert.equal(reranked[0]?.sourcePath, 'sdk-notes-v3.md');
  assert.equal(reranked[0]?.rerankScore, 1);
});

test('ungraded passages fall behind graded ones rather than being dropped', async () => {
  const results = await search('playable build pipeline', { limit: 5 });
  const [first, ...rest] = results;

  const partial = await rerank('anything', results, {
    grader: async () => new Map([[first!.chunkId, RELEVANCE.DIRECT]]),
  });

  assert.equal(partial.length, results.length, 'an incomplete response must not shrink results');
  assert.equal(partial[0]?.chunkId, first!.chunkId);
  assert.ok(partial.slice(1).every((r) => r.rerankScore === null));
  assert.deepEqual(
    partial.slice(1).map((r) => r.chunkId),
    rest.map((r) => r.chunkId),
    'ungraded passages keep their fusion order',
  );
});

test('a reranker failure degrades to fusion order rather than to no results', async () => {
  const results = await search('playable build pipeline', { limit: 5 });

  const fallback = await rerank('anything', results, {
    grader: async () => {
      throw new Error('provider unavailable');
    },
  });

  assert.deepEqual(
    fallback.map((r) => r.chunkId),
    results.map((r) => r.chunkId),
  );
  assert.ok(fallback.every((r) => r.rerankScore === null));
});

test('abstention distinguishes "judged irrelevant" from "never judged"', async () => {
  const results = await search('playable build pipeline', { limit: 5 });

  const graded = await rerank('q', results, { grader: gradeBy({}) });
  assert.equal(hasGroundedSupport(graded), false, 'all zeros means no support');

  const supported = await rerank('q', results, {
    grader: gradeBy({ [results[0]!.sourcePath]: RELEVANCE.PARTIAL }),
  });
  assert.equal(hasGroundedSupport(supported), true, 'a partial answer is support');

  const ungraded = await rerank('q', results, {
    grader: async () => {
      throw new Error('down');
    },
  });
  // Null, not false. Abstaining because the grader was unreachable would turn an
  // outage into a confident claim that the corpus lacks the answer.
  assert.equal(hasGroundedSupport(ungraded), null);
});

test('same-topic-but-not-answering does not clear the abstain bar', async () => {
  // The hard abstention case: asking about a TikTok size limit retrieves the
  // AppLovin spec, which shares almost every word but answers a different question.
  const results = await search('What is the maximum file size for a TikTok playable?', {
    arm: 'keyword',
    limit: 5,
  });

  const graded = await rerank('What is the maximum file size for a TikTok playable?', results, {
    grader: gradeBy({ 'network-specs-applovin.md': RELEVANCE.SAME_TOPIC }),
  });

  assert.equal(hasGroundedSupport(graded), false, 'grade 1 must not be treated as support');
});

test('RRF damping keeps a confident single-arm hit ahead of a mediocre both-arm hit', () => {
  const rrf = (k: number, ranks: number[]) => ranks.reduce((sum, r) => sum + 1 / (k + r), 0);

  // The measured failure that set the default. With k=60 a passage ranked 20th by
  // both arms outscores one ranked 1st by a single arm, because the constant
  // swamps the rank difference — 1/80 + 1/80 beats 1/61. That is what dropped
  // localization-guide.md from keyword rank 1 to outside the hybrid top 30.
  assert.ok(rrf(60, [1]) < rrf(60, [20, 20]), 'k=60 loses the confident single-arm hit');

  // At the tuned k the ordering is restored.
  assert.ok(rrf(10, [1]) > rrf(10, [20, 20]), 'k=10 preserves it');

  // Agreement between arms still counts when ranks are comparable, which is the
  // property that makes fusion worth doing at all.
  assert.ok(rrf(10, [2, 2]) > rrf(10, [1]), 'both arms agreeing still outranks one arm alone');
});
