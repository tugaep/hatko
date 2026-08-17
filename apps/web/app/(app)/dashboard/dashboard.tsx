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
          {/*
           * Two heading sizes, and now they mean two different ranks.
           *
           * Before this, `Ingestion` and `Documents` were 24px Fraunces while `Index health`
           * and `Provider key` were 12px uppercase labels *inside* cards — the same rank
           * drawn at opposite volumes, which reads as inconsistency rather than hierarchy.
           * The fix is not to pick one size: it is that the four groups below really are
           * sections, and the cards inside them really are subordinate. Now the outline is
           * h1 → h2 (section) → h3 (panel), which is also the order a screen reader walks.
           */}
          <Group title="Index">
            <StatTiles stats={stats.data} />
            {/* `items-start` so each card keeps its own height — a stretched card with dead
                space at the bottom reads as a rendering bug. */}
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <IndexHealthPanel health={stats.data?.index ?? null} />
              <ApiKeyPanel />
            </div>
            <CategoryPanel byCategory={stats.data?.byCategory ?? null} />
          </Group>

          <IngestionPanel onIngested={stats.reload} />
          <DocumentsPanel />

          <Group
            title="Search"
            description="What people ask, and what the corpus could not answer."
          >
            <SearchStatsPanel search={stats.data?.search ?? null} />
          </Group>
        </>
      )}
    </div>
  );
}

