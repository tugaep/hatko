import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * A corpus this repository owns, for tests asserting ingestion *mechanics* rather than
 * anything about the installed corpus: a document declaring itself superseded, the one
 * that replaced it, a second category, and a file at the root with no directory to take
 * a category from.
 */
export const FIXTURE_CORPUS = path.join(import.meta.dirname, 'fixture-corpus');

/**
 * Why a test may be skipped rather than run: `false` when the real corpus is present.
 *
 * The corpus is not in the repository — it is Wikipedia text under a share-alike licence,
 * so what is version-controlled is `npm run corpus:fetch` rather than the documents. That
 * makes a fresh clone a legitimate state in which these tests cannot run, and skipping
 * with an instruction is the honest response. Failing would blame the reader for a file
 * they were never given; passing quietly against some smaller stand-in would be worse,
 * because these are the tests whose whole subject is how retrieval behaves on a corpus of
 * a thousand crowded documents.
 *
 * Everything asserting mechanics uses FIXTURE_CORPUS above and runs unconditionally, so a
 * clone with no corpus still exercises the ingestion pipeline end to end.
 */
export const skipWithoutCorpus: false | string = fs.existsSync(config.corpusPath)
  ? false
  : `corpus not present at ${config.corpusPath} — run \`npm run corpus:fetch\``;

/** True when the real corpus is on disk, for guarding module-level setup. */
export const hasCorpus = skipWithoutCorpus === false;
