import path from 'node:path';
import { z } from 'zod';

/**
 * `packages/core/src` -> repository root. Relative paths in `.env` (DATABASE_PATH,
 * CORPUS_PATH) resolve from here so they read the same regardless of which
 * workspace invoked the process.
 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// `process.loadEnvFile` is stdlib (Node 21+), so no dotenv dependency. A missing
// .env is not fatal: every value below has a working default except the API key,
// and the environment may also be populated by the shell or the host platform.
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  // No .env file. Fall through to process.env and the defaults.
}

const envSchema = z.object({
  /**
   * Optional here on purpose, and doubly so now that an admin can set the key
   * from the web UI: at boot there may legitimately be no key anywhere yet.
   * Migrations, the dashboard and every read path work without one. Only
   * embedding and answer generation need it, and they resolve it through
   * settings.ts, which reports an actionable error when it is missing.
   */
  OPENAI_API_KEY: z.string().min(1).optional(),

  /**
   * Where the model API lives. Default is OpenAI itself.
   *
   * This is the whole of "self-hosted models": Ollama, llama.cpp, LM Studio and
   * vLLM all serve the two endpoints this project calls — `/embeddings` and
   * `/chat/completions` — in OpenAI's own request and response shape. So running
   * with no external provider is a different address, not a second client, and
   * certainly not a provider interface with two implementations.
   *
   * What it costs in measured quality, and the two things that have to change with
   * it (vector width, abstain threshold), are in docs/self-hosted.md.
   */
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),

  /**
   * Root application secret. Better Auth signs sessions with it, and settings.ts
   * HKDF-derives an independent key from it to encrypt stored secrets. Optional
   * here so migrations and reads work on a fresh clone; the code paths that
   * genuinely need it fail with instructions for generating one.
   */
  BETTER_AUTH_SECRET: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  ANSWER_MODEL: z.string().default('gpt-4o-mini'),
  RERANK_MODEL: z.string().default('gpt-4o-mini'),

  DATABASE_PATH: z.string().default('./data/hatko.db'),
  CORPUS_PATH: z.string().default('./sample_dataset/corpus'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().default('http://localhost:4000'),
  WEB_URL: z.string().default('http://localhost:3000'),
  MCP_PORT: z.coerce.number().int().positive().default(4100),
  /**
   * Public URL of the MCP endpoint. Advertised to clients as the OAuth `resource`
   * they are getting a token for, so it must be the address they actually dial —
   * behind a reverse proxy that is the public origin, not `localhost:MCP_PORT`.
   */
  MCP_URL: z.string().default('http://localhost:4100/mcp'),

  /**
   * Extra `Host` values the MCP server will answer to, comma-separated.
   *
   * The DNS-rebinding guard accepts every loopback spelling by default, which is right
   * for a laptop and fatal behind a reverse proxy: the proxy forwards the public
   * hostname, the guard does not recognise it, and every request becomes a 403. Adding
   * the deployed hostname here is what makes the control survive deployment instead of
   * being the first thing an operator switches off.
   */
  MCP_ALLOWED_HOSTS: z.string().default(''),

  /**
   * Requests each account may make to the paid retrieval paths per window.
   *
   * Configurable rather than a constant, because this repository has twice had to widen a
   * security control that was blocking legitimate callers — the MCP host guard, for bare
   * `localhost` and then for a proxied hostname — and a limit an operator cannot adjust is
   * the same shape of mistake. Meeting a wall of 429s with no knob is how a protection
   * gets removed instead of tuned.
   *
   * 30 per minute is deliberately generous for a person and still a hard ceiling on the
   * runaway case: an `/answer` costs three provider calls, so this caps one account at
   * roughly 90 a minute rather than at nothing. `0` disables the limiter, which is an
   * escape hatch rather than a suggestion.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(30),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

/**
 * Drop variables that are present but empty, so `KEY=` means "not set".
 *
 * This is not a nicety, it was a fresh-install failure. `.env.example` ships
 * `OPENAI_API_KEY=` with a comment inviting you to leave it blank and enter the key in
 * the admin UI instead — and `process.loadEnvFile` reads that as the empty string, which
 * `z.string().min(1).optional()` rejects, because `.optional()` accepts `undefined` and
 * not `''`. So `cp .env.example .env` made every backend process throw "OPENAI_API_KEY:
 * Too small" at import: migrate, seed, ingest, eval, the API and the MCP server. Measured,
 * not theorised — `npm run setup` died on its first command.
 *
 * Applied to the whole object rather than to that one field, because every `.default()`
 * has the same hole for the same reason: a default fills in for `undefined`, never for
 * `''`, so blanking `EMBEDDING_MODEL=` or `API_PORT=` to "use the default" would fail
 * validation too. One strip fixes the class.
 *
 * Nothing here legitimately means the empty string. `MCP_ALLOWED_HOSTS` comes closest and
 * its default is `''` anyway, so stripping it lands on the same value.
 */
const withoutBlanks = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  ) as Record<string, string>;

