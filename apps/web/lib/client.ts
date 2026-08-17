'use client';

import type { z } from 'zod';
import { API_URL, ApiRequestError, parseResponse } from './api.ts';

/**
 * Browser-side API calls.
 *
 * `credentials: 'include'` is the whole reason this is separate from the server
 * helper: the session cookie is httpOnly and set by the API on its own origin, so
 * it travels only when the fetch opts in. The API's CORS config names this origin
 * explicitly and allows credentials — a wildcard origin cannot.
 */

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init: RequestInit = {},
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
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
  return parseResponse(response, schema);
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
