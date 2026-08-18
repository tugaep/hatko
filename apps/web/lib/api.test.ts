import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ApiRequestError, isAuthError, messageOf, parseResponse } from './api.ts';

/**
 * The one boundary where an API response becomes either typed data or something a
 * person can read.
 *
 * It gets a test because every failure it mishandles is a failure the user sees
 * wrongly rather than a crash anyone would notice. A validation error whose `details`
 * are dropped renders a form with no field marked; a 502 from the reverse proxy — HTML,
 * not this application's envelope — parsed optimistically would throw
 * `Cannot read properties of null` deep inside a component instead of saying the API is
 * unreachable. Both look like "the page is broken" and neither reaches a log that names
 * the cause.
 */

const body = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const schema = z.object({ ok: z.literal(true) });

const envelope = (code: string, message: string, details?: Record<string, string>) => ({
  error: { code, message, ...(details ? { details } : {}) },
});

test('a valid body is returned parsed, not merely passed through', async () => {
  const parsed = await parseResponse(body({ ok: true, extra: 'ignored' }, 200), schema);
  assert.deepEqual(parsed, { ok: true }, 'undeclared fields are stripped by the schema');
});

test('an enveloped error keeps its code, message and field detail', async () => {
  const response = body(envelope('bad_request', 'Query is required.', { query: 'Required' }), 400);

  const error = await parseResponse(response, schema).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ApiRequestError);
  assert.equal(error.status, 400);
  assert.equal(error.code, 'bad_request');
  assert.equal(error.message, 'Query is required.');
  assert.deepEqual(error.details, { query: 'Required' }, 'field detail survives the boundary');
});

test('a non-2xx that is not our envelope names the status rather than guessing', async () => {
  // What a reverse proxy returns when the API process is down: HTML, no envelope.
  const response = new Response('<html>502 Bad Gateway</html>', { status: 502 });

  const error = await parseResponse(response, schema).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ApiRequestError);
  assert.equal(error.status, 502);
  assert.equal(error.code, 'malformed');
  assert.match(error.message, /502/);
});

test('a 2xx body the page cannot read is a version mismatch, not data', async () => {
  const error = await parseResponse(body({ ok: 'yes' }, 200), schema).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ApiRequestError);
  assert.equal(error.code, 'malformed');
  assert.match(error.message, /different version/i);
});

test('a 200 with no body at all does not crash the parser', async () => {
  const error = await parseResponse(new Response('', { status: 200 }), schema).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ApiRequestError, 'an unparseable body is an error, not a throw');
  assert.equal(error.code, 'malformed');
});

/**
 * The status is not always available. A failure on a streamed answer arrives inside a
 * 200 that was committed before the first token, so "sign in again" has to be readable
 * from the code as well.
 */
test('an expired session is recognised by status and by code alike', () => {
  assert.equal(isAuthError(new ApiRequestError(401, 'unauthorized', 'x')), true);
  assert.equal(isAuthError(new ApiRequestError(403, 'forbidden', 'x')), true);
  assert.equal(isAuthError(new ApiRequestError(200, 'unauthorized', 'mid-stream')), true);
  assert.equal(isAuthError(new ApiRequestError(429, 'rate_limited', 'x')), false);
  assert.equal(isAuthError(new Error('unauthorized')), false, 'the word alone is not a session');
});

test('every failure yields a message, including ones that are not Errors', () => {
  assert.equal(
    messageOf(new ApiRequestError(404, 'not_found', 'No such document.')),
    'No such document.',
  );
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf('boom'), 'Something went wrong.');
});
