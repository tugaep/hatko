import { EmbeddingPanel } from '../embedding-panel.tsx';
import { DocumentsPanel } from '../documents-panel.tsx';

/**
 * The corpus, shown as the retriever sees it before it is shown as a list.
 *
 * The embedding projection is first, and that ordering is the argument this whole
 * retriever rests on: 78 near-identical delivery reports collapse into one
 * indistinguishable cluster, which is why the lexical arm exists and why fusion is not
 * over-engineering. Read the table first and the corpus looks like 142 unrelated files;
 * see the cluster first and every later decision has a reason attached.
 *
 * The list then answers the questions the picture cannot: which document, indexed when,
 * and did it fail. It carries no heading of its own from here — it brings one — and the
 * category breakdown that used to sit between the two is gone, because the plot already
 * says which categories exist and how tightly each one clusters.
 */
export function DocumentsView() {
  return (
    <div className="grid gap-12">
      <EmbeddingPanel />

      {/*
       * Neither panel takes a wrapper heading. Each is already a labelled section that
       * names itself, so a `Group` around either one repeated its words at two ranks —
       * "Corpus" over a list whose own heading says Documents, and "Embedding space" over
       * a card saying exactly that. The category column "Corpus" promised is also stated
       * better by the plot, in colour, for all 142 passages at once.
       */}
      <DocumentsPanel />
    </div>
  );
}
