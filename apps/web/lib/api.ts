import { apiErrorSchema, type ApiError } from '@hatko/shared';
import type { z } from 'zod';

/**
 * The one place a fetch against the API is turned into either typed data or a
 * throwable with a message worth showing a person.
 *
 * The API always answers non-2xx with the same envelope (`apiErrorSchema`), so there
 * is exactly one error shape to handle rather than one per endpoint. Successful
 * bodies are parsed against the shared schema on arrival: the server already
 * validates on the way out, and re-parsing here means a contract drift surfaces as
 * one legible error at the boundary instead of as `undefined` deep in a component.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiError['error']['code'] | 'network' | 'malformed';
  /** Field-level validation detail, when the failure was a bad request. */
  readonly details: Record<string, string> | undefined;

  constructor(
    status: number,
    code: ApiRequestError['code'],
    message: string,
    details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * True when the failure means "sign in again" rather than "something broke".
 *
 * The code is checked as well as the status because a failure on a stream has no status
 * to check — the 200 was sent before the first byte of content, so an expired session
 * mid-answer arrives as an `unauthorized` envelope inside the stream.
 */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.code === 'unauthorized' ||
    error.code === 'forbidden'
  );
}

/**
 * A body that does not match the schema this page was built against.
 *
 * Always the same message, whether the mismatch was found in a JSON response or in one
 * event of a stream: the cause is the same — a client and an API on different versions —
 * and so is the thing to do about it.
 */
export const malformed = (status: number) =>
  new ApiRequestError(
    status,
    'malformed',
    'The API returned data this page cannot read. It may be running a different version.',
  );

export function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export async function parseResponse<T extends z.ZodType>(
  response: Response,
  schema: T,
): Promise<z.infer<T>> {
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = apiErrorSchema.safeParse(body);
    if (envelope.success) {
      const { code, message, details } = envelope.data.error;
      throw new ApiRequestError(response.status, code, message, details);
    }
    // A non-2xx that is not our envelope means the request never reached a route
    // handler — a proxy, a crash, a wrong URL. Say that rather than guessing.
    throw new ApiRequestError(
      response.status,
      'malformed',
      `The API returned ${response.status} without a readable error.`,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw malformed(response.status);
  return parsed.data;
}
