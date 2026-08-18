import { z } from 'zod';
import { sseData } from '@hatko/shared';
import { config } from '../config.ts';
import { activeModels, requireApiKey, resolveApiKey } from '../settings.ts';

/**
 * Minimal OpenAI-protocol client over stdlib fetch.
 *
 * Hand-written rather than pulling in the SDK: this project calls exactly two
 * endpoints, and the parts that actually matter here — retry policy, honouring
 * Retry-After, and turning a provider failure into an error message that says
 * what to do — are the parts worth owning rather than inheriting.
 *
 * It is the *protocol* that is OpenAI's, not necessarily the server. `OPENAI_BASE_URL`
 * points this at any host serving the same two endpoints, which is how the system runs
 * on self-hosted models without a second client existing. The only behavioural
 * difference is below: OpenAI requires a key and needs the `dimensions` parameter, and
 * a local server generally wants neither.
 */

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

/**
 * Whether a provider failure is the operator's configuration rather than the weather.
 *
 * These two are not the same failure and must not read as the same message. A 401 means
 * the key is wrong and will be wrong on every retry; a refused connection or a 503 means
 * try again. Reported identically — as "the model provider could not be reached" — the
 * one failure a person can actually fix is described as the one they cannot, which is
 * exactly what happened on the first deployment: a rejected key sent an operator to check
 * DNS, firewall rules and egress on a server whose connectivity was perfect.
 *
 * Naming a rejected credential leaks nothing. It is a fact about this system's own
 * configuration, not about the provider's response, and only an authenticated caller ever
 * sees it.
 */
export function isCredentialFailure(error: ProviderError): boolean {
  return error.status === 401 || error.status === 403;
}

/** What to tell a caller when a provider call failed. Never carries the provider's body. */
export function providerFailureText(error: ProviderError): string {
  return isCredentialFailure(error)
    ? 'The model provider rejected the configured API key. An administrator can set a working key on the dashboard.'
    : 'The model provider could not be reached. Try again in a moment.';
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
  // Resolved per request, not read from `config`, because an admin can change the
  // provider from the settings page and the change has to reach the next call rather
  // than the next restart.
  const provider = activeModels();
  // Mandatory against OpenAI, optional against a self-hosted server — but still sent
  // when one is configured, because vLLM and friends can be started with `--api-key`
  // and a local deployment on a shared network should be able to use it.
  const apiKey = provider.isOpenAI ? requireApiKey() : resolveApiKey();
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
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
      // Named, because against a self-hosted server this is the usual failure and the
      // usual cause is that nothing is listening: "fetch failed" sends the reader
      // looking at the application, and the address it could not reach sends them to
      // the model server they forgot to start.
      lastError = new ProviderError(
        `Request to ${provider.providerLabel}${path} failed: ${(cause as Error).message}` +
          (provider.isOpenAI ? '' : ` (is the model server at ${provider.baseUrl} running?)`),
        { retryable: true, cause },
      );
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
      throw new ProviderError(
        `${provider.providerLabel} rejected the API key (401). ` +
          'Check OPENAI_API_KEY in .env, or the key in the admin settings page.',
        { status: 401 },
      );
    }
    if (response.status === 400) {
      throw new ProviderError(
        `${provider.providerLabel} rejected the request (400): ${detail.slice(0, 300)}`,
        { status: 400 },
      );
    }
    // A local server answers 404 for a model it has not pulled, which is a
    // configuration mistake rather than an outage — retrying it four times only
    // delays the message that names the fix.
    if (response.status === 404 && !provider.isOpenAI) {
      throw new ProviderError(
        `${provider.providerLabel} has no such model or endpoint (404) for ${path}: ` +
          `${detail.slice(0, 200)}. Check EMBEDDING_MODEL, ANSWER_MODEL and RERANK_MODEL ` +
          'name models the server has actually pulled.',
        { status: 404 },
      );
    }

    lastError = new ProviderError(
      `${provider.providerLabel} returned ${response.status} for ${path}: ${detail.slice(0, 300)}`,
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

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * Ask the configured server which models it can serve.
 *
 * Not part of answering anything — it exists so the admin settings page can tell an
 * operator that the local model they just selected is not installed, instead of letting
 * them discover it as a 404 on someone's first question.
 *
 * Deliberately outside `post`: no retries and a short timeout, because this runs while
 * an admin waits for a page and "the server is not running" is the answer, not a
 * condition to back off from. It never throws — an unreachable provider is a normal
 * state for this call to report.
 */
export async function listModels(
  baseUrl: string,
  apiKey: string | null,
): Promise<{ reachable: boolean; models: string[]; error: string | null }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return {
        reachable: false,
        models: [],
        error: `The provider answered ${response.status} when asked for its model list.`,
      };
    }

    const parsed = modelListSchema.safeParse(await response.json());
    if (!parsed.success) {
      // A server that answers but does not serve this endpoint is reachable, and the
      // right move is to stop claiming to know what it has rather than to call it down.
      return { reachable: true, models: [], error: 'The provider did not return a model list.' };
    }

    return { reachable: true, models: parsed.data.data.map((model) => model.id), error: null };
  } catch (cause) {
    return {
      reachable: false,
      models: [],
      error: `Could not reach ${baseUrl}: ${(cause as Error).message}`,
    };
  }
}

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
      {
        model: config.embeddingModel,
        input: batch,
        // `dimensions` is OpenAI's Matryoshka truncation, specific to
        // text-embedding-3-*. A self-hosted model has one native width and no way to
        // honour a request for another, so asking is at best ignored and at worst a
        // 400. The width is verified on the response below either way, which is the
        // check that actually protects the vector column.
        ...(activeModels().isOpenAI ? { dimensions: config.embeddingDimensions } : {}),
      },
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
            `expected ${config.embeddingDimensions}. Set EMBEDDING_DIMENSIONS=${item.embedding.length}, ` +
            'then rebuild the index: npm run db:reset && npm run ingest. The vector column is ' +
            'created at the configured width and cannot hold two widths at once.',
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
