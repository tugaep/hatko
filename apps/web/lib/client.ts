'use client';

import { sseData } from '@hatko/shared';
import type { z } from 'zod';
import { API_URL, ApiRequestError, malformed, parseResponse } from './api.ts';

/**
 * Browser-side API calls.
 *
 * `credentials: 'include'` is the whole reason this is separate from the server
 * helper: the session cookie is httpOnly and set by the API on its own origin, so
 * it travels only when the fetch opts in. The API's CORS config names this origin
 * explicitly and allows credentials — a wildcard origin cannot.
 */

/** The fetch itself. Split out so the streaming reader shares one network-error path. */
async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
    });
  } catch (error) {
    // fetch rejects only on network-level failure, which for a local demo almost
    // always means the API process is not running. Say that, not "failed to fetch".
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(
      0,
      'network',
      `Could not reach the API at ${API_URL}. Check that it is running.`,
    );
  }
}

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init: RequestInit = {},
): Promise<z.infer<T>> {
  return parseResponse(await send(path, init), schema);
}

export function apiGet<T extends z.ZodType>(
  path: string,
  schema: T,
  signal?: AbortSignal,
): Promise<z.infer<T>> {
  return request(path, schema, signal ? { signal } : {});
}

export function apiSend<T extends z.ZodType>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: T,
  body?: unknown,
  signal?: AbortSignal,
): Promise<z.infer<T>> {
  return request(path, schema, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
}

/**
 * POST, then yield each event of a Server-Sent Events response, parsed and typed.
 *
 * `EventSource` is not an option and this is not a preference: it issues a GET, cannot
 * carry a body, and cannot send credentials cross-origin — three requirements of this
 * endpoint. The framing is read by `sseData`, which is shared with the API's own OpenAI
 * client so the awkward part exists once.
 *
 * Failures arrive two ways and both are handled. A request refused outright — 401 on an
 * expired session, 429 out of allowance — never becomes a stream at all, and is thrown
 * from the same `parseResponse` every other call uses. A failure *after* the first byte
 * cannot use a status code, so the caller must handle it from the event payload; this
 * function is generic and does not know which of its events means trouble.
 */
export async function* apiStream<T extends z.ZodType>(
  path: string,
  schema: T,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<z.infer<T>> {
  const response = await send(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    // Throws the enveloped error. The schema is passed only to satisfy the signature —
    // a non-2xx body is an `apiErrorSchema` envelope and never reaches the success path.
    await parseResponse(response, schema);
  }
  if (!response.body) throw malformed(response.status);

  for await (const data of sseData(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw malformed(response.status);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw malformed(response.status);
    yield parsed.data;
  }
}
