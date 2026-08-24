'use client';

import { useState } from 'react';
import { ingestionRunSchema, type IngestionRun } from '@hatko/shared';
import { z } from 'zod';
import { messageOf } from '../../../lib/api.ts';
import { apiSend } from '../../../lib/client.ts';
import { catalogNumber, formatDateTime, formatMs } from '../../../lib/format.ts';
import { useApi } from '../../../lib/use-api.ts';
import { Badge, Button, ErrorCard, LabelFrame, SkeletonLine, cx } from '../../../components/ui.tsx';

/**
 * Ingestion: trigger it, and see every run that has happened.
 *
 * The brief asks for ingestion to be observable — "what was indexed, when, and whether
 * it succeeded" — so the per-outcome counts are the point of this table, not decoration.
 * Skipped is as informative as indexed: it is the evidence that content hashing is doing
 * its job and a re-run is cheap.
 */

const runsSchema = z.object({ items: z.array(ingestionRunSchema) });
const triggerSchema = z.object({ run: ingestionRunSchema });

export function IngestionPanel({ onIngested }: { onIngested: () => void }) {
  const runs = useApi('/api/admin/ingestion/runs', runsSchema);
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function trigger() {
    setRunning(true);
    setConfirming(false);
    setFailure(null);
    try {
      await apiSend('POST', '/api/admin/ingestion/run', triggerSchema, { force });
      runs.reload();
      onIngested();
      setForce(false);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setRunning(false);
    }
  }

  /**
   * A plain run is idempotent and skips unchanged files in milliseconds, so it fires on
   * the first click. Forcing re-embeds every document in the corpus, which spends provider
   * credits and cannot be undone, so it asks first. Inline rather than a modal: the
   * question is about the control the pointer is already on.
   */
  function onRunClick() {
    if (force && !confirming) {
      setConfirming(true);
      return;
    }
    void trigger();
  }

  return (
    <section aria-labelledby="ingestion-heading" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="ingestion-heading" className="font-display text-h2 text-text">
            Ingestion
          </h2>
          <p className="mt-1 max-w-[60ch] text-body-sm text-text-muted">
            Re-reads the corpus directory. Unchanged files are skipped by content hash, so
            re-running is cheap and repeatable.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-caption text-text">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => {
                setForce(event.target.checked);
                setConfirming(false);
              }}
              className="size-4 rounded-sm border border-border-interactive accent-[var(--brand)]"
            />
            Re-embed unchanged files
          </label>
          <Button
            onClick={onRunClick}
            loading={running}
            variant={confirming ? 'danger' : 'primary'}
          >
            {confirming ? 'Confirm: re-embed everything' : 'Run ingestion'}
          </Button>
        </div>
      </div>

      {confirming && (
        <p
          role="alert"
          className="fade border border-attention-subtle bg-attention-subtle p-3 text-body-sm text-text"
        >
          Forcing re-embeds every document in the corpus and spends provider credits on all of them.
          Press again to run it, or clear the checkbox to run a normal pass.
        </p>
      )}

      {failure && (
        <ErrorCard
          title="Ingestion could not start."
          detail={failure}
          onRetry={() => void trigger()}
        />
      )}

      {runs.error ? (
        <ErrorCard
          title="Could not load ingestion history."
          detail={runs.error}
          onRetry={runs.reload}
        />
      ) : runs.data ? (
        <RunList runs={runs.data.items} />
      ) : (
        <LabelFrame>
          <SkeletonLine className="w-1/3" />
          <SkeletonLine className="mt-3 w-2/3" />
          <SkeletonLine className="mt-3 w-1/2" />
        </LabelFrame>
      )}
    </section>
  );
}

function RunList({ runs }: { runs: IngestionRun[] }) {
  if (runs.length === 0) {
    return (
      <LabelFrame>
        <p className="text-body-sm text-text-muted">
          No ingestion runs recorded. Run one above, or from the CLI with{' '}
          <code className="text-mono font-mono">npm run ingest</code>.
        </p>
      </LabelFrame>
    );
  }

  return (
    <ol className="grid gap-3">
      {runs.map((run) => (
        <li key={run.id}>
          <RunRow run={run} />
        </li>
      ))}
    </ol>
  );
}

const RUN_TONE = {
  succeeded: 'brand',
  running: 'attention',
  failed: 'danger',
} as const;

function RunRow({ run }: { run: IngestionRun }) {
  const counts = [
    ['indexed', run.docsIndexed],
    ['updated', run.docsUpdated],
    ['skipped', run.docsSkipped],
    ['deleted', run.docsDeleted],
    ['failed', run.docsFailed],
  ] as const;

  return (
    <LabelFrame
      catalog={catalogNumber('RUN', run.id)}
      interactive
      title={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
          <Badge>{run.trigger}</Badge>
          <span className="text-mono tabular font-mono text-text-muted">
            {formatDateTime(run.startedAt)}
          </span>
          {run.durationMs !== null && (
            <span className="text-mono tabular font-mono text-text-muted">
              took {formatMs(run.durationMs)}
            </span>
          )}
        </div>
      }
    >
      <dl className="flex flex-wrap gap-x-5 gap-y-1">
        {counts.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="text-caption text-text-muted">{label}</dt>
            {/*
             * A zero is not news. Printing all five counts at full ink meant `skipped 1083`
             * and four zeros shouted equally, six rows deep — so the one number that says
             * what the run did was the hardest to find.
             */}
            <dd
              className={cx(
                'text-mono tabular font-mono',
                value === 0
                  ? 'text-rule-strong'
                  : label === 'failed'
                    ? 'text-danger-text'
                    : 'text-text',
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {/* A failure's reason belongs on the record, not only in a log file. */}
      {run.error && (
        <details className="mt-3">
          <summary className="cursor-pointer text-caption text-danger-text">Failure detail</summary>
          <pre className="text-mono mt-2 overflow-x-auto border border-rule bg-bg-sunken p-2 font-mono">
            {run.error}
          </pre>
        </details>
      )}
    </LabelFrame>
  );
}
