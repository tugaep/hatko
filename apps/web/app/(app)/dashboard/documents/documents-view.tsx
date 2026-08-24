import { EmbeddingPanel } from '../embedding-panel.tsx';
import { DocumentsPanel } from '../documents-panel.tsx';

/**
 * The corpus as the retriever sees it, then the corpus as a list.
 *
 * The projection comes first because it shows the problem the retrieval design is built
 * around: near-identical documents collapse into one indistinguishable cluster,
 * which is why the lexical arm exists and why fusion is worth the code. Read the table
 * first and the corpus looks like a pile of unrelated files with no reason for any of it.
 *
 * The list then answers what the picture cannot: which document, indexed when, and did it
 * fail. It brings its own heading, so it gets none from here. The category breakdown that
 * used to sit between the two is gone, because the plot already says which categories
 * exist and how tightly each one clusters.
 */
export function DocumentsView() {
  return (
    <div className="grid gap-12">
      <EmbeddingPanel />

      {/*
       * Neither panel takes a wrapper heading. Each is already a labelled section that
       * names itself, so a `Group` around either one says the same word at two ranks:
       * "Corpus" over a list whose own heading says Documents, or "Embedding space" over a
       * card saying exactly that. The category column a "Corpus" heading would promise is
       * covered better by the plot, in colour, for every passage at once.
       */}
      <DocumentsPanel />
    </div>
  );
}
