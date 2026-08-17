'use client';

import { dashboardStatsSchema, type DashboardStats, type IndexHealth } from '@hatko/shared';
import { formatBytes, formatDateTime, formatMs, formatPercent } from '../../../lib/format.ts';
import { useApi } from '../../../lib/use-api.ts';
import {
  Badge,
  Button,
  ErrorCard,
  Eyebrow,
  LabelFrame,
  SkeletonLine,
  cx,
} from '../../../components/ui.tsx';
import { ApiKeyPanel } from './api-key-panel.tsx';
import { DocumentsPanel } from './documents-panel.tsx';
import { IngestionPanel } from './ingestion-panel.tsx';

/**
 * The admin surface: what is indexed, whether the last ingest was clean, and what people
 * are asking. Each panel loads independently, so one failing endpoint leaves the rest of
 * the page usable rather than blanking it.
 */
export function Dashboard() {
  const stats = useApi('/api/admin/stats', dashboardStatsSchema);

  return (
    <div className="grid gap-12 py-6 pb-[calc(var(--nav-h)+3rem)] sm:py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-h1 text-text">Dashboard</h1>
          <p className="mt-2 max-w-[60ch] text-body-sm text-text-muted">
            Corpus, index health, ingestion history and search behaviour.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={stats.reload} loading={stats.loading}>
          Refresh
        </Button>
      </header>

      {stats.error ? (
        <ErrorCard title="Could not load statistics." detail={stats.error} onRetry={stats.reload} />
      ) : (
        <>
          <StatTiles stats={stats.data} />

          {/* `items-start` so each card keeps its own height — a stretched card with dead
              space at the bottom reads as a rendering bug. */}
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <IndexHealthPanel health={stats.data?.index ?? null} />
            <ApiKeyPanel />
          </div>

          <IngestionPanel onIngested={stats.reload} />
          <DocumentsPanel />
          <SearchStatsPanel search={stats.data?.search ?? null} />
          <CategoryPanel byCategory={stats.data?.byCategory ?? null} />
        </>
      )}
    </div>
  );
}

// --- stat tiles -------------------------------------------------------------

function StatTiles({ stats }: { stats: DashboardStats | null }) {
  const tiles = stats
    ? [
        {
          label: 'Documents indexed',
          value: stats.index.documentsIndexed.toLocaleString('en-GB'),
          note: `of ${stats.index.documentsTotal.toLocaleString('en-GB')} in the corpus`,
          catalog: 'IDX-01',
        },
        {
          label: 'Passages',
          value: stats.index.chunksTotal.toLocaleString('en-GB'),
          note: `${stats.index.avgChunksPerDocument.toFixed(2)} per document`,
          catalog: 'IDX-02',
        },
        {
          label: 'Abstain rate',
          value: formatPercent(stats.search.abstainRate),
          note: `${stats.search.queriesTotal.toLocaleString('en-GB')} queries recorded`,
          catalog: 'QRY-01',
        },
        {
          label: 'p95 latency',
          value: formatMs(stats.search.p95LatencyMs),
          note: `${formatMs(stats.search.avgLatencyMs)} mean`,
          catalog: 'QRY-02',
        },
      ]
    : null;

  return (
    <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles
        ? tiles.map((tile, i) => (
            <LabelFrame
              key={tile.label}
              catalog={tile.catalog}
              // The notch is the tear-open-packet motif; at most one element per view gets it.
              notch={i === 0}
              title={<Eyebrow>{tile.label}</Eyebrow>}
            >
              <p className="font-display text-h1 tabular text-text">{tile.value}</p>
              <p className="mt-1 text-caption text-text-muted">{tile.note}</p>
            </LabelFrame>
          ))
        : [0, 1, 2, 3].map((i) => (
            <LabelFrame key={i}>
              <SkeletonLine className="w-24" />
              <SkeletonLine className="mt-3 h-7 w-16" />
              <SkeletonLine className="mt-3 w-32" />
            </LabelFrame>
          ))}
    </section>
  );
}

// --- index health -----------------------------------------------------------

/**
 * A torn index is the failure this panel exists to catch: chunks and embeddings are
 * written to two physical stores, and a count that diverges means retrieval is quietly
 * missing passages. It is stated in words, not left to be inferred from two numbers.
 */
