'use client';

import { useRouter } from 'next/navigation';
import { modelSettingsSchema, secretStatusSchema, type DashboardStats } from '@hatko/shared';
import { useApi } from '../../../lib/use-api.ts';
import { Button, Eyebrow, LabelFrame } from '../../../components/ui.tsx';

/**
 * What a fresh installation still needs, in the order it needs it.
 *
 * This exists because the first run was discovered by failure rather than explained. A
 * new admin signs in, lands on a dashboard of empty panels, and the system's three
 * prerequisites — a provider credential, a reachable model, an indexed corpus — are
 * spread across three panels with nothing saying they are prerequisites at all, or that
 * they have an order. The observed result was ingestion refusing to start and every
 * question answering "the model provider could not be reached", neither of which names
 * the actual missing step.
 *
 * The order is not cosmetic. Ingestion embeds 142 documents, which is a provider call
 * per document, so it cannot run before there is a working credential — and the model
 * has to be reachable before the credential can be shown to work. Each step therefore
 * unlocks the next, and a checklist that let you start at the bottom would only move
 * where the failure appears.
 *
 * It disappears once all three are done, rather than becoming a permanently ticked
 * decoration. Its whole job is the first ten minutes; after that it is noise on a page
 * whose panels already report the same state in more detail.
 */

interface Step {
  title: string;
  done: boolean;
  /** What to do, when it is not done yet. */
  todo: string;
  /** The tab that completes it. A route, since each step now owns a page of its own. */
  href: string;
}

export function SetupChecklist({
  stats,
  onJump,
}: {
  stats: DashboardStats | null;
  onJump?: () => void;
}) {
  // Both are already fetched by the panels below. Fetched again rather than threaded
  // down through the dashboard, because the alternative is lifting two pieces of state
  // into a parent that has no other use for them, purely to serve a component that
  // deletes itself once setup is finished.
  const router = useRouter();
  const key = useApi('/api/admin/settings/api-key', secretStatusSchema);
  const models = useApi('/api/admin/settings/models', modelSettingsSchema);

  // Nothing is asserted until every signal has arrived. A checklist that renders "no API
  // key" for a moment on every load would be wrong more often than it is right.
  if (!key.data || !models.data || !stats) return null;

  const steps: Step[] = [
    {
      title: 'Provider credential',
      done: key.data.configured,
      todo: 'Add an OpenAI API key, or point the system at a local model server that needs none.',
      href: '/dashboard/models',
    },
    {
      title: 'Model reachable',
      done: models.data.availability.reachable,
      todo:
        models.data.availability.error ??
        'Choose a configuration and confirm the provider answers.',
      href: '/dashboard/models',
    },
    {
      title: 'Corpus indexed',
      done: stats.index.chunksTotal > 0,
      todo: `Run ingestion. ${stats.index.documentsTotal || 142} documents, one embedding call each.`,
      href: '/dashboard/ingestion',
    },
  ];

  if (steps.every((step) => step.done)) return null;

  // The first unfinished step. Named rather than merely listed, because the useful
  // instruction on a fresh install is one action, not three.
  const next = steps.find((step) => !step.done)!;

  return (
    <LabelFrame title={<Eyebrow as="h2">Finish setting up</Eyebrow>}>
      <p className="max-w-[60ch] text-body-sm text-text-muted">
        Three things have to be true before the corpus can answer anything, and each one depends on
        the one above it. Nothing else on this page will work until they are done.
      </p>

      <ol className="mt-4 grid gap-3">
        {steps.map((step, index) => (
          <li key={step.href} className="flex items-start gap-3">
            <span
              aria-hidden
              className={
                step.done
                  ? 'mt-0.5 flex size-5 shrink-0 items-center justify-center border border-brand text-caption text-brand'
                  : 'mt-0.5 flex size-5 shrink-0 items-center justify-center border border-rule-strong text-caption text-text-muted'
              }
            >
              {step.done ? '✓' : index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-body-sm text-text">
                {step.title}
                {/* Stated for a screen reader too, which cannot see the tick. */}
                <span className="sr-only">{step.done ? ' — done' : ' — not done yet'}</span>
              </p>
              {!step.done && <p className="mt-0.5 text-body-sm text-text-muted">{step.todo}</p>}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            document
              .querySelector(next.href)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            onJump?.();
          }}
        >
          Go to: {next.title}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            key.reload();
            models.reload();
            onJump?.();
          }}
        >
          Re-check
        </Button>
      </div>
    </LabelFrame>
  );
}
