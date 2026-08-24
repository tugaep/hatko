import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { IngestionTrigger } from '@hatko/shared';
import { config, displayPath } from '../config.ts';
import { getDb, closeDb } from '../db/client.ts';
import { ingest, IngestionInProgressError } from './pipeline.ts';
import { createReindexScheduler } from './watch.ts';

/**
 * `npm run ingest [-- --force] [--quiet] [--watch]`
 *
 * Pointing this at a different corpus is a CORPUS_PATH change and nothing else.
 */

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    watch: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run ingest [-- <options>]

  --force   Re-embed every document, ignoring unchanged content hashes
  --quiet   Print only the final summary
  --watch   Stay running and re-index when the corpus changes on disk

Reads CORPUS_PATH (${displayPath(config.corpusPath)})
and writes to DATABASE_PATH (${displayPath(config.databasePath)}).

With --watch, --force applies to the initial pass only. "Rebuild the index" is a
one-time intent, and re-embedding all documents every time one file is saved is
not something anyone wants to pay for.`);
  process.exit(0);
}

const db = getDb();

/** Files the corpus reader would actually index. Anything else cannot change the index. */
const INDEXABLE = /\.mdx?$/i;

/**
 * How long to wait after a change before re-indexing.
 *
 * A single logical edit is rarely a single filesystem event: editors write a temp
 * file and rename it, `git checkout` rewrites hundreds of files, and a copy into the
 * corpus arrives file by file. Without coalescing, each of those would start its own
 * run — and each run costs embedding calls. Half a second is long enough to collect a
 * burst and short enough that a save feels immediate.
 */
const DEBOUNCE_MS = 500;

/** Run ingestion once and report it. Returns the number of documents that failed. */
async function runOnce(trigger: IngestionTrigger, force: boolean): Promise<number> {
  const started = performance.now();

  const run = await ingest(db, {
    trigger,
    force,
    onProgress: (progress) => {
      if (values.quiet) return;

      const isFailure = progress.message.startsWith('failed');
      const isPerFile =
        (progress.phase === 'read' || progress.phase === 'write') && progress.current;

      // Per-file counters redraw one line in place. Carriage returns are
      // meaningless once the output is piped to a file or a log, where they would
      // leave a thousand concatenated fragments on a single line — so off a TTY the
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
  }

  return run.docsFailed;
}

if (!values.watch) {
  try {
    const failed = await runOnce('cli', values.force);
    if (failed > 0) process.exitCode = 1;
  } catch (error) {
    // The run row is already marked failed by the pipeline; this is the operator-
    // facing message.
    console.error(`\nIngestion failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
} else {
  /**
   * Watch mode: the index keeps itself current.
   *
   * The diff engine that decides what actually changed already existed — content
   * hashes skip untouched files and a prune pass removes documents that are gone.
   * All this adds is the trigger, which is the part that makes it autonomous rather
   * than something a person has to remember.
   *
   * `fs.watch` is stdlib and recursive on every platform this targets, so there is no
   * dependency here. It is deliberately not a poller: polling a corpus of any size
   * costs a stat per file per interval to learn what the filesystem already knows.
   */
  const scheduler = createReindexScheduler(() => runOnce('watch', false).then(() => undefined), {
    debounceMs: DEBOUNCE_MS,
    onError: (error) => {
      if (error instanceof IngestionInProgressError) {
        // The dashboard or the API started a run. Theirs will finish, and the
        // scheduler already re-queues after a failed attempt, so this only needs
        // saying rather than handling.
        console.log('  a run is already in progress; retrying after it finishes');
        scheduler.notify();
        return;
      }
      console.error(
        `\nIngestion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  console.log(`Watching ${displayPath(config.corpusPath)} for changes.`);

  // The initial pass is what makes the watcher trustworthy on start: the corpus may
  // have changed while nothing was watching, and a watcher that only reacts to
  // future events would leave that gap permanently. Recorded as `startup` rather
  // than `watch` so the dashboard can tell "came up behind" from "a file changed".
  try {
    await runOnce('startup', values.force);
  } catch (error) {
    console.error(
      `\nInitial ingestion failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const watcher = fs.watch(config.corpusPath, { recursive: true }, (_event, filename) => {
    // A rename fires with the name of the file that appeared or vanished, so both
    // additions and deletions arrive here. Filtering to indexable extensions keeps
    // an editor's `.swp` or a `.DS_Store` from starting a run that can only conclude
    // nothing changed.
    if (filename && !INDEXABLE.test(filename)) return;
    scheduler.notify();
  });

  watcher.on('error', (error) => {
    // A watch handle can die on its own — the directory being replaced is the usual
    // cause. Exiting non-zero is right: a process that has stopped watching while
    // claiming to watch is worse than one a supervisor restarts.
    console.error(`\nWatch failed: ${error.message}`);
    process.exitCode = 1;
    shutdown();
  });

  function shutdown(): void {
    scheduler.stop();
    watcher.close();
    closeDb();
  }

  process.on('SIGINT', () => {
    console.log('\nStopping.');
    shutdown();
    process.exit(process.exitCode ?? 0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(process.exitCode ?? 0);
  });
}