const parsed = envSchema.safeParse(withoutBlanks(process.env));

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
}

const env = parsed.data;

/** Absolute path, resolved against the repository root if relative. */
const absolute = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

/**
 * A path as a reader would want to see it: relative to the repository when it is inside it,
 * absolute when it is not.
 *
 * Plain `path.relative` was printing a corpus outside the repository as
 * `../../../../../private/tmp/…/corpus` — longer and harder to read than the absolute path
 * it was shortening, in the exact case the brief cares about, which is pointing CORPUS_PATH
 * at the real corpus somewhere else on disk.
 */
export function displayPath(absolutePath: string): string {
  const relative = path.relative(REPO_ROOT, absolutePath);
  return relative.startsWith('..') ? absolutePath : relative;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * What a base URL means, in the two terms the rest of the code asks about.
 *
 * A function rather than two derived config fields because the address is no longer
 * fixed at boot: an admin can point the system at a different provider from the
 * settings page, and that resolved value needs the same two answers. Deriving them in
 * one place is what stops the startup banner and the live request from disagreeing
 * about which provider is in use.
 */
export function describeProvider(baseUrl: string): { isOpenAI: boolean; label: string } {
  // Trailing slashes stripped, so `http://host/v1/` and `http://host/v1` are one setting.
  const normalised = baseUrl.replace(/\/+$/, '');
  if (normalised === OPENAI_BASE_URL) return { isOpenAI: true, label: 'OpenAI' };
  try {
    return { isOpenAI: false, label: new URL(normalised).host };
  } catch {
    // A stored value can be malformed in a way the boot-time schema never sees. The
    // request will fail regardless; naming the bad address beats throwing from a getter.
    return { isOpenAI: false, label: normalised };
  }
}

const modelBaseUrl = env.OPENAI_BASE_URL.replace(/\/+$/, '');
const { isOpenAI, label: providerLabel } = describeProvider(modelBaseUrl);

export const config = {
  repoRoot: REPO_ROOT,
  databasePath: absolute(env.DATABASE_PATH),
  corpusPath: absolute(env.CORPUS_PATH),

  openaiApiKey: env.OPENAI_API_KEY,
  modelBaseUrl,
  /**
   * True when the provider is OpenAI itself. The one thing that turns on it: an API
   * key is mandatory there and optional against a self-hosted server, which
   * typically wants no credential at all.
   */
  isOpenAI,
  /**
   * Who to name in a provider error. Without this, a refused connection to a local
   * server on port 11434 reported itself as an OpenAI failure and sent the reader
   * to check a key that was never involved.
   */
  providerLabel,
  appSecret: env.BETTER_AUTH_SECRET,
  embeddingModel: env.EMBEDDING_MODEL,
  embeddingDimensions: env.EMBEDDING_DIMENSIONS,
  answerModel: env.ANSWER_MODEL,
  rerankModel: env.RERANK_MODEL,

  apiPort: env.API_PORT,
  apiUrl: env.API_URL,
  webUrl: env.WEB_URL,
  mcpPort: env.MCP_PORT,
  mcpUrl: env.MCP_URL,
  mcpAllowedHosts: env.MCP_ALLOWED_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean),

  rateLimitMax: env.RATE_LIMIT_MAX,
  rateLimitWindowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,

  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
} as const;

export type Config = typeof config;

/** The value `.env.example` ships, so copying it unchanged is caught rather than accepted. */
const PLACEHOLDER_SECRET = 'replace-me-with-a-random-32-byte-secret';

/**
 * The application secret, or an actionable error.
 *
 * One function because there are two consumers — Better Auth's session signing and
 * the HKDF-derived settings encryption key — and they disagreed. Each had its own
 * check: settings refused the `.env.example` placeholder by name, auth tested only
 * the length. The placeholder is 39 characters, so it passed. Anyone who copied the
 * example file unchanged got working sign-in with sessions signed by a value
 * published in this repository, while the settings page correctly refused to
 * encrypt anything. A single gate cannot develop that kind of gap.
 *
 * The secret is a parameter rather than read straight from `config` so a test can
 * drive it. config.ts snapshots process.env at import and loads .env from disk, so
 * a test asserting "the placeholder is refused" would otherwise be asserting
 * something about the developer's machine. Same reason as `resolveApiKey`.
 */
export function requireAppSecret(secret: string | undefined = config.appSecret): string {
  if (!secret || secret === PLACEHOLDER_SECRET) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set to a real value.\n' +
        'Generate one with:  openssl rand -base64 32\n' +
        'then set BETTER_AUTH_SECRET in .env.',
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `BETTER_AUTH_SECRET is ${secret.length} characters; at least 32 are required. ` +
        'Generate one with:  openssl rand -base64 32',
    );
  }
  return secret;
}

// The API key is resolved in settings.ts rather than here, because it can come
// from the database as well as the environment and this module must not depend
// on the database — db/client.ts imports it.
