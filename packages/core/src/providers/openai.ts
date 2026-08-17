import { z } from 'zod';
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

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const apiKey = requireApiKey();
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(60_000),
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

    if (response.ok) return response.json();

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
