import test from 'node:test';
import assert from 'node:assert/strict';
import { createReindexScheduler } from './watch.ts';

/**
 * The watcher's scheduling, which is where its two silent failures live: paying for
 * an embedding pass per filesystem event, and dropping a change that arrives during a
 * run so the index stays behind with every run marked succeeded.
 */

const DEBOUNCE = 10;
const settle = (ms = DEBOUNCE * 4) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run whose completion the test controls, so "during a run" is a real state. */
function controllableRun() {
  const calls: number[] = [];
  let release: (() => void) | undefined;
  let inFlight = 0;
  let maxInFlight = 0;

  const run = () => {
    calls.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve) => {
      release = () => {
        inFlight -= 1;
        resolve();
      };
    });
  };

  return {
    run,
    get count() {
      return calls.length;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    release: () => release?.(),
  };
}

test('a burst of changes produces one run, not one per event', async () => {
  let count = 0;
  const scheduler = createReindexScheduler(
    async () => {
      count += 1;
    },
    { debounceMs: DEBOUNCE },
  );

  // An editor's write-then-rename, or a git checkout touching many files.
  for (let i = 0; i < 20; i += 1) scheduler.notify();

  await settle();
  assert.equal(count, 1, 'the debounce window did not coalesce the burst');
  scheduler.stop();
});

test('a change arriving during a run is not dropped', async () => {
  const target = controllableRun();
  const scheduler = createReindexScheduler(target.run, { debounceMs: DEBOUNCE });

  scheduler.notify();
  await settle();
  assert.equal(target.count, 1, 'the first run did not start');

  // The run is still in flight. This is the notification that used to vanish.
  scheduler.notify();
  await settle();
  assert.equal(target.count, 1, 'a second run started while the first was in flight');

  target.release();
  await settle();
  assert.equal(target.count, 2, 'the change that arrived mid-run was dropped');

  target.release();
  scheduler.stop();
});

test('runs never overlap', async () => {
  const target = controllableRun();
  const scheduler = createReindexScheduler(target.run, { debounceMs: DEBOUNCE });

  scheduler.notify();
  await settle();
  for (let i = 0; i < 5; i += 1) {
    scheduler.notify();
    await settle();
  }

  assert.equal(target.maxInFlight, 1, 'two ingestion passes ran concurrently');

  target.release();
  await settle();
  target.release();
  scheduler.stop();
});

test('a failing run is reported and does not stop later runs', async () => {
  // A watcher that exits on the first bad document has stopped watching while
  // claiming to watch, which is worse than one that reports and carries on.
  const errors: unknown[] = [];
  let count = 0;
  const scheduler = createReindexScheduler(
    async () => {
      count += 1;
      if (count === 1) throw new Error('one bad document');
    },
    { debounceMs: DEBOUNCE, onError: (error) => errors.push(error) },
  );

  scheduler.notify();
  await settle();
  assert.equal(errors.length, 1);

  scheduler.notify();
  await settle();
  assert.equal(count, 2, 'the scheduler stopped running after a failure');
  scheduler.stop();
});

test('stop cancels a pending run', async () => {
  let count = 0;
  const scheduler = createReindexScheduler(
    async () => {
      count += 1;
    },
    { debounceMs: DEBOUNCE },
  );

  scheduler.notify();
  scheduler.stop();

  await settle();
  assert.equal(count, 0, 'a run fired after the watcher was stopped');
});
