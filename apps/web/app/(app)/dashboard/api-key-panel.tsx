'use client';

import { useState } from 'react';
import { secretStatusSchema, type SecretStatus } from '@hatko/shared';
import { messageOf } from '../../../lib/api.ts';
import { apiSend } from '../../../lib/client.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { useApi } from '../../../lib/use-api.ts';
import {
  AlertIcon,
  Badge,
  Button,
  ErrorCard,
  Eyebrow,
  Field,
  Input,
  LabelFrame,
  SkeletonLine,
} from '../../../components/ui.tsx';

/**
 * The provider key, entered here or supplied as OPENAI_API_KEY.
 *
 * The key is write-only across the boundary: there is no endpoint that returns a stored
 * secret, so this panel shows a source, a last-four hint and who set it, and never the
 * value. Clearing it falls back to the environment variable if one is set, which is why
 * the active source is named rather than implied.
 */

/** What each source means for the operator, in the panel's own words. */
const SOURCE_COPY: Record<SecretStatus['source'], { badge: string; detail: string }> = {
  database: {
    badge: 'from this page',
    detail: 'Stored encrypted in the database. This value overrides OPENAI_API_KEY.',
  },
  environment: {
    badge: 'from the environment',
    detail: 'Read from OPENAI_API_KEY. Saving a key here will take precedence over it.',
  },
  unset: {
    badge: 'not configured',
    detail: 'Embedding and answer generation will fail until a key is supplied.',
  },
  unreadable: {
    badge: 'unreadable',
    detail:
      'A key is stored but cannot be decrypted. BETTER_AUTH_SECRET changed after it was saved: re-enter the key, or restore the previous secret.',
  },
};

export function ApiKeyPanel() {
  const status = useApi('/api/admin/settings/api-key', secretStatusSchema);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function mutate(action: 'save' | 'clear') {
    setBusy(true);
    setFailure(null);
    try {
      if (action === 'save') {
        await apiSend('PUT', '/api/admin/settings/api-key', secretStatusSchema, { apiKey: value });
        setValue('');
      } else {
        await apiSend('DELETE', '/api/admin/settings/api-key', secretStatusSchema);
      }
      status.reload();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (status.error) {
    return (
      <ErrorCard
        title="Could not read the provider key status."
        detail={status.error}
        onRetry={status.reload}
      />
    );
  }

  if (!status.data) {
    return (
      <LabelFrame title={<Eyebrow as="h3">Provider key</Eyebrow>}>
        <SkeletonLine className="w-1/2" />
        <SkeletonLine className="mt-3 w-full" />
        <SkeletonLine className="mt-3 w-2/3" />
      </LabelFrame>
    );
  }

  const source = SOURCE_COPY[status.data.source];

  return (
    <LabelFrame title={<Eyebrow as="h3">Provider key</Eyebrow>}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status.data.configured ? 'brand' : 'danger'}>
          {status.data.configured ? 'active' : 'unavailable'}
        </Badge>
        <Badge>{source.badge}</Badge>
        {/* The hint arrives already elided (`…a91f`); prefixing another ellipsis doubles it. */}
        {status.data.hint && (
          <span className="text-mono font-mono text-text-muted">{status.data.hint}</span>
        )}
      </div>

      <p className="mt-3 text-body-sm text-text-muted">{source.detail}</p>

      {status.data.updatedAt && (
        <p className="text-mono-label tabular mt-2 font-mono text-text-muted">
          Set {formatDateTime(status.data.updatedAt)}
          {status.data.updatedBy && ` by ${status.data.updatedBy}`}
        </p>
      )}

      <div className="mt-4 border-t border-rule pt-4">
        <Field
          label="Replace key"
          htmlFor="api-key"
          hint="Never displayed again after saving. At least 20 characters."
        >
          <Input
            id="api-key"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
          />
        </Field>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => void mutate('save')}
            loading={busy}
            disabled={value.trim().length < 20}
          >
            Save key
          </Button>
          {status.data.source === 'database' || status.data.source === 'unreadable' ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void mutate('clear')}
              disabled={busy}
            >
              Remove stored key
            </Button>
          ) : null}
        </div>

        {/*
         * Reported next to the buttons rather than as a field error. A save can fail because
         * the provider rejected the key, or because the API was unreachable, or because the
         * session expired — only the first is a problem with what is in the field, and the
         * client cannot tell them apart, so it does not claim to.
         */}
        {failure && (
          <p
            role="alert"
            className="mt-3 flex items-start gap-2 border border-danger bg-danger-subtle p-2 text-caption text-text"
          >
            <AlertIcon className="mt-px size-3.5 shrink-0 text-danger-text" />
            {failure}
          </p>
        )}
      </div>
    </LabelFrame>
  );
}
