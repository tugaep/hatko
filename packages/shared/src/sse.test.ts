import test from 'node:test';
import assert from 'node:assert/strict';
import { sseData } from './sse.ts';

/**
 * SSE framing, and specifically the failure modes that are invisible until they are not.
 *
 * Every case here is a chunk boundary landing somewhere awkward. That class of bug does
 * not fail loudly — it produces a dropped word, a replacement character, or a lost final
 * token, on some requests and not others, depending on how the network happened to split
 * the response. The only way to see it is to choose the splits deliberately.
 */

/** A stream that delivers exactly these byte chunks, so the splits are the test. */
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(chunks: Array<string | Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of sseData(streamOf(chunks))) out.push(data);
  return out;
}

test('whole events in one chunk are read in order', async () => {
  assert.deepEqual(await collect(['data: one\n\ndata: two\n\n']), ['one', 'two']);
});

test('an event split across two chunks is reassembled', async () => {
  // The realistic case: a payload straddles a read. Buffering wrongly here loses or
  // duplicates the event, and only under whatever chunk sizes the network chose.
  assert.deepEqual(await collect(['data: hel', 'lo world\n\n']), ['hello world']);
});

test('a split inside the event separator is not read as two events', async () => {
  assert.deepEqual(await collect(['data: one\n', '\ndata: two\n\n']), ['one', 'two']);
});

test('a multi-byte character split across chunks survives intact', async () => {
  // The three bytes of an em dash, cut after the first. Decoding each chunk
  // independently yields replacement characters — a corrupted word mid-answer.
  const bytes = new TextEncoder().encode('data: a—b\n\n');
  assert.deepEqual(await collect([bytes.slice(0, 8), bytes.slice(8)]), ['a—b']);
});

test('a final event with no trailing blank line is not dropped', async () => {
  // OpenAI closes after `[DONE]`, and our own stream closes after its terminal event.
  // Discarding the buffer at end-of-stream loses the last thing either one said.
  assert.deepEqual(await collect(['data: first\n\ndata: last\n']), ['first', 'last']);
});

test('comment keep-alives and unused fields yield nothing', async () => {
  // A proxy inserting `: ping` must not surface as an empty answer fragment.
  assert.deepEqual(await collect([': ping\n\nevent: x\nid: 7\n\ndata: real\n\n']), ['real']);
});

test('multiple data lines in one event join with a newline', async () => {
  // The spec's rule, and how a payload containing a blank line survives the wire.
  assert.deepEqual(await collect(['data: line one\ndata: line two\n\n']), ['line one\nline two']);
});

test('only the single framing space is stripped from a payload', async () => {
  // `data:  x` carries a leading space that is part of the value, not the framing.
  assert.deepEqual(await collect(['data:  indented\n\n', 'data:no-space\n\n']), [
    ' indented',
    'no-space',
  ]);
});

test('CRLF line endings are accepted', async () => {
  assert.deepEqual(await collect(['data: one\r\n\r\ndata: two\r\n\r\n']), ['one', 'two']);
});

test('an empty data line yields an empty payload rather than nothing', async () => {
  // Distinct from a comment: the event exists and carries an empty string.
  assert.deepEqual(await collect(['data:\n\n']), ['']);
});
