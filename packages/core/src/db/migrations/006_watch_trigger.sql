-- Allow 'watch' as an ingestion trigger.
--
-- The file watcher added in step 7b is a fourth cause of a run, and the trigger
-- column exists to say which cause it was — the dashboard's run list is the
-- observability requirement, and labelling a watcher run 'cli' would have made it
-- lie about why the index changed.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. That is safe
-- here specifically because nothing references ingestion_runs: no foreign key
-- points at it, and documents carry their own status rather than a run id. The
-- runner wraps every migration in a transaction, so a failure half-way leaves the
-- old table intact.
--
-- Column list is written out rather than using INSERT INTO ... SELECT *, because
-- '*' would silently depend on column order matching between the two tables, and
-- migration 004 appended duration_ms after the original nine.

CREATE TABLE ingestion_runs_new (
  id            INTEGER PRIMARY KEY,
  trigger       TEXT    NOT NULL CHECK (trigger IN ('cli', 'api', 'startup', 'watch')),
  status        TEXT    NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  docs_total    INTEGER NOT NULL DEFAULT 0,
  docs_indexed  INTEGER NOT NULL DEFAULT 0,
  docs_updated  INTEGER NOT NULL DEFAULT 0,
  docs_skipped  INTEGER NOT NULL DEFAULT 0,
  docs_deleted  INTEGER NOT NULL DEFAULT 0,
  docs_failed   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  started_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at   TEXT,
  duration_ms   INTEGER
);

INSERT INTO ingestion_runs_new (
  id, trigger, status, docs_total, docs_indexed, docs_updated,
  docs_skipped, docs_deleted, docs_failed, error, started_at, finished_at, duration_ms
)
SELECT
  id, trigger, status, docs_total, docs_indexed, docs_updated,
  docs_skipped, docs_deleted, docs_failed, error, started_at, finished_at, duration_ms
FROM ingestion_runs;

DROP TABLE ingestion_runs;

ALTER TABLE ingestion_runs_new RENAME TO ingestion_runs;

-- Dropped with the old table, so it has to be recreated.
CREATE INDEX ingestion_runs_started_idx ON ingestion_runs (started_at DESC);
