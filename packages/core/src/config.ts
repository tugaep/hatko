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

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
}

const env = parsed.data;

/** Absolute path, resolved against the repository root if relative. */
const absolute = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

export const config = {
  repoRoot: REPO_ROOT,
  databasePath: absolute(env.DATABASE_PATH),
  corpusPath: absolute(env.CORPUS_PATH),

  openaiApiKey: env.OPENAI_API_KEY,
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
