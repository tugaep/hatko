/**
 * Scheduling for the ingestion watcher.
 *
 * Separated from `cli.ts` for one reason: this is the part that fails silently. If
 * coalescing breaks, the corpus costs one embedding pass per filesystem event and
 * nobody notices except the bill. If the mid-run case breaks, a change that lands
 * while a run is in flight is dropped, and the index stays behind with every run
 * recorded as having succeeded. Neither shows up as an error, so both get a test.
 */

export interface ReindexScheduler {
  /** A change was seen. Coalesced with any others in the debounce window. */
  notify(): void;
  /** Cancel a pending run. Does not interrupt one already in flight. */
  stop(): void;
}

export interface ReindexSchedulerOptions {
  debounceMs: number;
  /** Reported instead of thrown: a watcher that dies on one bad run stops watching. */
  onError?: (error: unknown) => void;
}

/**
 * Turn a stream of change notifications into non-overlapping runs of `run`.
 *
 * Three guarantees, in the order they matter:
 *
 * 1. **Coalescing.** A burst of notifications inside the debounce window produces one
 *    run. One logical edit is rarely one filesystem event — editors write and rename,
 *    `git checkout` rewrites hundreds of files — and each run costs embedding calls.
 * 2. **No overlap.** `run` is never re-entered. Two concurrent ingestion passes would
 *    each plan against a corpus state the other is changing.
 * 3. **Nothing dropped.** A notification that arrives *during* a run schedules another
 *    one after it, rather than being swallowed by the "already running" check. This is
 *    the guarantee that keeps the index from silently falling behind exactly when
 *    someone is editing quickly.
 */
export function createReindexScheduler(
  run: () => Promise<void>,
  options: ReindexSchedulerOptions,
): ReindexScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let notifiedDuringRun = false;

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void execute(), options.debounceMs);
  }

  async function execute(): Promise<void> {
    if (running) {
      notifiedDuringRun = true;
      return;
    }

    running = true;
    try {
      await run();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      // Re-scheduled rather than run immediately, so a change arriving during a long
      // run is still coalesced with any others that follow it.
      if (notifiedDuringRun) {
        notifiedDuringRun = false;
        schedule();
      }
    }
  }

  return {
    notify: schedule,
    stop: () => clearTimeout(timer),
  };
}
