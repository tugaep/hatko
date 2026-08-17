-- Drop search_queries_user_idx2.
--
-- Migration 003 added it while recording, in a comment, that search_queries.user_id
-- deliberately has no foreign key to the user table: analytics rows are retained
-- when a user is deleted, and SQLite cannot add a constraint to an existing table
-- without rebuilding it. The reasoning was worth keeping. The index was not — it is
-- byte-for-byte identical to search_queries_user_idx from migration 001, so every
-- write to the table maintained the same B-tree twice to carry a note that the SQL
-- comment beside it already carries.
DROP INDEX IF EXISTS search_queries_user_idx2;
