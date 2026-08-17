'use client';

import { useEffect, useState } from 'react';
import {
  CATEGORY_UNCATEGORISED,
  documentSchema,
  documentStatusSchema,
  paginated,
  type DocumentSort,
  type DocumentStatus,
  type SortDirection,
} from '@hatko/shared';
import { catalogNumber, formatBytes, formatDateTime } from '../../../lib/format.ts';
import { useApi } from '../../../lib/use-api.ts';
import { SeedSpecimen } from '../../../components/marks.tsx';
import { Badge, Button, ErrorCard, Input, SkeletonLine, cx } from '../../../components/ui.tsx';

/**
 * The corpus, as rows.
 *
 * Filtering, sorting and paging all happen on the server — `listDocumentsFiltered` does
 * all three, and fetching 142 rows to sort them in the browser is the kind of shortcut
 * that stops working at the first real corpus.
 *
 * One markup tree serves both layouts. The `table-cards` utility turns each row into a
 * bordered card below `md`, where a horizontally scrolling table would be a failure state.
 * Rendering the rows twice and hiding one set was the first approach, and it meant every
 * row's content existed in two places.
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

/**
 * The columns, and which of them sort.
 *
 * `sort` is a key from the shared `documentSortSchema`, never a column name — the
 * repository owns that translation, because `ORDER BY` cannot be parameterised. A column
 * with no `sort` key renders as a plain header and cannot be clicked.
 */
const COLUMNS: {
  label: string;
  sort?: DocumentSort;
  align?: 'right';
  hideBelow?: 'lg';
}[] = [
  // Sorts by path, not title, so the header reflects the default ordering rather than
  // leaving every column marked `aria-sort="none"` on a table that is in fact sorted. Path
  // also groups the corpus by directory, and for this corpus the two orderings barely
  // differ: `Build Pipeline` lives at `build-pipeline.md`.
  { label: 'Document', sort: 'sourcePath' },
  { label: 'Category', sort: 'category', hideBelow: 'lg' },
  { label: 'Status', sort: 'status' },
  { label: 'Passages', sort: 'chunkCount', align: 'right' },
  { label: 'Size', sort: 'byteSize', align: 'right', hideBelow: 'lg' },
  { label: 'Indexed', sort: 'indexedAt', align: 'right' },
];

