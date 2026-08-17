import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './client.ts';
import { getSearchStats } from './stats.ts';

/**
 * Dashboard analytics.
 *
 * These figures are read by a human deciding whether the system is healthy, so a
 * wrong number here is worse than a missing one: it is confidently wrong and there
 * is nothing on the page to contradict it. The rolling windows are the part that
 * was actually broken, and they were broken silently — every value looked plausible.
 */

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-stats-'));
  const db = openDb(path.join(dir, 'test.db'));
  return {
    db,
    [Symbol.dispose]() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Insert a query at a controlled age, in the format the application writes.
 *
 * Each date modifier has to be its own argument to `strftime` — passing
 * `'-7 days -6 hours'` as one string returns NULL rather than erroring, which then
 * trips the NOT NULL constraint several frames away from the cause.
 */
function insertAged(db: ReturnType<typeof openDb>, modifiers: string[], latencyMs = 10) {
  const placeholders = modifiers.map(() => '?').join(', ');
  db.prepare(
    `INSERT INTO search_queries (user_id, source, query, result_count, abstained, latency_ms, created_at)
     VALUES ('u', 'web', ?, 1, 0, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now', ${placeholders}))`,
  ).run(`aged ${modifiers.join(' ')}`, latencyMs, ...modifiers);
}

/**
 * `created_at` is stored as `2026-08-17T08:00:00Z`. The window compared it against
 * `datetime('now','-7 days')`, which returns `2026-08-10 08:00:00` — space
 * separated, no `Z`. That comparison is lexicographic, and at position 10 it pits
 * `'T'` (0x54) against `' '` (0x20), so `'T'` always won and every row sharing the
 * boundary *date* counted as inside the window whatever its time.
 *
 * The row below is 7 days and 6 hours old, so it is unambiguously outside a 7-day
 * window, and lands on the boundary date where the old comparison went wrong.
 */
test('the rolling windows exclude a row that is outside them', () => {
  using ctx = tempDb();

  insertAged(ctx.db, ['-7 days', '-6 hours']);
  insertAged(ctx.db, ['-1 days']);
  insertAged(ctx.db, ['-1 hours']);

  const stats = getSearchStats(ctx.db);

  assert.equal(stats.queriesTotal, 3, 'the total counts every row regardless of age');
  assert.equal(
    stats.queriesLast7Days,
    2,
    'a row 7 days and 6 hours old is not within the last 7 days',
  );
});

/** The same mismatch sat in the 14-day chart window, via the same helper. */
test('the volume chart window excludes a row older than it', () => {
  using ctx = tempDb();

  insertAged(ctx.db, ['-13 days', '-6 hours']);
  insertAged(ctx.db, ['-2 days']);

  const days = getSearchStats(ctx.db).volumeByDay;

  assert.equal(days.length, 1, `expected one day of volume, got ${JSON.stringify(days)}`);
});

/** Nothing recorded is a legitimate state, not a division by zero. */
test('an empty table reports zeroes rather than failing', () => {
  using ctx = tempDb();
  const stats = getSearchStats(ctx.db);

  assert.equal(stats.queriesTotal, 0);
  assert.equal(stats.queriesLast7Days, 0);
  assert.equal(stats.abstainRate, 0);
  assert.equal(stats.avgLatencyMs, 0);
  assert.equal(stats.p95LatencyMs, 0);
  assert.deepEqual(stats.topQueries, []);
  assert.deepEqual(stats.recentAbstains, []);
  assert.deepEqual(stats.volumeByDay, []);
});

/**
 * The abstain rate is the figure the dashboard exists to surface — a rising one is a
 * list of documents the corpus is missing, not a fault report — so it has to be the
 * share of queries that actually abstained.
 */
test('the abstain rate is the share of queries that abstained', () => {
  using ctx = tempDb();

  const insert = (query: string, abstained: boolean) =>
    ctx.db
      .prepare(
        `INSERT INTO search_queries (user_id, source, query, result_count, abstained, latency_ms)
         VALUES ('u', 'web', ?, 1, ?, 10)`,
      )
      .run(query, abstained ? 1 : 0);

  insert('answerable one', false);
  insert('answerable two', false);
  insert('answerable three', false);
  insert('junior developer salary', true);

  const stats = getSearchStats(ctx.db);

  assert.equal(stats.abstainRate, 0.25);
  assert.equal(stats.recentAbstains.length, 1);
  assert.equal(stats.recentAbstains[0]?.query, 'junior developer salary');
});
