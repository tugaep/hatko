'use client';

import { useState } from 'react';
import { MEASURED_CHAT_MODEL, MODEL_PRESETS, chatModels, modelSettingsSchema } from '@hatko/shared';
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
 * Admins only, and enforced on the server rather than here. The API routes behind this
 * are gated on `documents:manage`, so a regular user who forged the request gets a 403
 * before any handler runs. Hiding the control is a courtesy; the gate is the security.
 *
 * Answer model only. The rerank model decides whether the corpus can answer at all —
 * abstention compares its grade against a threshold calibrated on one model — and that
 * is not a thing to change with a casual click beside a chat box. The dashboard panel
 * changes it, next to the warning explaining what it costs.
 *
 * It is a global setting, and it says so. There is one stored configuration, shared by
 * the chat page, the MCP tool and the eval; a per-conversation override would be a second
 * notion of "the active model" and the two would disagree about which produced an answer.
 */
export function AnswerModelPicker() {
  const settings = useApi('/api/admin/settings/models', modelSettingsSchema);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Nothing to choose from — an unreachable provider or a key that is not set yet. The
  // page's own error states cover that; a broken dropdown beside them adds noise.
  if (!settings.data || !settings.data.availability.reachable) return null;

  const { active, availability } = settings.data;
  const openAI = availability.probedBaseUrl === MODEL_PRESETS[0]!.baseUrl;
  const options = chatModels(availability.models, openAI);
  if (options.length === 0) return null;

  async function choose(model: string) {
    if (!settings.data) return;
    setBusy(true);
    setFailure(null);
    try {
      await apiSend('PUT', '/api/admin/settings/models', modelSettingsSchema, {
        baseUrl: settings.data.active.baseUrl,
        answerModel: model,
        // Carried through unchanged. Sending the whole configuration is what the endpoint
        // takes, and omitting the grader here would silently reset someone's choice.
        rerankModel: settings.data.active.rerankModel,
      });
      settings.reload();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

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
        value={active.answerModel}
        disabled={busy}
        onChange={(event) => choose(event.target.value)}
        className="mt-1 h-9 w-full rounded-none border border-border-interactive bg-bg-raised px-2 font-mono text-body-sm text-text outline-none focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
      >
        {!options.includes(active.answerModel) && (
          <option value={active.answerModel}>{active.answerModel} (not advertised)</option>
        )}
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
            {model === MEASURED_CHAT_MODEL ? ' — measured' : ''}
          </option>
        ))}
      </select>
      <p className="mt-1 text-caption text-text-muted">Applies to everyone, not this tab.</p>
      {failure && (
        <p role="alert" className="mt-1 flex items-start gap-1.5 text-caption text-danger-text">
          <AlertIcon className="mt-px size-3.5 shrink-0" />
          {failure}
        </p>
      )}
    </div>
  );
}