export function DocumentsPanel() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [sort, setSort] = useState<DocumentSort>('sourcePath');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [offset, setOffset] = useState(0);

  // Typing should not fire a request per character.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Any change to what is being selected invalidates the current page number.
  useEffect(() => setOffset(0), [debounced, status, sort, direction]);

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
    sort,
    direction,
  });
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);

  const page = useApi(`/api/admin/documents?${params.toString()}`, documentPageSchema);
  const total = page.data?.total ?? 0;

  /**
   * Clicking a header sorts by it ascending; clicking the active one reverses it.
   *
   * Descending-first would be right for a magnitude column and wrong for a name, and the
   * table has both, so it does the predictable thing rather than the clever thing.
   */
  function toggleSort(next: DocumentSort) {
    if (next === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(next);
    setDirection('asc');
  }

  return (
    <section aria-labelledby="documents-heading" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="documents-heading" className="font-display text-h2 text-text">
            Documents
          </h2>
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

      {/*
       * Below `md` the sort control cannot be a column header, because there are no visible
       * headers. A select is the same operation in the shape that fits.
       */}
      <div className="flex items-center gap-2 md:hidden">
        <label htmlFor="doc-sort" className="text-caption text-text-muted">
          Sort by
        </label>
        <select
          id="doc-sort"
          value={`${sort}:${direction}`}
          onChange={(event) => {
            const [nextSort, nextDirection] = event.target.value.split(':');
            setSort(nextSort as DocumentSort);
            setDirection(nextDirection as SortDirection);
          }}
          className="h-10 flex-1 rounded-sm border border-border-interactive bg-bg-raised px-2 text-body-sm text-text"
        >
          {COLUMNS.filter((column) => column.sort).flatMap((column) =>
            (['asc', 'desc'] as const).map((option) => (
              <option key={`${column.sort}:${option}`} value={`${column.sort}:${option}`}>
                {column.label}
                {option === 'asc' ? ' ↑' : ' ↓'}
              </option>
            )),
          )}
        </select>
      </div>

      {page.error ? (
        <ErrorCard title="Could not load documents." detail={page.error} onRetry={page.reload} />
      ) : page.data === null ? (
        <TableSkeleton />
      ) : page.data.items.length === 0 ? (
        <EmptyCorpus filtered={debounced !== '' || status !== ''} />
      ) : (
        <>
          {/* The border belongs to the table container at `md`+, and to each card below it. */}
          <div className="md:border md:border-rule md:bg-bg-raised">
            <table className="table-cards text-body-sm">
              <caption className="sr-only">
                Indexed documents with status, category, passage count and index date. Sortable by
                every column except the document itself.
              </caption>
              <thead>
                <tr className="border-b border-rule-strong text-left">
                  {COLUMNS.map((column) => (
                    <SortableTh
                      key={column.label}
                      column={column}
                      active={column.sort === sort}
                      direction={direction}
                      onSort={toggleSort}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((doc) => (
                  <tr key={doc.id} className="border-b border-rule last:border-0">
                    <Td label="Document">
                      <span className="block font-medium text-text">{doc.title}</span>
                      <span className="text-mono path block font-mono text-text-muted">
                        {doc.sourcePath}
                      </span>
                      <span className="text-mono-label mt-0.5 block font-mono uppercase text-text-muted">
                        {catalogNumber('DOC', doc.id)}
                      </span>
                      {/*
                       * A failed document's reason, in the row it belongs to and in the widest
                       * column. The table used to omit it entirely and show it only on the
                       * mobile card, so the desktop view of a broken corpus looked healthy.
                       */}
                      {doc.error && (
                        <span className="mt-2 block border border-danger bg-danger-subtle p-2 text-caption text-text">
                          {doc.error}
                        </span>
                      )}
                    </Td>
                    <Td label="Category" hideBelow="lg">
                      <span className="text-caption text-text-muted">{doc.category}</span>
                    </Td>
                    <Td label="Status">
                      <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                        <Badge tone={STATUS_TONE[doc.status]}>{doc.status}</Badge>
                        {doc.isDeprecated && <Badge tone="danger">deprecated</Badge>}
                      </span>
                    </Td>
                    <Td label="Passages" align="right">
                      <span className="tabular font-mono">{doc.chunkCount}</span>
                    </Td>
                    <Td label="Size" align="right" hideBelow="lg">
                      <span className="tabular font-mono">{formatBytes(doc.byteSize)}</span>
                    </Td>
                    <Td label="Indexed" align="right">
                      <span className="tabular font-mono text-text-muted">
                        {doc.indexedAt ? formatDateTime(doc.indexedAt) : 'never'}
                      </span>
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

/**
 * A column header that sorts, or a plain one that does not.
 *
 * `aria-sort` on the header is what tells a screen reader the table is ordered and by
 * which column; the arrow alone says it only to people who can see it.
 */
function SortableTh({
  column,
  active,
  direction,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  active: boolean;
  direction: SortDirection;
  onSort: (sort: DocumentSort) => void;
}) {
  const classes = cx(
    'text-eyebrow px-4 py-2.5 uppercase text-text-muted',
    column.align === 'right' && 'text-right',
    column.hideBelow === 'lg' && 'hidden lg:table-cell',
  );

  if (!column.sort) {
    return (
      <th scope="col" className={classes}>
        {column.label}
      </th>
    );
  }

  const sortKey = column.sort;
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx(classes, 'p-0')}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cx(
          'text-eyebrow flex w-full items-center gap-1.5 px-4 py-2.5 uppercase',
          'transition-colors duration-120 ease-brand hover:bg-bg-sunken hover:text-text',
          active ? 'text-text' : 'text-text-muted',
          column.align === 'right' && 'justify-end',
        )}
      >
        {column.label}
        {/*
         * The arrow occupies its slot whether or not this column is active, so the header
         * row does not reflow by a few pixels every time the sort moves.
         */}
        <span aria-hidden="true" className={cx('w-2', !active && 'opacity-0')}>
          {direction === 'asc' ? '↑' : '↓'}
        </span>
      </button>
    </th>
  );
}

function Td({
  label,
  children,
  align,
  hideBelow,
}: {
  /** Doubles as the cell's own label below `md`, via `data-label`. */
  label: string;
  children: React.ReactNode;
  align?: 'right';
  hideBelow?: 'lg';
}) {
  return (
    <td
      data-label={label}
      className={cx(
        'max-w-xs px-4 py-3 align-top text-text',
        // Alignment applies from `md` up only: below that the cell is a flex row whose
        // label and value are pushed apart, and a `text-right` would fight it.
        align === 'right' && 'md:text-right',
        // Card row below `md`, dropped in the narrow table, back at `lg`.
        hideBelow === 'lg' && 'max-lg:md:hidden',
      )}
    >
      {children}
    </td>
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
        {offset + 1}-{last} of {total}
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
