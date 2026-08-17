-- Hatko initial schema.
--
-- Storage is SQLite via node:sqlite (stdlib) plus the sqlite-vec extension.
-- Three physical stores share one integer key space:
--
--   chunks       the passages themselves (ordinary table, source of truth)
--   chunks_vec   dense vectors            (vec0 virtual table, rowid = chunks.id)
--   chunks_fts   inverted index for BM25  (fts5 virtual table, rowid = chunks.id)
--
-- Sharing chunks.id as the rowid across all three is what makes hybrid retrieval a
-- single SQL statement: the vector arm and the keyword arm return the same
-- identifiers and can be fused with a full outer join.

-- ---------------------------------------------------------------------------
-- documents: one row per file in the corpus
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY,
  -- Path relative to CORPUS_PATH. This is the document's stable identity across
  -- re-ingests; a moved file is treated as a delete plus an insert.
  source_path   TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  -- sha256 of file contents. Unchanged hash means the file is skipped without
  -- re-embedding, which is what keeps repeat ingests fast and idempotent.
  content_hash  TEXT    NOT NULL,
  byte_size     INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'indexed', 'failed')),
  -- Set when a document declares itself superseded (the sdk-notes-v2 case).
  -- Deprecated documents stay retrievable; the answer prompt and the UI flag them.
  is_deprecated INTEGER NOT NULL DEFAULT 0 CHECK (is_deprecated IN (0, 1)),
  superseded_by TEXT,
  error         TEXT,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  indexed_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX documents_status_idx     ON documents (status);
CREATE INDEX documents_category_idx   ON documents (category);
CREATE INDEX documents_deprecated_idx ON documents (is_deprecated) WHERE is_deprecated = 1;

-- ---------------------------------------------------------------------------
-- chunks: retrievable passages, cut on markdown headings
-- ---------------------------------------------------------------------------
CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  heading      TEXT,
  -- The passage as shown to the user. The text that gets embedded additionally
  -- carries the document title and heading as a prefix so an isolated passage
  -- retains the context of where it came from; that prefix is derived at ingest
  -- time and deliberately not stored, so what is displayed is what was written.
  content      TEXT    NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (document_id, ordinal)
);

CREATE INDEX chunks_document_idx ON chunks (document_id);

-- ---------------------------------------------------------------------------
-- chunks_vec: dense vectors
--
-- float[1536] matches text-embedding-3-small and EMBEDDING_DIMENSIONS. Changing
-- the embedding model to one of a different width needs a new migration.
--
-- No ANN index is configured, and that is deliberate: the sample corpus produces
-- 142 chunks, where an exhaustive cosine scan returns in about 1 ms. An
-- approximate index would trade recall away for latency we do not need. At a
-- corpus two or three orders of magnitude larger this becomes the thing to revisit.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE chunks_vec USING vec0 (
  embedding float[1536] distance_metric=cosine
);

-- ---------------------------------------------------------------------------
-- chunks_fts: BM25 keyword index
--
-- External-content table: FTS5 stores only the inverted index and reads the text
-- back from `chunks`, so passages are not duplicated on disk. External content
-- tables are not maintained automatically, hence the triggers below.
--
-- The porter stemmer matters for this corpus: it is what lets "sound assets are
-- built in a separate pass" match a query phrased as "why are sounds built
-- separately".
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  heading,
  content,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, heading, content)
  VALUES (new.id, new.heading, new.content);
END;

-- FTS5 external-content tables need the old row echoed back on delete so the
-- index can be unwound; a plain DELETE would leave the postings orphaned.
CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, heading, content)
  VALUES ('delete', old.id, old.heading, old.content);
  -- vec0 rows are not reached by the ON DELETE CASCADE above, because the
  -- cascade only applies to the chunks table. Without this the vector store
  -- would keep returning passages that no longer exist.
  DELETE FROM chunks_vec WHERE rowid = old.id;
END;

CREATE TRIGGER chunks_after_update AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, heading, content)
  VALUES ('delete', old.id, old.heading, old.content);
  INSERT INTO chunks_fts (rowid, heading, content)
  VALUES (new.id, new.heading, new.content);
END;

-- ---------------------------------------------------------------------------
-- ingestion_runs: makes ingestion observable
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_runs (
  id            INTEGER PRIMARY KEY,
  trigger       TEXT    NOT NULL CHECK (trigger IN ('cli', 'api', 'startup')),
  status        TEXT    NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  docs_total    INTEGER NOT NULL DEFAULT 0,
  docs_indexed  INTEGER NOT NULL DEFAULT 0,
  docs_updated  INTEGER NOT NULL DEFAULT 0,
  docs_skipped  INTEGER NOT NULL DEFAULT 0,
  docs_deleted  INTEGER NOT NULL DEFAULT 0,
  docs_failed   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  started_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at   TEXT
);

CREATE INDEX ingestion_runs_started_idx ON ingestion_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- search_queries: analytics for the dashboard
--
-- `abstained` is the interesting column. A rising abstain rate is not a fault
-- report on the retriever, it is a list of documents the corpus is missing.
-- ---------------------------------------------------------------------------
CREATE TABLE search_queries (
  id           INTEGER PRIMARY KEY,
  -- Nullable, and no foreign key yet: the auth tables arrive in a later
  -- migration and Better Auth issues text ids.
  user_id      TEXT,
  source       TEXT    NOT NULL CHECK (source IN ('web', 'mcp')),
  query        TEXT    NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  top_score    REAL,
  abstained    INTEGER NOT NULL DEFAULT 0 CHECK (abstained IN (0, 1)),
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX search_queries_created_idx ON search_queries (created_at DESC);
CREATE INDEX search_queries_user_idx    ON search_queries (user_id);
