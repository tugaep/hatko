'use client';

import { useState } from 'react';
import {
  MEASURED_CHAT_MODEL,
  MODEL_PRESETS,
  chatModels,
  modelSettingsSchema,
  type ModelPreset,
} from '@hatko/shared';
import { messageOf } from '../../../lib/api.ts';
import { apiSend } from '../../../lib/client.ts';
import { useApi } from '../../../lib/use-api.ts';
import { AlertIcon } from '../../../components/ui.tsx';

/**
 * Switch the answering model without leaving the page you judge it on.
 *
 * Comparing two models means asking the same question of each and reading both answers,
 * and a round trip to the dashboard between attempts is enough friction that nobody does
 * it twice. So the control sits where the evidence is.
 *
 * Three deliberate limits, each of which had an easier and worse alternative:
 *
 * Admins only, and enforced on the server rather than here. The routes behind this are
 * gated on `documents:manage`, so a regular user who forged the request gets a 403 before
 * any handler runs. Hiding the control is a courtesy; the gate is the security.
 *
 * Answer model only. The rerank model decides whether the corpus can answer at all —
 * abstention compares its grade against a threshold calibrated on one model — and that is
 * not a thing to change with a casual click beside a chat box. The dashboard changes it,
 * next to the warning explaining what it costs.
 *
 * It is a global setting, and it says so. There is one stored configuration, shared by the
 * chat page, the MCP tool and the eval; a per-conversation override would be a second
 * notion of "the active model" and the two would disagree about which produced an answer.
 */

/** `presetId|model`, so one native select can span two providers. */
const encode = (preset: ModelPreset, model: string) => `${preset.id}|${model}`;

export function AnswerModelPicker() {
  const settings = useApi('/api/admin/settings/models', modelSettingsSchema);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!settings.data) return null;

  const { active, availability } = settings.data;
  const hosted = MODEL_PRESETS.find((preset) => preset.install === null);
  const local = MODEL_PRESETS.find((preset) => preset.install !== null);
  const activePreset = MODEL_PRESETS.find((preset) => preset.baseUrl === active.baseUrl);

  /**
   * The hosted models this account actually has, from the probe when it describes the
   * hosted provider — and from the curated list alone when the active provider is the
   * local one, where OpenAI's list was never fetched. Offering the three either way is
   * right: they are what this system supports, and a key that cannot serve one fails
   * loudly on the next question rather than quietly.
   */
  const hostedModels =
    active.isOpenAI && availability.reachable
      ? chatModels(availability.models, true)
      : chatModels([...(hosted ? [hosted.answerModel] : [])], true);

  /**
   * Switching provider from here is offered but not allowed to break search silently.
   *
   * The local preset embeds at 768d and this index holds 1536d vectors; vectors from two
   * embedding models cannot be compared, and the embedding model is env-only because
   * changing it means rebuilding the index. So selecting it would save a configuration
   * under which search returns nothing — with no error, because nothing failed. Shown
   * disabled with the reason instead, which is the difference between an option that is
   * unavailable and one that is hidden.
   */
  const localUnusable = local && local.embeddingDimensions !== active.embeddingDimensions;

  async function choose(value: string) {
    const [presetId, ...rest] = value.split('|');
    const model = rest.join('|');
    const preset = MODEL_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset || !settings.data) return;

    setBusy(true);
    setFailure(null);
    try {
      const sameProvider = preset.baseUrl === settings.data.active.baseUrl;
      await apiSend('PUT', '/api/admin/settings/models', modelSettingsSchema, {
        baseUrl: preset.baseUrl,
        answerModel: model,
        /**
         * Staying on one provider keeps whatever grader an admin chose on the dashboard.
         * Moving between providers cannot: there is one base URL for both calls, so an
         * OpenAI grader against a local server is a 404 on the next question.
         */
        rerankModel: sameProvider ? settings.data.active.rerankModel : preset.rerankModel,
      });
      settings.reload();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const current = activePreset ? encode(activePreset, active.answerModel) : '';

  return (
    <div className="sm:text-right">
      <label
        htmlFor="chat-answer-model"
        className="block text-caption uppercase tracking-wide text-text-muted"
      >
        Answer model
      </label>
      <select
        id="chat-answer-model"
        value={current}
        disabled={busy}
        onChange={(event) => choose(event.target.value)}
        className="mt-1 h-9 w-full rounded-none border border-border-interactive bg-bg-raised px-2 font-mono text-body-sm text-text outline-none focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
      >
        {/* A configuration set in .env that no preset matches still has to be selectable,
            or the select would show a different model than the one actually answering. */}
        {!current && <option value="">{active.answerModel} (from .env)</option>}

        {hosted && (
          <optgroup label="OpenAI">
            {hostedModels.map((model) => (
              <option key={model} value={encode(hosted, model)}>
                {model}
                {model === MEASURED_CHAT_MODEL ? ' — measured' : ''}
              </option>
            ))}
          </optgroup>
        )}

        {local && (
          <optgroup label="Self-hosted">
            <option value={encode(local, local.answerModel)} disabled={localUnusable}>
              {local.answerModel}
              {localUnusable ? ` — needs a ${local.embeddingDimensions}d index` : ''}
            </option>
          </optgroup>
        )}
      </select>
      <p className="mt-1 text-caption text-text-muted">Applies to everyone, not this tab.</p>
      {localUnusable && (
        <p className="mt-1 text-caption text-text-muted">
          The local model embeds at {local.embeddingDimensions}d and this index holds{' '}
          {active.embeddingDimensions}d. Switching needs a re-ingest — see the dashboard.
        </p>
      )}
      {failure && (
        <p role="alert" className="mt-1 flex items-start gap-1.5 text-caption text-danger-text">
          <AlertIcon className="mt-px size-3.5 shrink-0" />
          {failure}
        </p>
      )}
    </div>
  );
}
