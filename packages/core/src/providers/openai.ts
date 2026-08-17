import { z } from 'zod';
import { sseData } from '@hatko/shared';
import { config } from '../config.ts';
import { requireApiKey } from '../settings.ts';

/**
 * Minimal OpenAI client over stdlib fetch.
 *
 * Hand-written rather than pulling in the SDK: this project calls exactly two
 * endpoints, and the parts that actually matter here — retry policy, honouring
 * Retry-After, and turning a provider failure into an error message that says
 * what to do — are the parts worth owning rather than inheriting.
 */

const API_BASE = 'https://api.openai.com/v1';

/** Raised for any provider failure. `retryable` tells the caller whether to bother. */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

const embeddingResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
  usage: z.object({ total_tokens: z.number().int() }).optional(),
});

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 429 and 5xx are transient; 4xx otherwise means the request itself is wrong. */
const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/**
 * POST with the retry policy, returning the successful response unread.
 *
 * Split out from `postJson` when streaming arrived: a streaming call needs the response
 * body as a stream, not as parsed JSON, and everything up to that point — the key, the
 * timeout, the backoff, the status classification — is identical. The alternative was a
 * second retry loop, and a retry policy that exists twice is one that will disagree with
 * itself about 429s.
 *
 * Nothing here reads the body on the success path, so a retryable failure is still
 * detected and retried before anything is consumed.
 */
async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const apiKey = requireApiKey();
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        // The timeout applies whether or not the caller supplied a signal. It used
        // to be `signal ?? AbortSignal.timeout(...)`, so passing one — which every
        // request-scoped call does — silently removed the only bound on how long a
        // provider request could hang, on the path a user is waiting on.
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      // Network failure or timeout — no status to reason about, always worth a retry.
      lastError = new ProviderError(`Request to ${path} failed: ${(cause as Error).message}`, {
        retryable: true,
        cause,
      });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }

    if (response.ok) return response;

    const detail = await response.text().catch(() => '');
    const retryable = isRetryableStatus(response.status);

    if (response.status === 401) {
      throw new ProviderError('OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env.', {
        status: 401,
      });
    }
    if (response.status === 400) {
      throw new ProviderError(`OpenAI rejected the request (400): ${detail.slice(0, 300)}`, {
        status: 400,
      });
    }

    lastError = new ProviderError(
      `OpenAI returned ${response.status} for ${path}: ${detail.slice(0, 300)}`,
      { status: response.status, retryable },
    );
    if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

    // Respect Retry-After when the provider tells us how long to wait.
    const retryAfter = Number(response.headers.get('retry-after'));
    const backoff = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff);
  }

  throw lastError ?? new ProviderError(`Request to ${path} failed`);
}

const postJson = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> =>
  (await post(path, body, signal)).json();

/**
 * Requests are capped by input count rather than token count. The whole sample
 * corpus is about 30k tokens, comfortably inside the per-request limit, so a
 * conservative batch size costs a few extra round trips and removes the need to
 * count tokens accurately before sending.
 */
const EMBEDDING_BATCH_SIZE = 96;

/**
 * Embed texts, preserving input order.
 *
 * The API is documented to return results in request order, but the response
 * carries an explicit index and this reorders by it regardless — a silent
 * misalignment here would attach every vector to the wrong passage, and would
 * show up only as inexplicably poor retrieval.
 */
export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const raw = await postJson(
      '/embeddings',
      { model: config.embeddingModel, input: batch, dimensions: config.embeddingDimensions },
      signal,
    );

    const parsed = embeddingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(`Unexpected embeddings response shape: ${parsed.error.message}`);
    }
    if (parsed.data.data.length !== batch.length) {
      throw new ProviderError(
        `Requested ${batch.length} embeddings but received ${parsed.data.data.length}.`,
      );
    }

    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      if (item.embedding.length !== config.embeddingDimensions) {
        throw new ProviderError(
          `Model ${config.embeddingModel} returned ${item.embedding.length} dimensions, ` +
            `expected ${config.embeddingDimensions}. Update EMBEDDING_DIMENSIONS and re-run migrations.`,
        );
      }
      out.push(item.embedding);
    }
  }

  return out;
}

