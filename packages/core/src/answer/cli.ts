import { parseArgs } from 'node:util';
import { closeDb, getDb } from '../db/client.ts';
import { answerQuestion } from './generate.ts';

/**
 * `npm run ask -- "your question"`
 *
 * The whole retrieval and answer path from a terminal, so it can be demonstrated
 * and debugged without the web app running.
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: 'string', default: '6' },
    sources: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const query = positionals.join(' ').trim();

/**
 * Checked rather than passed through as `Number(...)`.
 *
 * `--limit=abc` gave NaN, `slice(0, NaN)` gave zero passages, and the answer path
 * abstained — so a typo in a flag produced "No documents cover this.", a confident
 * false statement about the corpus, which is the one behaviour this system must
 * never get wrong. The HTTP surface was never exposed to it, because
 * `searchRequestSchema` coerces and bounds the same value.
 */
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
  console.error(`--limit must be an integer between 1 and 20, got "${values.limit}"`);
  process.exit(1);
}

if (values.help || !query) {
  console.log(`Usage: npm run ask -- "<question>" [options]

  --limit=<n>   Passages to retrieve (default: 6)
  --sources     Print every retrieved passage with its scores

Example:
  npm run ask -- "Why are sound assets built in a separate pass?"`);
  process.exit(query ? 0 : 1);
}

const db = getDb();

try {
  const indexed = db.prepare('SELECT count(*) n FROM chunks').get() as { n: number };
  if (indexed.n === 0) {
    console.error('The index is empty. Run `npm run ingest` first.');
    process.exit(1);
  }

  const response = await answerQuestion(db, query, { limit });

  console.log(`\n${response.answer}\n`);

  for (const notice of response.deprecationNotices) {
    const replacement = notice.supersededBy ? ` Superseded by ${notice.supersededBy}.` : '';
    console.log(`Deprecated: ${notice.documentTitle} is no longer current.${replacement}\n`);
  }

  if (response.abstained) {
    console.log(
      `Nearest passages (${response.sources.length}), none of which answer the question:`,
    );
    for (const source of response.sources.slice(0, 3)) {
      console.log(`  ${(source.rerankScore ?? 0).toFixed(2)}  ${source.sourcePath}`);
    }
  } else {
    console.log('Sources:');
    for (const citation of response.citations) {
      const flag = citation.isDeprecated ? '  [DEPRECATED]' : '';
      console.log(
        `  [${citation.index}] ${citation.documentTitle} — ${citation.sourcePath}${flag}`,
      );
    }
  }

  if (values.sources) {
    console.log('\nAll retrieved passages:');
    for (const source of response.sources) {
      const parts = [
        `rerank ${(source.rerankScore ?? 0).toFixed(2)}`,
        `fused ${source.score.toFixed(4)}`,
        source.vectorScore !== null ? `vec ${source.vectorScore.toFixed(3)}` : 'vec —',
        source.keywordScore !== null ? `bm25 ${source.keywordScore.toFixed(3)}` : 'bm25 —',
      ];
      console.log(`  ${source.sourcePath.padEnd(46)} ${parts.join('  ')}`);
    }
  }

  console.log(`\n${response.latencyMs} ms`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
