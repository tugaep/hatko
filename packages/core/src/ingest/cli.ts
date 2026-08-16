import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { getDb, closeDb } from '../db/client.ts';
import { ingest } from './pipeline.ts';

/**
 * `npm run ingest [-- --force] [--quiet]`
 *
 * Pointing this at a different corpus is a CORPUS_PATH change and nothing else.
 */

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run ingest [-- <options>]

  --force   Re-embed every document, ignoring unchanged content hashes
  --quiet   Print only the final summary

Reads CORPUS_PATH (${path.relative(config.repoRoot, config.corpusPath)})
and writes to DATABASE_PATH (${path.relative(config.repoRoot, config.databasePath)}).`);
  process.exit(0);
}

const db = getDb();
const started = performance.now();

try {
  const run = await ingest(db, {
    trigger: 'cli',
    force: values.force,
    onProgress: (progress) => {
      if (values.quiet) return;

      const isFailure = progress.message.startsWith('failed');
      const isPerFile =
        (progress.phase === 'read' || progress.phase === 'write') && progress.current;

      // Per-file counters redraw one line in place. Carriage returns are
      // meaningless once the output is piped to a file or a log, where they would
      // leave 142 concatenated fragments on a single line — so off a TTY the
      // counters are dropped entirely and only phase transitions are printed.
      if (isPerFile && !isFailure) {
        if (!process.stdout.isTTY) return;
        const verb = progress.phase === 'read' ? 'reading' : 'writing';
        process.stdout.write(`\r  ${verb} ${progress.current}/${progress.total}   `);
        return;
      }

      const prefix = process.stdout.isTTY ? `\r  ` : '  ';
      process.stdout.write(`${prefix}${progress.message}${' '.repeat(20)}\n`);
    },
  });

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const rows: Array<[string, number]> = [
    ['indexed', run.docsIndexed],
    ['updated', run.docsUpdated],
    ['skipped', run.docsSkipped],
    ['deleted', run.docsDeleted],
    ['failed', run.docsFailed],
  ];

  process.stdout.write(`\r${' '.repeat(40)}\r`);
  console.log(`\nRun ${run.id} ${run.status} in ${seconds}s — ${run.docsTotal} documents`);
  for (const [label, value] of rows) {
    if (value > 0 || label === 'failed') console.log(`  ${label.padEnd(8)} ${value}`);
  }

  if (run.docsFailed > 0) {
    console.log(`\n${run.docsFailed} document(s) failed. Details:`);
    const failures = db
      .prepare(`SELECT source_path, error FROM documents WHERE status = 'failed'`)
      .all() as Array<{ source_path: string; error: string }>;
    for (const failure of failures) console.log(`  ${failure.source_path}: ${failure.error}`);
    process.exitCode = 1;
  }
} catch (error) {
  // The run row is already marked failed by the pipeline; this is the operator-
  // facing message.
  console.error(`\nIngestion failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
