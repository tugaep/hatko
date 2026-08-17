'use client';

import { useState } from 'react';
import {
  MODEL_PRESETS,
  hasModel,
  modelSettingsSchema,
  presetModels,
  type ModelPreset,
  type ModelSettings,
} from '@hatko/shared';
import { messageOf } from '../../../lib/api.ts';
import { apiSend } from '../../../lib/client.ts';
import { useApi } from '../../../lib/use-api.ts';
import {
  AlertIcon,
  Badge,
  Button,
  ErrorCard,
  Eyebrow,
  Field,
  LabelFrame,
  SkeletonLine,
} from '../../../components/ui.tsx';

/**
 * Which models answer questions, and where they run.
 *
 * Sits beside the provider key because they are one decision: a hosted provider needs a
 * key and no installation, a local one needs an installation and no key, and an operator
 * choosing between them is choosing both at once.
 *
 * Two things this panel refuses to hide. First, selecting a local preset installs
 * nothing — so the server is asked what it actually has, and anything missing is shown
 * as the command that fixes it rather than discovered later as a failed question.
 * Second, the embedding model cannot be changed from here at all: it is fixed by the
 * width of the vector column, and switching it means rebuilding the index. Offering it
 * as a dropdown would be offering a button that silently breaks search.
 */

/** Matches a saved configuration back to a preset, so the select reflects reality. */
function presetFor(settings: ModelSettings): ModelPreset | undefined {
  return MODEL_PRESETS.find(
    (preset) =>
      preset.baseUrl === settings.active.baseUrl &&
      preset.answerModel === settings.active.answerModel &&
      preset.rerankModel === settings.active.rerankModel,
  );
}

