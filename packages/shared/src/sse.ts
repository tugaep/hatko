/**
 * Reading a Server-Sent Events stream.
 *
 * The one piece of non-schema code in this package, and it is here because there are two
 * consumers on opposite sides of the boundary: `packages/core` reads OpenAI's streaming
 * completions, and `apps/web` reads this application's own `/api/answer` stream. Both need
 * exactly the same thing — turn a byte stream into the `data:` payloads it carries — and
 * the fiddly part is identical in both: a chunk boundary can land in the middle of a line,
 * in the middle of an event, or in the middle of a multi-byte character.
 *
 * Two copies of buffering logic is how one of them ends up subtly wrong on a payload that
 * happens to straddle a read, which is a bug that appears only under load and only
 * sometimes. There is no dependency to add here — `EventSource` cannot be used for either
 * case, since it is GET-only and OpenAI's stream is a POST, as is ours.
 */

/**
 * Extract the data payload from one SSE event block, or null if it carries none.
 *
 * Comment lines (`:` prefix, used as keep-alives) and fields this application does not use
 * (`event:`, `id:`, `retry:`) are skipped rather than treated as an error — an SSE reader
 * that rejects fields it does not recognise breaks the moment a proxy inserts a heartbeat.
 * Multiple `data:` lines in one event concatenate with a newline, which is the spec's rule
 * and is how a payload containing a blank line survives the wire.
 */
function dataOf(block: string): string | null {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  // A single optional space after the colon is part of the framing, not the payload.
  return lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
}

/**
 * Yield each `data:` payload from an SSE byte stream, in order.
 *
 * `TextDecoder` is given `{ stream: true }` so a multi-byte character split across two
 * reads is reassembled rather than turned into a replacement character — which for this
 * application would be a corrupted word appearing mid-answer, occasionally, depending on
 * chunk sizes.
 *
 * The trailing buffer is flushed at the end because a stream may close without the blank
 * line that would terminate its last event. Dropping it would silently lose the final
 * token of an answer.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. CRLF is accepted as well as LF, because the
      // separator is whatever survived the last proxy.
      const blocks = buffer.split(/\r?\n\r?\n/);
      // The last element is an incomplete event, or empty. Either way it stays buffered.
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const data = dataOf(block);
        if (data !== null) yield data;
      }
    }

    const trailing = dataOf(buffer);
    if (trailing !== null) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
