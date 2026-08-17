'use client';

import { useEffect, useState } from 'react';
import {
  documentSchema,
  documentStatusSchema,
  paginated,
  type Document,
  type DocumentStatus,
} from '@hatko/shared';
import { catalogNumber, formatBytes, formatDateTime } from '../../../lib/format.ts';
import { useApi } from '../../../lib/use-api.ts';
import { SeedSpecimen } from '../../../components/marks.tsx';
import {
  Badge,
  Button,
  ErrorCard,
  Input,
  LabelFrame,
  SkeletonLine,
  cx,
} from '../../../components/ui.tsx';

/**
 * The corpus, as rows.
 *
 * Filtering and paging happen on the server — `listDocumentsFiltered` already does both,
 * and fetching 142 rows to filter four of them in the browser is the kind of shortcut
 * that stops working at the first real corpus.
 */

const documentPageSchema = paginated(documentSchema);

const PAGE_SIZE = 25;

/** Long enough that a typed word is one request, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

const STATUS_TONE: Record<DocumentStatus, 'brand' | 'attention' | 'danger'> = {
  indexed: 'brand',
  pending: 'attention',
  failed: 'danger',
};

export function DocumentsPanel() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [offset, setOffset] = useState(0);

  // Typing should not fire a request per character.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Any filter change invalidates the current page number.
  useEffect(() => setOffset(0), [debounced, status]);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);

  const page = useApi(`/api/admin/documents?${params.toString()}`, documentPageSchema);
  const total = page.data?.total ?? 0;

  return (
    <section aria-label="Documents" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-h2 text-text">Documents</h2>
          <p className="mt-1 text-body-sm text-text-muted">
            {page.data
              ? `${total.toLocaleString('en-GB')} matching, showing ${page.data.items.length}`
              : 'Loading the corpus…'}
          </p>
        </div>

        <div className="flex w-full gap-2 sm:w-auto">
          <label htmlFor="doc-filter" className="sr-only">
            Filter by title or path
          </label>
          <Input
            id="doc-filter"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title or path"
            maxLength={200}
            className="sm:w-64"
          />
          <label htmlFor="doc-status" className="sr-only">
            Filter by status
          </label>
          <select
            id="doc-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as DocumentStatus | '')}
            className="h-10 rounded-sm border border-border-interactive bg-bg-raised px-2 text-body-sm text-text"
          >
            <option value="">All statuses</option>
            {documentStatusSchema.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {page.error ? (
        <ErrorCard title="Could not load documents." detail={page.error} onRetry={page.reload} />
      ) : page.data === null ? (
        <TableSkeleton />
      ) : page.data.items.length === 0 ? (
        <EmptyCorpus filtered={debounced !== '' || status !== ''} />
      ) : (
        <>
          {/* A data table below `md` is a failure state, so the same rows render as cards. */}
          <ul className="grid gap-3 md:hidden">
            {page.data.items.map((doc) => (
              <li key={doc.id}>
                <DocumentCard doc={doc} />
              </li>
            ))}
          </ul>

          <div className="hidden border border-rule bg-bg-raised md:block">
            <table className="w-full border-collapse text-body-sm">
              <caption className="sr-only">
                Indexed documents with status, category and passage count
              </caption>
              <thead>
                <tr className="border-b border-rule-strong text-left">
                  <Th>Document</Th>
                  <Th className="hidden lg:table-cell">Category</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Passages</Th>
                  <Th className="hidden text-right lg:table-cell">Size</Th>
                  <Th className="text-right">Indexed</Th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((doc) => (
                  <tr
                    key={doc.id}
                    className="border-b border-rule transition-colors duration-120 ease-brand last:border-0 hover:bg-bg-sunken"
                  >
                    <Td>
                      <span className="block font-medium text-text">{doc.title}</span>
                      <span className="text-mono block truncate font-mono text-text-muted">
                        {doc.sourcePath}
                      </span>
                    </Td>
                    <Td className="hidden lg:table-cell">
                      <span className="text-caption text-text-muted">{doc.category}</span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={STATUS_TONE[doc.status]}>{doc.status}</Badge>
                        {doc.isDeprecated && <Badge tone="danger">deprecated</Badge>}
                      </div>
                    </Td>
                    <Td className="tabular text-right font-mono">{doc.chunkCount}</Td>
                    <Td className="tabular hidden text-right font-mono lg:table-cell">
                      {formatBytes(doc.byteSize)}
                    </Td>
                    <Td className="tabular text-right font-mono text-text-muted">
                      {doc.indexedAt ? formatDateTime(doc.indexedAt) : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            offset={offset}
            total={total}
            shown={page.data.items.length}
            onChange={setOffset}
          />
        </>
      )}
    </section>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={cx('text-eyebrow px-4 py-2.5 uppercase text-text-muted', className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cx('max-w-xs px-4 py-3 align-top text-text', className)}>{children}</td>;
}

function DocumentCard({ doc }: { doc: Document }) {
  return (
    <LabelFrame
      catalog={catalogNumber('DOC', doc.id)}
      interactive
      title={
        <>
          <h3 className="text-h4 text-text">{doc.title}</h3>
          <p className="text-mono mt-0.5 truncate font-mono text-text-muted">{doc.sourcePath}</p>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONE[doc.status]}>{doc.status}</Badge>
        <Badge>{doc.category}</Badge>
        {doc.isDeprecated && <Badge tone="danger">deprecated</Badge>}
      </div>
      <p className="text-mono-label tabular mt-3 font-mono text-text-muted">
        {doc.chunkCount} passages · {formatBytes(doc.byteSize)} ·{' '}
        {doc.indexedAt ? formatDateTime(doc.indexedAt) : 'not indexed'}
      </p>
      {doc.error && (
        <p className="mt-2 border border-danger bg-danger-subtle p-2 text-caption text-text">
          {doc.error}
        </p>
      )}
    </LabelFrame>
  );
}

function Pagination({
  offset,
  total,
  shown,
  onChange,
}: {
  offset: number;
  total: number;
  shown: number;
  onChange: (offset: number) => void;
}) {
  const last = offset + shown;
  if (total <= PAGE_SIZE) return null;

  return (
    <nav className="flex items-center justify-between gap-4" aria-label="Document pages">
      <p className="text-mono-label tabular font-mono uppercase text-text-muted">
        {offset + 1}–{last} of {total}
      </p>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={last >= total}
          onClick={() => onChange(offset + PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

function EmptyCorpus({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center border border-rule bg-bg-raised px-6 py-12 text-center">
      <SeedSpecimen />
      <h3 className="font-display text-h3 mt-4 text-text">
        {filtered ? 'No documents match that filter.' : 'Nothing indexed yet.'}
      </h3>
      <p className="mt-2 max-w-[46ch] text-body-sm text-text-muted">
        {filtered
          ? 'Clear the filter to see the whole corpus.'
          : 'Point CORPUS_PATH at a directory of markdown files and run ingestion.'}
      </p>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="border border-rule bg-bg-raised p-4">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="flex items-center gap-4 border-b border-rule py-3 last:border-0">
          <SkeletonLine className="w-1/3" />
          <SkeletonLine className="w-20" />
          <SkeletonLine className="ml-auto w-16" />
        </div>
      ))}
    </div>
  );
}