function IndexHealthPanel({ health }: { health: IndexHealth | null }) {
  if (!health) {
    return (
      <LabelFrame catalog="IDX-00" title={<Eyebrow>Index health</Eyebrow>}>
        <SkeletonLine className="w-full" />
        <SkeletonLine className="mt-3 w-3/4" />
        <SkeletonLine className="mt-3 w-2/3" />
      </LabelFrame>
    );
  }

  const torn = health.chunksTotal !== health.embeddingsTotal;

  return (
    <LabelFrame catalog="IDX-00" title={<Eyebrow>Index health</Eyebrow>}>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="brand">{health.documentsIndexed} indexed</Badge>
        {health.documentsPending > 0 && (
          <Badge tone="attention">{health.documentsPending} pending</Badge>
        )}
        {health.documentsFailed > 0 && <Badge tone="danger">{health.documentsFailed} failed</Badge>}
        {health.documentsDeprecated > 0 && (
          <Badge tone="danger">{health.documentsDeprecated} deprecated</Badge>
        )}
      </div>

      {torn && (
        <p className="mt-3 border border-danger bg-danger-subtle p-2 text-caption text-text">
          <span className="font-semibold">Index is torn.</span> {health.chunksTotal} passages but{' '}
          {health.embeddingsTotal} embeddings — vector search is missing rows. Re-run ingestion with
          force.
        </p>
      )}

      <dl className="mt-4 grid gap-2 border-t border-rule pt-3">
        <Row label="Vector rows">
          <span className={cx('tabular', torn && 'text-danger-text')}>
            {health.embeddingsTotal.toLocaleString('en-GB')} /{' '}
            {health.chunksTotal.toLocaleString('en-GB')}
          </span>
        </Row>
        <Row label="Database size">
          <span className="tabular">{formatBytes(health.databaseBytes)}</span>
        </Row>
        <Row label="Last ingestion">
          {health.lastRun ? (
            <span className="tabular">
              {formatDateTime(health.lastRun.startedAt)} · {health.lastRun.status}
            </span>
          ) : (
            'never'
          )}
        </Row>
      </dl>
    </LabelFrame>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-mono font-mono text-text">{children}</dd>
    </div>
  );
}

// --- search stats -----------------------------------------------------------

/** Below this many days the series is too short to draw honestly. */
const MIN_SERIES_POINTS = 7;

function SearchStatsPanel({ search }: { search: DashboardStats['search'] | null }) {
  if (!search) {
    return (
      <section aria-label="Search statistics">
        <LabelFrame catalog="QRY-00" title={<Eyebrow>Search</Eyebrow>}>
          <SkeletonLine className="w-2/3" />
          <SkeletonLine className="mt-3 w-1/2" />
        </LabelFrame>
      </section>
    );
  }

  const peak = Math.max(1, ...search.volumeByDay.map((day) => day.count));

  return (
    <section aria-label="Search statistics" className="grid gap-6 lg:grid-cols-2">
      <LabelFrame catalog="QRY-03" title={<Eyebrow>Most asked</Eyebrow>}>
        {search.topQueries.length === 0 ? (
          <p className="text-body-sm text-text-muted">No queries recorded yet.</p>
        ) : (
          <ol className="grid gap-2">
            {search.topQueries.map((entry) => (
              <li
                key={entry.query}
                className="flex items-baseline justify-between gap-4 border-b border-rule pb-2 last:border-0 last:pb-0"
              >
                <span className="min-w-0 text-body-sm text-text">{entry.query}</span>
                <span className="text-mono-label tabular shrink-0 font-mono text-text-muted">
                  {entry.count}×{entry.abstainedCount > 0 && ` · ${entry.abstainedCount} abstained`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </LabelFrame>

      <div className="grid gap-6">
        {/*
         * The gap list. Questions the corpus could not answer are the shortlist of
         * documents worth writing, which makes this the most actionable panel here.
         */}
        <LabelFrame catalog="QRY-04" title={<Eyebrow>Not covered by the corpus</Eyebrow>}>
          {search.recentAbstains.length === 0 ? (
            <p className="text-body-sm text-text-muted">
              Every recorded query found supporting passages.
            </p>
          ) : (
            <ul className="grid gap-2">
              {search.recentAbstains.map((entry, i) => (
                <li key={`${entry.createdAt}-${i}`} className="text-body-sm text-text">
                  {entry.query}
                  <span className="text-mono-label ml-2 font-mono text-text-muted">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </LabelFrame>

        {/* Under seven points a bar chart implies a trend that isn't there. */}
        {search.volumeByDay.length >= MIN_SERIES_POINTS && (
          <LabelFrame catalog="QRY-05" title={<Eyebrow>Queries per day</Eyebrow>}>
            <div aria-hidden="true" className="flex h-16 items-end gap-1">
              {search.volumeByDay.map((day) => (
                <span
                  key={day.day}
                  className="flex h-full flex-1 flex-col justify-end bg-bg-sunken"
                >
                  <span
                    className="block w-full bg-brand"
                    // A zero-count day still needs to be visible as a day, so the floor is 2px.
                    style={{ height: `max(2px, ${Math.round((day.count / peak) * 100)}%)` }}
                  />
                </span>
              ))}
            </div>
            <p className="text-mono-label tabular mt-2 font-mono uppercase text-text-muted">
              {search.volumeByDay.length} days · peak {peak} · {search.queriesLast7Days} in the last
              7
            </p>
          </LabelFrame>
        )}
      </div>
    </section>
  );
}

function CategoryPanel({ byCategory }: { byCategory: DashboardStats['byCategory'] | null }) {
  if (!byCategory || byCategory.length === 0) return null;
  const most = Math.max(...byCategory.map((row) => row.documents));

  return (
    <section aria-label="Corpus by category">
      <LabelFrame catalog="IDX-03" title={<Eyebrow>Documents by category</Eyebrow>}>
        <ul className="grid gap-3">
          {byCategory.map((row) => (
            <li key={row.category} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-body-sm text-text">{row.category}</span>
                <span className="text-mono-label tabular font-mono text-text-muted">
                  {row.documents} docs · {row.chunks} passages
                </span>
              </div>
              <span aria-hidden="true" className="block h-[3px] bg-bg-sunken">
                <span
                  className="block h-full bg-brand"
                  style={{ width: `${Math.round((row.documents / most) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      </LabelFrame>
    </section>
  );
}
