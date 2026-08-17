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

  DATABASE_PATH: z.string().default('./data/sorrel.db'),
  CORPUS_PATH: z.string().default('./sample_dataset/corpus'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().default('http://localhost:4000'),
  WEB_URL: z.string().default('http://localhost:3000'),

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

  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
} as const;

export type Config = typeof config;

// The API key is resolved in settings.ts rather than here, because it can come
// from the database as well as the environment and this module must not depend
// on the database — db/client.ts imports it.