export function ModelsPanel() {
  const [choice, setChoice] = useState<string | null>(null);
  /**
   * The selection is part of the request, so changing it re-probes the server that
   * selection actually names. With a fixed path the panel showed the active provider's
   * model list under the selected provider's heading, and told an operator to install a
   * model they already had. `useApi` aborts the in-flight request when the path changes.
   */
  const settings = useApi(
    choice
      ? `/api/admin/settings/models?probe=${encodeURIComponent(choice)}`
      : '/api/admin/settings/models',
    modelSettingsSchema,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function apply(preset: ModelPreset) {
    setBusy(true);
    setFailure(null);
    try {
      await apiSend('PUT', '/api/admin/settings/models', modelSettingsSchema, {
        baseUrl: preset.baseUrl,
        answerModel: preset.answerModel,
        rerankModel: preset.rerankModel,
      });
      settings.reload();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setFailure(null);
    try {
      await apiSend('DELETE', '/api/admin/settings/models', modelSettingsSchema);
      setChoice(null);
      settings.reload();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (settings.error) {
    return (
      <ErrorCard
        title="Could not read the model settings."
        detail={settings.error}
        onRetry={settings.reload}
      />
    );
  }

  if (!settings.data) {
    return (
      <LabelFrame title={<Eyebrow as="h3">Models</Eyebrow>}>
        <SkeletonLine className="w-1/2" />
        <SkeletonLine className="mt-3 w-full" />
        <SkeletonLine className="mt-3 w-2/3" />
      </LabelFrame>
    );
  }

  const { active, availability } = settings.data;
  const current = presetFor(settings.data);
  const selectedId = choice ?? current?.id ?? '';
  const selected = MODEL_PRESETS.find((preset) => preset.id === selectedId);

  /**
   * Only read the probe when it describes the server currently selected.
   *
   * During a refetch the previous answer is still in `settings.data`, and one describing
   * a different host is worse than none — that mismatch is exactly what produced a
   * spurious "not installed" for a model that was installed. Comparing the address the
   * server says it probed makes the stale window render nothing instead of a lie.
   */
  const probeMatches = selected && availability.probedBaseUrl === selected.baseUrl;

  /**
   * Only meaningful for a local provider: a hosted one installs nothing, and its model
   * list is long and beside the point.
   *
   * `presetModels` includes the embedding model even though this panel cannot set it.
   * That list was assembled here at first and left it out — "cannot set it" quietly
   * became "need not check it" — so an operator missing `nomic-embed-text` saw a clean
   * panel, followed the `.env` instructions below, and met the failure at
   * `npm run ingest` instead.
   */
  const missing =
    selected?.install && probeMatches && availability.reachable
      ? presetModels(selected).filter((model) => !hasModel(availability.models, model))
      : [];

  /**
   * The embedding model is env-only, so a preset that expects a different one cannot be
   * completed by saving this form. Saying so before the save is the difference between
   * an instruction and a broken index.
   */
  const embeddingMismatch = selected && selected.embeddingModel !== active.embeddingModel;

  return (
    <LabelFrame title={<Eyebrow as="h3">Models</Eyebrow>}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={active.isOpenAI ? 'brand' : undefined}>
          {active.isOpenAI ? 'hosted' : 'self-hosted'}
        </Badge>
        <Badge>{active.source === 'database' ? 'from this page' : 'from the environment'}</Badge>
        <span className="text-mono font-mono text-text-muted">{active.providerLabel}</span>
      </div>

      <dl className="mt-3 grid gap-1 text-body-sm text-text-muted">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0">answer</dt>
          <dd className="font-mono">{active.answerModel}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0">rerank</dt>
          <dd className="font-mono">{active.rerankModel}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0">embedding</dt>
          <dd className="font-mono">
            {active.embeddingModel} · {active.embeddingDimensions}d
          </dd>
        </div>
      </dl>

      {/*
       * The limits stated as facts, not as a disclaimer. An earlier draft said answer
       * quality was "measurably lower", which the measurements then contradicted —
       * qwen2.5:7b scores the same 12/12 on the eval set. The real limits are narrower
       * and worth naming precisely: one validated model, slower, and more willing to
       * abstain on phrasings the eval set does not contain.
       */}
      <p className="mt-4 border-t border-rule pt-4 text-body-sm text-text-muted">
        Self-hosted models are supported at a basic level: one validated configuration, matching the
        hosted provider on this corpus&rsquo;s eval set. It is slower, it needs about 5 GB of local
        models, and smaller models than the one listed were measured and rejected for failing to
        abstain. OpenAI remains the default and the recommended configuration.
      </p>

      <div className="mt-4 grid gap-4 border-t border-rule pt-4">
        <Field
          label="Configuration"
          htmlFor="model-preset"
          hint={selected?.measured ?? 'Choose a provider and the models it should answer with.'}
        >
          {/*
           * A native select: it is keyboard accessible, works before hydration, and gets
           * the platform's own picker on a phone. A custom listbox would be more markup
           * for less behaviour.
           */}
          <select
            id="model-preset"
            value={selectedId}
            disabled={busy}
            onChange={(event) => setChoice(event.target.value)}
            className="h-10 w-full rounded-none border border-border-interactive bg-bg-raised px-3 text-body-sm text-text outline-none focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-40"
          >
            {!current && <option value="">Custom (set in .env)</option>}
            {MODEL_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>

        {selected?.install && probeMatches && !availability.reachable && (
          <InstallNotice
            title={`No model server is running at ${selected.baseUrl}.`}
            detail={availability.error}
            install={selected.install}
          />
        )}

        {selected?.install && missing.length > 0 && (
          <InstallNotice
            title={`${selected.install.runtime} is running but ${missing.length === 1 ? 'this model is' : 'these models are'} not installed.`}
            detail={null}
            install={{
              ...selected.install,
              commands: missing.map((model) => `ollama pull ${model}`),
            }}
          />
        )}

        {embeddingMismatch && selected && (
          <div className="border border-border-interactive bg-bg-sunken p-3">
            <p className="flex items-start gap-1.5 text-body-sm text-text">
              <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                This configuration embeds with{' '}
                <span className="font-mono">{selected.embeddingModel}</span> at{' '}
                {selected.embeddingDimensions}d, and the index holds {active.embeddingDimensions}d
                vectors.
              </span>
            </p>
            <p className="mt-2 text-body-sm text-text-muted">
              Vectors from two embedding models cannot be compared, so this cannot be changed from
              here. Set it in <span className="font-mono">.env</span> and rebuild the index — search
              returns nothing until you do.
            </p>
            <Commands
              lines={[
                `EMBEDDING_MODEL=${selected.embeddingModel}`,
                `EMBEDDING_DIMENSIONS=${selected.embeddingDimensions}`,
                'npm run db:reset && npm run ingest',
              ]}
            />
          </div>
        )}

        {failure && (
          <p role="alert" className="flex items-start gap-1.5 text-caption text-danger-text">
            <AlertIcon className="mt-px size-3.5 shrink-0" />
            {failure}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => selected && apply(selected)}
            disabled={busy || !selected || selected.id === current?.id}
            loading={busy}
          >
            Use this configuration
          </Button>
          {active.source === 'database' && (
            <Button variant="secondary" onClick={reset} disabled={busy}>
              Reset to .env
            </Button>
          )}
        </div>
      </div>
    </LabelFrame>
  );
}

/** A copyable block of shell lines. Selectable text, not a fake terminal. */
function Commands({ lines }: { lines: string[] }) {
  return (
    <pre className="mt-2 overflow-x-auto border border-rule bg-bg p-2 text-mono font-mono text-text-muted">
      {lines.join('\n')}
    </pre>
  );
}

function InstallNotice({
  title,
  detail,
  install,
}: {
  title: string;
  detail: string | null;
  install: { runtime: string; url: string; commands: string[] };
}) {
  return (
    <div className="border border-border-interactive bg-bg-sunken p-3">
      <p className="flex items-start gap-1.5 text-body-sm text-text">
        <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
        {title}
      </p>
      <p className="mt-2 text-body-sm text-text-muted">
        Install {install.runtime} from{' '}
        <a
          href={install.url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2 hover:text-text"
        >
          {install.url}
        </a>
        , start it, then pull the models. Saving this configuration without them will make every
        question fail.
      </p>
      <Commands lines={install.commands} />
      {detail && <p className="mt-2 text-caption text-text-muted">{detail}</p>}
    </div>
  );
}
