'use client';

import { useEffect, useRef } from 'react';
import { documentDetailSchema } from '@hatko/shared';
import { formatBytes, formatDateTime } from '../../../lib/format.ts';
import { useApi } from '../../../lib/use-api.ts';
import { Badge, ErrorCard, Eyebrow, SkeletonLine } from '../../../components/ui.tsx';

/**
 * The document behind a point in the embedding plot.
 *
 * A native `<dialog>` opened with `showModal()`, which is the whole reason there is no
 * focus-trap code, no Escape handler, no `aria-modal`, and no scroll lock here: the
 * platform does all five, correctly, including returning focus to the canvas on close. A
 * hand-rolled overlay would be forty lines to reimplement that and would get the focus
 * return wrong.
 *
 * It shows the passage text, not a summary of it. The plot's claim is that distance in
 * this space is distance in the space retrieval searches — and the only way to judge that
 * claim is to open two neighbours and read them. A card listing metadata would leave the
 * reader exactly where they started.
 */
export function DocumentDialog({
  documentId,
  title,
  onClose,
}: {
  documentId: number;
  title: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const detail = useApi(`/api/admin/documents/${documentId}`, documentDetailSchema);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // `showModal` rather than the `open` attribute: only the former makes it modal, puts
    // it in the top layer, and enables Escape.
    if (!dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // The backdrop is a real element, so a click outside is a click on the dialog itself
      // — anywhere its own content is not. Cheaper than measuring the content box.
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby="document-dialog-title"
      className="w-[min(92vw,68ch)] border border-rule-strong bg-bg p-0 text-text backdrop:bg-bg-sunken/80"
    >
      <div className="max-h-[80vh] overflow-y-auto p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <Eyebrow as="h2" id="document-dialog-title">
            {detail.data?.document.title ?? title}
          </Eyebrow>
          {/*
           * `formMethod="dialog"` closes it without JavaScript, which also means the button
           * keeps working if the effect above ever fails to run.
           */}
          <form method="dialog">
            <button
              type="submit"
              className="shrink-0 border border-border-interactive px-2 py-1 text-caption text-text-muted outline-none hover:text-text focus-visible:border-brand"
            >
              Close
            </button>
          </form>
        </div>

        {detail.error ? (
          <div className="mt-4">
            <ErrorCard
              title="Could not load that document."
              detail={detail.error}
              onRetry={detail.reload}
            />
          </div>
        ) : !detail.data ? (
          <div className="mt-4">
            <SkeletonLine className="w-1/2" />
            <SkeletonLine className="mt-3 w-full" />
            <SkeletonLine className="mt-3 w-5/6" />
          </div>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge>{detail.data.document.category}</Badge>
              {detail.data.document.isDeprecated && <Badge>deprecated</Badge>}
              <span className="text-mono break-all font-mono text-text-muted">
                {detail.data.document.sourcePath}
              </span>
            </div>

            <p className="mt-2 text-caption text-text-muted">
              {formatBytes(detail.data.document.byteSize)} ·{' '}
              {detail.data.chunks.length === 1
                ? '1 passage'
                : `${detail.data.chunks.length} passages`}
              {detail.data.document.indexedAt &&
                ` · indexed ${formatDateTime(detail.data.document.indexedAt)}`}
            </p>

            {detail.data.chunks.map((chunk) => (
              <section key={chunk.id} className="mt-4 border-t border-rule pt-4">
                {chunk.heading && (
                  <p className="text-caption uppercase tracking-wide text-text-muted">
                    {chunk.heading}
                  </p>
                )}
                {/*
                 * `whitespace-pre-wrap`, because these are markdown passages and their line
                 * breaks are part of what was indexed. Rendering them as flowed prose would
                 * show something other than the text the retriever matched on.
                 */}
                <p className="mt-1 whitespace-pre-wrap text-body-sm text-text">{chunk.content}</p>
                <p className="mt-2 text-caption text-text-muted">{chunk.tokenCount} tokens</p>
              </section>
            ))}
          </>
        )}
      </div>
    </dialog>
  );
}
