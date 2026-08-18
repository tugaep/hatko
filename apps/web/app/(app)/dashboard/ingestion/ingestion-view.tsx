'use client';

import { dashboardStatsSchema } from '@hatko/shared';
import { useApi } from '../../../../lib/use-api.ts';
import { IngestionPanel } from '../ingestion-panel.tsx';

/**
 * A run changes the index, so the numbers describing the index have to be refetched when
 * one finishes.
 *
 * That is the whole reason this wrapper exists rather than the page rendering the panel
 * directly: `onIngested` used to reload the overview's stats because both lived on one
 * page. Split across tabs, the callback would have quietly become a no-op — the index
 * would change and the panel would keep reporting the counts it read on mount.
 */
export function IngestionView() {
  const stats = useApi('/api/admin/stats', dashboardStatsSchema);

  return (
    <div className="grid gap-6">
      <p className="max-w-[60ch] text-body-sm text-text-muted">
        Ingestion is incremental: unchanged documents are skipped by content hash, so a run costs an
        embedding call only for what actually changed.
        {stats.data && (
          <>
            {' '}
            The index currently holds {stats.data.index.chunksTotal.toLocaleString('en-GB')}{' '}
            passages from {stats.data.index.documentsIndexed.toLocaleString('en-GB')} documents.
          </>
        )}
      </p>
      <IngestionPanel onIngested={stats.reload} />
    </div>
  );
}
