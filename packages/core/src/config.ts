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
   * Optional here on purpose. Migrations, the dashboard and every read path work
   * without a key; only embedding and answer generation need one, and those
   * modules assert it themselves with an actionable message. Requiring it here
   * would make `npm run db:migrate` fail on a fresh clone for no reason.
   */
  OPENAI_API_KEY: z.string().min(1).optional(),
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

/**
 * Call from any code path that talks to the model provider. Throws with a fix,
 * rather than letting an undefined key surface as a 401 from OpenAI.
 */
export function requireApiKey(): string {
  if (!config.openaiApiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and add your key:\n' +
        '  cp .env.example .env',
    );
  }
  return config.openaiApiKey;
}
