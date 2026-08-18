import { EmbeddingPanel } from '../embedding-panel.tsx';
import { DocumentsPanel } from '../documents-panel.tsx';
import { Group } from '../panels.tsx';

/**
 * The corpus, shown as the retriever sees it before it is shown as a list.
 *
 * The embedding projection is first, and that ordering is the argument this whole
 * retriever rests on: 78 near-identical delivery reports collapse into one
 * indistinguishable cluster, which is why the lexical arm exists and why fusion is not
 * over-engineering. Read the table first and the corpus looks like 142 unrelated files;
 * see the cluster first and every later decision has a reason attached.
 *
 * The list then answers the questions the picture cannot: which document, what category,
 * indexed when, and did it fail. The category breakdown that sat between them is gone —
 * the same counts are one column of that list, so it was a second answer to a question
 * already answered on the page.
 */
export function DocumentsView() {
  return (
    <div className="grid gap-12">
      <Group
        title="Embedding space"
        description="Every indexed passage, projected to three dimensions. Distance is similarity."
      >
        <EmbeddingPanel />
      </Group>

      <Group title="Corpus" description="Every indexed document, with its category and status.">
        <DocumentsPanel />
      </Group>
    </div>
  );
}