/** Embed a single text. Convenience for the query side of retrieval. */
export async function embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
  const [vector] = await embed([text], signal);
  if (!vector) throw new ProviderError('Embedding request returned no vector.');
  return vector;
}

// --- chat -------------------------------------------------------------------

const chatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  /** Zero by default: reranking and grounded answering should be reproducible. */
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * A chat completion constrained to return JSON.
 *
 * `response_format: json_object` makes the provider guarantee syntactically valid
 * JSON, which removes a whole class of parse failure. It guarantees nothing about
 * the *shape*, so every caller still validates with a schema — a reranker that
 * silently returned the wrong field names would degrade retrieval invisibly.
 */
export async function chatJson(options: ChatOptions): Promise<unknown> {
  const raw = await postJson(
    '/chat/completions',
    {
      model: options.model,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
    },
    options.signal,
  );

  const parsed = chatResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(`Unexpected chat response shape: ${parsed.error.message}`);
  }

  const content = parsed.data.choices[0]?.message.content;
  if (!content) throw new ProviderError('Chat completion returned no content.');

  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new ProviderError(`Chat completion returned unparseable JSON: ${content.slice(0, 200)}`, {
      cause,
    });
  }
}

/** One streamed chunk. Every field is optional — a keep-alive chunk carries no delta. */
const streamChunkSchema = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() })),
});

export interface ChatTextOptions extends ChatOptions {
  /** Called with each fragment as it arrives. Omit to simply wait for the whole text. */
  onDelta?: (text: string) => void;
}

/**
 * A chat completion returning prose, streamed.
 *
 * **Always streamed, even when nobody is watching.** One code path rather than two, which
 * matters more here than the handful of lines it saves: the incremental path is the one
 * with the interesting failure modes — a chunk boundary inside a multi-byte character, a
 * keep-alive with no delta, a stream that ends without its terminator — and if it were
 * used only by the web UI it would be the path with no test and no CLI exercising it.
 * Callers that want the whole answer just omit `onDelta` and await the return.
 *
 * **Prose rather than the JSON envelope `chatJson` uses.** The answer used to come back as
 * `{"answer":"…"}` and be unwrapped, which bought nothing — a single free-text field gains
 * no safety from being wrapped, and it actively obstructs streaming, since the deltas would
 * be fragments of a JSON string literal that cannot be rendered until the closing quote
 * arrives, complete with escape sequences to decode. Structure is still validated where
 * there is structure to validate: the reranker's grades keep `chatJson`.
 *
 * The text carries no guarantees on its own. `validateCitations` decides which of its
 * markers survive, and the answer layer decides whether it may be published at all.
 */
export async function chatText(options: ChatTextOptions): Promise<string> {
  const response = await post(
    '/chat/completions',
    {
      model: options.model,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 2000,
      stream: true,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
    },
    options.signal,
  );

  if (!response.body) throw new ProviderError('Streaming completion returned no body.');

  let text = '';

  for await (const data of sseData(response.body)) {
    // OpenAI terminates with a literal sentinel rather than by closing the stream.
    if (data === '[DONE]') break;

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      // A single malformed chunk is not worth losing an answer over, and skipping it
      // degrades the text rather than the request. A stream of nothing but malformed
      // chunks still fails, below, as an empty completion.
      continue;
    }

    const parsed = streamChunkSchema.safeParse(chunk);
    if (!parsed.success) continue;

    const delta = parsed.data.choices[0]?.delta?.content;
    if (!delta) continue;

    text += delta;
    options.onDelta?.(delta);
  }

  if (text.length === 0) throw new ProviderError('Streaming completion returned no content.');
  return text;
}
