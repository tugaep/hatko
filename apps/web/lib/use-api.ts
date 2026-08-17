'use client';

import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { isAuthError, messageOf } from './api.ts';
import { apiGet } from './client.ts';

/**
 * Load a GET endpoint, with the three states every panel on the dashboard needs.
 *
 * Written once because there are four call sites — stats, ingestion runs, documents,
 * API key status — and each of them independently wants a loading skeleton, an error
 * card with a retry, and a way to refetch after a mutation. Four hand-rolled copies of
 * the same effect is where the stale-request bug would live.
 *
 * In-flight requests are aborted when `path` changes, so typing in the document filter
 * cannot land an earlier response after a later one.
 */
export function useApi<T extends z.ZodType>(path: string, schema: T) {
  const [data, setData] = useState<z.infer<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    apiGet(path, schema, controller.signal).then(
      (result) => {
        setData(result);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        // An expired session is not a panel-level failure. Reload and let the server
        // gate decide where this browser belongs.
        if (isAuthError(cause)) {
          window.location.reload();
          return;
        }
        setError(messageOf(cause));
        setLoading(false);
      },
    );

    return () => controller.abort();
    // `schema` is a module-level constant at every call site; including it would
    // re-fire the effect on any parent re-render that rebuilt it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { data, error, loading, reload };
}
