-- Refuse an in-place edit of a chunk's text.
--
-- `chunks_after_update` in migration 001 keeps chunks_fts in step with an UPDATE, and
-- cannot keep chunks_vec in step, because a new embedding is a network call and SQL has no
-- way to make one. Its sibling `chunks_after_delete` does delete the vec row, so the gap
-- was only on this path. The result of an UPDATE was therefore a chunk whose keyword arm
-- returned the new text while the vector arm ranked it by the embedding of the old — the
-- two arms of one retriever disagreeing about what a passage says, with nothing anywhere
-- reporting a fault. Exactly the failure §8.4 of the working agreement says to test for,
-- and the one the trigger did not cover.
--
-- Refused rather than repaired, and nothing is lost by that: the pipeline never updates a
-- chunk. `replaceChunks` deletes a document's rows and reinserts them, which is what makes
-- its invariant statable — a document's chunks always reflect exactly one version of the
-- file — and it is the only supported mutation. So this forbids an operation no caller
-- performs and converts a silent corruption into a loud error at the point of the mistake.
--
-- The alternative was deleting the stale vector, leaving the chunk keyword-only and the
-- divergence visible as chunks ≠ embeddings on the dashboard's index-health panel. That
-- turns a wrong answer into a degraded one, which is better, but it still leaves the
-- caller believing an update succeeded when the passage is now half-indexed.
--
-- Scoped `OF content, heading` and guarded on a real change, so the columns that carry no
-- embedding — token_count, ordinal — stay writable, and an idempotent rewrite of identical
-- text is not an error.
CREATE TRIGGER chunks_before_content_update
BEFORE UPDATE OF content, heading ON chunks
WHEN new.content IS NOT old.content OR new.heading IS NOT old.heading
BEGIN
  SELECT RAISE(
    ABORT,
    'Chunk text cannot be updated in place: the stored vector would keep the old embedding. Delete the document''s chunks and reinsert them (see replaceChunks).'
  );
END;
