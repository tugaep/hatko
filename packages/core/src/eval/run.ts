import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { closeDb, getDb } from '../db/client.ts';
import { activeModels, providerConfigured } from '../settings.ts';
import { hybridSearch, type RetrievalArm } from '../retrieval/search.ts';
import { rerank } from '../retrieval/rerank.ts';
import { answerQuestion, DEFAULT_ANSWER_PASSAGES } from '../answer/generate.ts';
import { ANSWERABLE, EVAL_QUESTIONS, UNANSWERABLE } from './questions.ts';
import { summarise, type QuestionResult } from './metrics.ts';

/**
 * `npm run eval [-- --arm=hybrid|vector|keyword|all] [--k=5]`
 *
 * Measures retrieval, not answer wording. Retrieval is what everything downstream rests on, and
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
    answers: { type: 'boolean', default: false },
    detail: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run eval [-- <options>]

  --arm=<hybrid|vector|keyword|all>  Which retrieval arms to measure (default: all)
  --k=<n>                            Cut-off for recall@k (default: 5)
  --rerank                           Apply the LLM rerank pass (needs an API key)
  --answers                          Also generate answers and check their content
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

/**
 * The depth the answer path actually reranks, imported rather than restated.
 *
 * This was a local `10`, which meant the recall figures reported below described a
 * rerank over ten candidates while the shipped answer path reranks six — so a
 * document sitting at fused rank 7 could be promoted to first here and never be
 * seen in production. The eval has to measure the system, not a nearby one.
 */
const RETRIEVE_DEPTH = DEFAULT_ANSWER_PASSAGES;

async function evaluate(arm: RetrievalArm, withRerank: boolean): Promise<QuestionResult[]> {
  const db = getDb();
  const results: QuestionResult[] = [];

  for (const question of EVAL_QUESTIONS) {
    let hits = await hybridSearch(db, question.question, {
      arm,
      limit: RETRIEVE_DEPTH,
      candidates: 10,
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

const pct = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);

// --- run --------------------------------------------------------------------

const db = getDb();
const indexed = db.prepare('SELECT count(*) n FROM chunks').get() as { n: number };

if (indexed.n === 0) {
  console.error('The index is empty. Run `npm run ingest` first.');
  closeDb();
  process.exit(1);
}

// Read from settings, not from config: an admin can switch provider from the dashboard,
// and every call below then goes to the stored one. Naming the environment's models
// beside numbers produced by different ones is the exact false claim this banner exists
// to prevent. The embedding model stays on config — it is env-only by design.
const models = activeModels(db);
const hasProvider = providerConfigured(db);
const requested: RetrievalArm[] =
  values.arm === 'all' ? ['keyword', 'vector', 'hybrid'] : [values.arm as RetrievalArm];

const arms = requested.filter((arm) => {
  if (arm !== 'keyword' && !hasProvider) return false;
  return true;
});

if (arms.length === 0) {
  console.error(
    'No model provider is configured, so only the keyword arm can run.\n' +
      'Set an API key in the admin settings page or as OPENAI_API_KEY in .env, point\n' +
      'OPENAI_BASE_URL at a local model server, or use --arm=keyword.',
  );
  closeDb();
  process.exit(1);
}

console.log(
  `Retrieval eval — ${indexed.n} chunks, ${ANSWERABLE.length} answerable questions, ` +
    `${UNANSWERABLE.length} unanswerable\n` +
    // Named, because these numbers are the evidence for choosing a provider and a
    // recall figure with no model beside it cannot be compared to another one.
    `Provider ${models.providerLabel} — embed ${config.embeddingModel} ` +
    `(${config.embeddingDimensions}d), rerank ${models.rerankModel}, answer ${models.answerModel}.\n` +
    // Stated, because recall@k means nothing without the size of the pool it was
    // measured over, and a reader comparing these figures to the product needs to
    // know they describe the same depth it reranks.
    `Retrieving ${RETRIEVE_DEPTH} passages per question, the depth the answer path uses.\n`,
);

if (!hasProvider && values.arm === 'all') {
  console.log('No model provider configured: vector and hybrid arms skipped, keyword arm only.\n');
}

const byArm = new Map<RetrievalArm, ReturnType<typeof summarise>>();
const resultsByArm = new Map<RetrievalArm, QuestionResult[]>();

for (const arm of arms) {
  const results = await evaluate(arm, values.rerank);
  resultsByArm.set(arm, results);
  const summary = summarise(results, K);
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

// --- answer checks ----------------------------------------------------------

/**
 * Retrieval rank is not the whole requirement.
 *
 * Sample question 2 retrieved perfectly — the current SDK document at rank 1 —
 * while the answer omitted that the previous version is deprecated, which
 * sample_questions.md names as part of a good answer. The eval reported success
 * and the requirement failed. These checks close that gap by asserting on the
 * answer itself: required content for answerable questions, and for unanswerable
 * ones that the system abstains and invents no citation.
 */
if (values.answers) {
  console.log('\n\nAnswer checks');
  console.log('─────────────');

  let failures = 0;

  for (const question of EVAL_QUESTIONS) {
    const response = await answerQuestion(db, question.question);
    const problems: string[] = [];
    /** Phrases the prose omitted but the structured notice supplied. */
    const viaNotice: string[] = [];

    if (question.expected.length === 0) {
      // The corpus cannot answer these. Abstaining is the correct behaviour, and
      // a citation attached to an abstention would be invented by definition.
      if (!response.abstained) problems.push('should have abstained');
      if (response.citations.length > 0) {
        problems.push(`invented ${response.citations.length} citation(s) while abstaining`);
      }
    } else {
      if (response.abstained) problems.push('abstained on an answerable question');
      if (!response.abstained && response.citations.length === 0) {
        problems.push('answered with no citation');
      }
      // Checked against everything the user is shown, not the prose alone. The
      // deprecation notice is a structured field precisely because the model
      // would not reliably put it in the sentence, and the chat page renders it
      // beside the answer — so prose-only would test a surface that is not the
      // one the reader sees. Where a phrase is satisfied only by the notice, the
      // report says so, so this cannot quietly paper over a regression in the
      // answer text.
      const noticeText = response.deprecationNotices
        .map(
          (n) =>
            `${n.documentTitle} is deprecated and no longer current` +
            (n.supersededBy ? `, superseded by ${n.supersededBy}` : ''),
        )
        .join('\n');

      for (const phrase of question.mustMention ?? []) {
        const needle = phrase.toLowerCase();
        const inProse = response.answer.toLowerCase().includes(needle);
        const inNotice = noticeText.toLowerCase().includes(needle);

        if (!inProse && !inNotice) {
          problems.push(`response never mentions "${phrase}"`);
        } else if (!inProse) {
          viaNotice.push(phrase);
        }
      }
      // Every citation must resolve to a document that was actually retrieved.
      const retrieved = new Set(response.sources.map((s) => s.sourcePath));
      for (const citation of response.citations) {
        if (!retrieved.has(citation.sourcePath)) {
          problems.push(`cites ${citation.sourcePath}, which was never retrieved`);
        }
      }
    }

    if (problems.length === 0) {
      const note =
        viaNotice.length > 0 ? `  (via deprecation notice: ${viaNotice.join(', ')})` : '';
      console.log(`  ok    ${question.id}${note}`);
    } else {
      failures++;
      console.log(`  FAIL  ${question.id}`);
      for (const problem of problems) console.log(`          ${problem}`);
    }
  }

  console.log(
    `\n${EVAL_QUESTIONS.length - failures}/${EVAL_QUESTIONS.length} answer checks passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

closeDb();
