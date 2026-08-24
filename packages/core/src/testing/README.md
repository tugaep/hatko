Not a corpus sample — a fixture.

Four documents that exist to exercise ingestion mechanics no real corpus can be
relied on to contain: a document that declares itself superseded, the document
that replaced it, a second category, and a file at the root with no directory to
take a category from.

The tests that use it assert plumbing — that a deprecation flag survives ingest,
search and the answer prompt, and that categories come from directory names.
Pointing those at the live corpus made them fail the moment the corpus was
replaced, for reasons that had nothing to do with the code under test.

Tests that measure retrieval behaviour still run against the real corpus, because
there the corpus *is* the thing under test.