/** A titled section. The heading is the same Fraunces h2 the other sections use. */
function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const id = `group-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div>
        <h2 id={id} className="font-display text-h2 text-text">
          {title}
        </h2>
        {description && <p className="mt-1 text-body-sm text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
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
        },
        {
          label: 'Passages',
          value: stats.index.chunksTotal.toLocaleString('en-GB'),
          note: `${stats.index.avgChunksPerDocument.toFixed(2)} per document`,
        },
        {
          label: 'Abstain rate',
          value: formatPercent(stats.search.abstainRate),
          note: `${stats.search.queriesTotal.toLocaleString('en-GB')} queries recorded`,
        },
        {
          label: 'p95 latency',
          value: formatMs(stats.search.p95LatencyMs),
          note: `${formatMs(stats.search.avgLatencyMs)} mean`,
        },
      ]
    : null;

  return (
    <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles
        ? tiles.map((tile, i) => (
            <LabelFrame
              key={tile.label}
              // The notch is the tear-open-packet motif; at most one element per view gets it.
              notch={i === 0}
              /*
               * Sentence case, not the uppercase tracked eyebrow the panels use. Six panel
               * headings and four tile labels in one identical 12px uppercase treatment is
               * the reflex that makes a page look templated, and it also flattened a real
               * distinction: a panel heading names a section, a tile label names a number.
               */
              title={<p className="text-caption font-medium text-text-muted">{tile.label}</p>}
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
      <LabelFrame title={<Eyebrow as="h3">Index health</Eyebrow>}>
        <SkeletonLine className="w-full" />
        <SkeletonLine className="mt-3 w-3/4" />
        <SkeletonLine className="mt-3 w-2/3" />
      </LabelFrame>
    );
  }

  const torn = health.chunksTotal !== health.embeddingsTotal;

  return (
    <LabelFrame title={<Eyebrow as="h3">Index health</Eyebrow>}>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="brand">{health.documentsIndexed} indexed</Badge>
        {health.documentsPending > 0 && (
          <Badge tone="attention">{health.documentsPending} pending</Badge>
        )}
        {health.documentsFailed > 0 && <Badge tone="danger">{health.documentsFailed} failed</Badge>}
        {/*
         * Neutral, not danger. §8's badge table assigns `--danger-subtle` to "deprecated",
         * which is right on a source card where the reader must not mistake a retired
         * document for current. Here it is a count of a normal corpus property sitting in
         * the panel that reports defects, and clay makes an ordinary fact look like one.
         */}
        {health.documentsDeprecated > 0 && <Badge>{health.documentsDeprecated} deprecated</Badge>}
      </div>

      {torn && (
        <p className="mt-3 border border-danger bg-danger-subtle p-2 text-caption text-text">
          <span className="font-semibold">Index is torn.</span> {health.chunksTotal} passages but{' '}
          {health.embeddingsTotal} embeddings, so vector search is missing rows. Re-run ingestion
          with force.
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
            <span className="tabular">{formatDateTime(health.lastRun.startedAt)}</span>
          ) : (
            'never'
          )}
        </Row>
        {health.lastRun && (
          <Row label="Last outcome">
            <Badge tone={health.lastRun.status === 'failed' ? 'danger' : 'brand'}>
              {health.lastRun.status}
            </Badge>
          </Row>
        )}
      </dl>
    </LabelFrame>
  );
}

/**
 * One labelled figure. A `<dl>` of these replaces the dot-delimited metadata strings the
 * dashboard was full of: `14 days · peak 3 · 8 in the last 7` reads as one opaque token,
 * three labelled pairs read as three measurements.
 */
function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="tabular text-text">{children}</dd>
    </div>
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

/**
 * Collapse repeats of the same unanswered question into one row with a count.
 *
 * The API returns the ten most recent abstentions, and repeats are the norm: asking the
 * same uncovered question three times filled three of the five visible slots in the panel
 * whose whole job is to be a shortlist of documents worth writing. Case- and
 * whitespace-insensitive, matching how the top-queries aggregation groups server-side.
 */
function groupAbstains(
  entries: DashboardStats['search']['recentAbstains'],
): { query: string; asked: number; lastAsked: string }[] {
  const grouped = new Map<string, { query: string; asked: number; lastAsked: string }>();

  for (const entry of entries) {
    const key = entry.query.trim().toLowerCase();
    const seen = grouped.get(key);
    if (seen) {
      seen.asked += 1;
      // Entries arrive newest-first, so the first timestamp for a key is the latest.
      continue;
    }
    grouped.set(key, { query: entry.query.trim(), asked: 1, lastAsked: entry.createdAt });
  }

  return [...grouped.values()];
}

function SearchStatsPanel({ search }: { search: DashboardStats['search'] | null }) {
  if (!search) {
    return (
      <>
        <LabelFrame title={<Eyebrow as="h3">Search</Eyebrow>}>
          <SkeletonLine className="w-2/3" />
          <SkeletonLine className="mt-3 w-1/2" />
        </LabelFrame>
      </>
    );
  }

  const peak = Math.max(1, ...search.volumeByDay.map((day) => day.count));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LabelFrame title={<Eyebrow as="h3">Most asked</Eyebrow>}>
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
                  {entry.count}×
                  {entry.abstainedCount > 0 && (
                    <span className="ml-2 text-danger-text">{entry.abstainedCount} missed</span>
                  )}
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
        <LabelFrame title={<Eyebrow as="h3">Not covered by the corpus</Eyebrow>}>
          {search.recentAbstains.length === 0 ? (
            <p className="text-body-sm text-text-muted">
              Every recorded query found supporting passages.
            </p>
          ) : (
            <ul className="grid gap-2">
              {groupAbstains(search.recentAbstains).map((entry) => (
                <li key={entry.query} className="text-body-sm text-text">
                  {entry.query}
                  <span className="text-mono-label tabular ml-2 font-mono text-text-muted">
                    {entry.asked > 1 && `${entry.asked}× · `}
                    {formatDateTime(entry.lastAsked)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </LabelFrame>

        {/* Under seven points a bar chart implies a trend that isn't there. */}
        {search.volumeByDay.length >= MIN_SERIES_POINTS && (
          <LabelFrame title={<Eyebrow as="h3">Queries per day</Eyebrow>}>
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
            <dl className="text-mono-label tabular mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-text-muted">
              <Figure label="days">{search.volumeByDay.length}</Figure>
              <Figure label="peak">{peak}</Figure>
              <Figure label="last 7 days">{search.queriesLast7Days}</Figure>
            </dl>
          </LabelFrame>
        )}
      </div>
    </div>
  );
}

function CategoryPanel({ byCategory }: { byCategory: DashboardStats['byCategory'] | null }) {
  if (!byCategory || byCategory.length === 0) return null;
  const most = Math.max(...byCategory.map((row) => row.documents));

  return (
    <LabelFrame title={<Eyebrow as="h3">Documents by category</Eyebrow>}>
      <ul className="grid gap-3">
        {byCategory.map((row) => (
          <li key={row.category} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-body-sm text-text">{row.category}</span>
              <dl className="text-mono-label tabular flex shrink-0 gap-x-4 font-mono text-text-muted">
                <Figure label="docs">{row.documents}</Figure>
                <Figure label="passages">{row.chunks}</Figure>
              </dl>
            </div>
            {/*
             * 6px, not 3px. At 3px in a system whose primary structural device is the 1px
             * rule, a bar at or near 100% is indistinguishable from a divider — the
             * largest category read as a horizontal line under its own label.
             */}
            <span aria-hidden="true" className="block h-1.5 bg-bg-sunken">
              <span
                className="block h-full bg-brand"
                style={{ width: `${Math.round((row.documents / most) * 100)}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </LabelFrame>
  );
}
