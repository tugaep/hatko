import { parseArgs } from 'node:util';
import { closeDb, getDb } from '../db/client.ts';
import { resolveApiKey } from '../settings.ts';
import { hybridSearch, type RetrievalArm } from '../retrieval/search.ts';
import { rerank } from '../retrieval/rerank.ts';
import { ANSWERABLE, EVAL_QUESTIONS, UNANSWERABLE, type EvalQuestion } from './questions.ts';

/**
 * `npm run eval [-- --arm=hybrid|vector|keyword|all] [--k=5]`
 *
 * Measures retrieval, not answer wording. Retrieval is the top-graded axis and
 * the thing every later stage depends on: an answer cannot be grounded in a
 * passage that was never retrieved.
 *
 * Reported per arm so the hybrid design has to justify itself with numbers
 * rather than with an argument. If keyword-only matched hybrid on this corpus,
 * the second arm would be complexity for nothing.
 */

const { values } = parseArgs({
  options: {
    arm: { type: 'string', default: 'all' },
    k: { type: 'string', default: '5' },
    rerank: { type: 'boolean', default: false },
    detail: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run eval [-- <options>]

  --arm=<hybrid|vector|keyword|all>  Which retrieval arms to measure (default: all)
  --k=<n>                            Cut-off for recall@k (default: 5)
  --rerank                           Apply the LLM rerank pass (needs an API key)
  --detail                           Print per-question detail

The keyword arm needs no API key. The vector and hybrid arms embed the query and
are skipped with a note when no key is configured.`);
  process.exit(0);
}

const K = Number(values.k);
if (!Number.isInteger(K) || K < 1) {
  console.error(`--k must be a positive integer, got "${values.k}"`);
  process.exit(1);
}

interface QuestionResult {
  question: EvalQuestion;
  /** 1-based rank of the first expected document, or null if absent from the top-k pool. */
  rank: number | null;
  topScore: number | null;
  topDocument: string | null;
  /** Best rerank grade, 0..1. Null when reranking is off or unavailable. */
  bestRelevance: number | null;
  contextHit: boolean;
}

const RETRIEVE_DEPTH = 10;

async function evaluate(arm: RetrievalArm, withRerank: boolean): Promise<QuestionResult[]> {
  const db = getDb();
  const results: QuestionResult[] = [];

  for (const question of EVAL_QUESTIONS) {
    let hits = await hybridSearch(db, question.question, {
      arm,
      limit: RETRIEVE_DEPTH,
      candidates: 30,
    });

    if (withRerank) hits = await rerank(question.question, hits);

    const paths = hits.map((hit) => hit.sourcePath);
    const index = paths.findIndex((path) => question.expected.includes(path));
    const graded = hits.map((hit) => hit.rerankScore).filter((s): s is number => s !== null);

    results.push({
      question,
      rank: index === -1 ? null : index + 1,
      topScore: hits[0]?.score ?? null,
      topDocument: hits[0]?.sourcePath ?? null,
      bestRelevance: graded.length > 0 ? Math.max(...graded) : null,
      contextHit: (question.alsoRelevant ?? []).some((path) => paths.slice(0, K).includes(path)),
    });
  }

  return results;
}

function summarise(results: QuestionResult[]) {
  const answerable = results.filter((r) => r.question.expected.length > 0);
  const hitsAt = (k: number) =>
    answerable.filter((r) => r.rank !== null && r.rank <= k).length / answerable.length;

  // Mean reciprocal rank over answerable questions; a miss contributes zero.
  const mrr =
    answerable.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / answerable.length;

  return {
    recall1: hitsAt(1),
    recall3: hitsAt(3),
    recallK: hitsAt(K),
    mrr,
    misses: answerable.filter((r) => r.rank === null || r.rank > K),
  };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);

// --- run --------------------------------------------------------------------

const db = getDb();
const indexed = db.prepare('SELECT count(*) n FROM chunks').get() as { n: number };

if (indexed.n === 0) {
  console.error('The index is empty. Run `npm run ingest` first.');
  closeDb();
  process.exit(1);
}

const hasKey = resolveApiKey(db) !== null;
const requested: RetrievalArm[] =
  values.arm === 'all' ? ['keyword', 'vector', 'hybrid'] : [values.arm as RetrievalArm];

const arms = requested.filter((arm) => {
  if (arm !== 'keyword' && !hasKey) return false;
  return true;
});

if (arms.length === 0) {
  console.error(
    'No OpenAI API key is configured, so only the keyword arm can run.\n' +
      'Set it in the admin settings page or as OPENAI_API_KEY in .env, or use --arm=keyword.',
  );
  closeDb();
  process.exit(1);
}

console.log(
  `Retrieval eval — ${indexed.n} chunks, ${ANSWERABLE.length} answerable questions, ` +
    `${UNANSWERABLE.length} unanswerable\n`,
);

if (!hasKey && values.arm === 'all') {
  console.log('No API key configured: vector and hybrid arms skipped, keyword arm only.\n');
}

const byArm = new Map<RetrievalArm, ReturnType<typeof summarise>>();
const resultsByArm = new Map<RetrievalArm, QuestionResult[]>();

for (const arm of arms) {
  const results = await evaluate(arm, values.rerank);
  resultsByArm.set(arm, results);
  const summary = summarise(results);
  byArm.set(arm, summary);

  if (values.detail) {
    console.log(`── ${arm} ──`);
    for (const result of results) {
      const expected = result.question.expected.length === 0;
      const verdict = expected
        ? `top=${result.topDocument ?? '(none)'} score=${result.topScore?.toFixed(4) ?? '—'}`
        : result.rank === null
          ? 'MISS'
          : `rank ${result.rank}`;
      console.log(`  ${result.question.id.padEnd(24)} ${verdict}`);
    }
    console.log();
  }
}

console.log('arm       recall@1  recall@3  recall@' + K + '   MRR');
console.log('────────────────────────────────────────────────');
for (const [arm, s] of byArm) {
  console.log(
    `${arm.padEnd(9)} ${pct(s.recall1)}      ${pct(s.recall3)}      ${pct(s.recallK)}      ${s.mrr.toFixed(3)}`,
  );
}

const worst = byArm.get(arms[arms.length - 1]!)!;
if (worst.misses.length > 0) {
  console.log(`\nMissed at k=${K} (${arms[arms.length - 1]}):`);
  for (const miss of worst.misses) {
    console.log(`  ${miss.question.id}: ${miss.question.question}`);
    console.log(`    expected ${miss.question.expected.join(' or ')}`);
    console.log(`    got      ${miss.topDocument ?? '(nothing)'}`);
  }
}

/**
 * Unanswerable questions have no correct document, so recall says nothing about
 * them. What matters is whether any score separates them from answerable ones.
 *
 * For the fused score the answer is no, and necessarily so: RRF fuses ranks, not
 * magnitudes, so a top-ranked passage always scores 1/(k+1) whether it answers
 * the question perfectly or is merely the least bad of 142. This section exists
 * to make that visible rather than leaving someone to discover it by shipping a
 * threshold that cannot work.
 */
console.log('\nScore separation — can a threshold tell answerable from unanswerable?');

const range = (xs: number[]) =>
  xs.length === 0 ? '—' : `${Math.min(...xs).toFixed(4)}–${Math.max(...xs).toFixed(4)}`;

for (const arm of arms) {
  const results = resultsByArm.get(arm)!;
  const answerable = results.filter((r) => r.question.expected.length > 0);
  const unanswerable = results.filter((r) => r.question.expected.length === 0);

  const fusedA = answerable.map((r) => r.topScore ?? 0);
  const fusedU = unanswerable.map((r) => r.topScore ?? 0);
  const overlaps = Math.max(...fusedU) >= Math.min(...fusedA);

  console.log(
    `  ${arm.padEnd(8)} fused    answerable ${range(fusedA)}   unanswerable ${range(fusedU)}` +
      `${overlaps ? '   [overlapping — no usable threshold]' : ''}`,
  );

  const gradedA = answerable.map((r) => r.bestRelevance).filter((s): s is number => s !== null);
  const gradedU = unanswerable.map((r) => r.bestRelevance).filter((s): s is number => s !== null);
  if (gradedA.length > 0 || gradedU.length > 0) {
    console.log(
      `  ${' '.repeat(8)} relevance answerable ${range(gradedA)}   unanswerable ${range(gradedU)}`,
    );
  }
}

if (!values.rerank) {
  console.log(
    '\nThe fused score is rank-derived, so it cannot separate the two sets by construction.\n' +
      'Re-run with --rerank to measure the graded relevance signal that abstention uses.',
  );
}

closeDb();
