import { z } from 'zod';
import {
  AuthorizationError,
  ConfigurationError,
  IngestionInProgressError,
  ProviderError,
  RateLimitError,
  UserManagementError,
} from '@hatko/core';
import type { ApiError } from '@hatko/shared';
import type { Context } from 'hono';

/**
 * One error shape for the whole API.
 *
 * Every non-2xx response uses the `apiErrorSchema` envelope, so the client has a
 * single shape to handle rather than guessing per endpoint. Two rules matter here:
 * the message must be useful to whoever reads it, and it must never leak
 * internals — a stack trace or a SQL fragment in a response body is an
 * information disclosure, not a debugging aid.
 */

type ErrorCode = ApiError['error']['code'];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_failed: 502,
  internal: 500,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, string> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Not found.') => new HttpError('not_found', message);

/**
 * Parse a JSON request body, or fail as a 400.
 *
 * `c.req.json()` throws a `SyntaxError` on a malformed or empty body. That is not a
 * `ZodError`, so it fell through to the generic branch below and was answered with
 * 500 `internal` plus a logged stack trace — the server taking blame for the
 * client's malformed request, and reporting an outage where there was none.
 *
 * Every route that reads a required body goes through this. A route whose body is
 * optional (`POST /admin/ingestion/run`) defaults instead, which is a different
 * question and stays where it is.
 */
export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError('bad_request', 'The request body must be valid JSON.');
  }
}

function envelope(code: ErrorCode, message: string, details?: Record<string, string>): ApiError {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

/**
 * Translate a thrown value into a response.
 *
 * Ordered from most specific to least. The final branch is the one that matters
 * for security: anything unrecognised becomes a generic 500 with the detail logged
 * server-side and withheld from the client, because an unexpected error is exactly
 * the case where the message is most likely to contain a file path, a query, or a
 * credential.
 */
export function toErrorResponse(error: unknown, c: Context): Response {
  if (error instanceof HttpError) {
    return c.json(
      envelope(error.code, error.message, error.details),
      STATUS_BY_CODE[error.code] as 400,
    );
  }

  if (error instanceof AuthorizationError) {
    return c.json(envelope(error.code, error.message), error.status);
  }

  if (error instanceof z.ZodError) {
    // Field-level detail is safe and useful: it describes the request the client
    // just sent, not the server's internals.
    const details: Record<string, string> = {};
    for (const issue of error.issues) {
      details[issue.path.join('.') || '_'] = issue.message;
    }
    return c.json(envelope('bad_request', 'The request could not be validated.', details), 400);
  }

  if (error instanceof ProviderError) {
    // The model provider failed. Distinct from an internal fault, because the fix
    // is different: wait and retry, or check the API key.
    return c.json(
      envelope(
        'upstream_failed',
        'The model provider could not be reached. Try again in a moment.',
      ),
      502,
    );
  }

  if (error instanceof IngestionInProgressError) {
    return c.json(envelope('conflict', error.message), 409);
  }

  /**
   * Out of allowance. `Retry-After` is set as well as the message, because it is the
   * header a client library acts on without being told to — a 429 carrying only prose
   * leaves every caller to invent its own backoff, and the ones that invent badly retry
   * immediately. `rate_limited` was declared in `apiErrorSchema` from the start and had
   * no producer until now.
   */
  if (error instanceof RateLimitError) {
    c.header('Retry-After', String(error.retryAfterSeconds));
    return c.json(envelope('rate_limited', error.message), 429);
  }

  /**
   * A refused account change: editing your own role, or removing the last
   * administrator. The message is written for the administrator reading it and names
   * what to do instead, so it is forwarded. 409 rather than 400 because the request was
   * well formed — it conflicts with the state of the system, which is a different thing
   * and a different fix.
   */
  if (error instanceof UserManagementError) {
    return c.json(envelope('conflict', error.message), 409);
  }

  // A missing or undecryptable credential. The message is written to be
  // actionable and carries nothing internal, so it is forwarded. Matched on the
  // type: this was previously a regex over the message text, which put the
  // message and its matcher in different files and would have forwarded any
  // internal error that happened to mention an API key.
  if (error instanceof ConfigurationError) {
    return c.json(envelope('bad_request', error.message), 400);
  }

  console.error('[api] unhandled error:', error);
  return c.json(
    envelope('internal', 'Something went wrong on our side. The error has been logged.'),
    500,
  );
}
