export { config, REPO_ROOT, type Config } from './config.ts';
export * from './settings.ts';
export * from './db/index.ts';
export * from './db/repository.ts';
export * from './ingest/corpus.ts';
export * from './ingest/chunk.ts';
export {
  ingest,
  type IngestOptions,
  type IngestProgress,
  type Embedder,
} from './ingest/pipeline.ts';
export { embed, embedOne, chatJson, ProviderError } from './providers/openai.ts';
export { hybridSearch, type HybridOptions, type RetrievalArm } from './retrieval/search.ts';
export { extractTerms, toFtsQuery } from './retrieval/query.ts';
export {
  rerank,
  hasGroundedSupport,
  RELEVANCE,
  MIN_USEFUL_GRADE,
  type RerankOptions,
} from './retrieval/rerank.ts';
export { EVAL_QUESTIONS, ANSWERABLE, UNANSWERABLE, type EvalQuestion } from './eval/questions.ts';
export {
  answerQuestion,
  validateCitations,
  ABSTAIN_MESSAGE,
  type AnswerOptions,
} from './answer/generate.ts';
export {
  auth,
  getSessionUser,
  requirePermission,
  requireUser,
  AuthorizationError,
} from './auth/index.ts';
export { upsertAccount, demoAccounts, type DemoAccount } from './auth/accounts.ts';
export { nodeSqliteDialect } from './db/kysely-dialect.ts';
