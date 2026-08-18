export { config, REPO_ROOT, type Config } from './config.ts';
export * from './settings.ts';
export {
  createRateLimiter,
  retrievalRateLimiter,
  RateLimitError,
  type RateLimiter,
  type RateLimiterOptions,
} from './rate-limit.ts';
export * from './db/index.ts';
export * from './db/repository.ts';
export * from './db/stats.ts';
export { getEmbeddingMap, pca3 } from './db/embedding-map.ts';
export * from './ingest/corpus.ts';
export * from './ingest/chunk.ts';
export {
  ingest,
  IngestionInProgressError,
  type IngestOptions,
  type IngestProgress,
  type Embedder,
} from './ingest/pipeline.ts';
export {
  embed,
  embedOne,
  chatJson,
  chatText,
  listModels,
  ProviderError,
} from './providers/openai.ts';
export { hybridSearch, type HybridOptions, type RetrievalArm } from './retrieval/search.ts';
export { extractTerms, toFtsQuery } from './retrieval/query.ts';
export {
  retrieveAndRerank,
  MIN_RERANK_CANDIDATES,
  type RetrieveOptions,
} from './retrieval/retrieve.ts';
export {
  rerank,
  hasGroundedSupport,
  RELEVANCE,
  MIN_USEFUL_GRADE,
  type RerankOptions,
} from './retrieval/rerank.ts';
// The evaluation set is deliberately NOT re-exported. It is a development fixture,
// and shipping it in the package the API imports puts the answers to the eval in
// the server bundle. `eval/run.ts` and the query tests import it by path.
export {
  answerQuestion,
  validateCitations,
  ABSTAIN_MESSAGE,
  type AnswerGenerator,
  type AnswerOptions,
} from './answer/generate.ts';
export {
  getAuth,
  getSessionUser,
  requirePermission,
  requireMcpPermission,
  oauthProtectedResourceMetadata,
  oauthAuthorizationServerMetadata,
  AuthorizationError,
  type Permission,
  type Role,
  type SessionUser,
} from './auth/index.ts';
export { upsertAccount, demoAccounts, type DemoAccount } from './auth/accounts.ts';
export {
  listUsers,
  getUser,
  updateUser,
  UserManagementError,
  UserNotFoundError,
  type ListUsersOptions,
  type ListUsersResult,
  type UpdateUserChanges,
} from './auth/users.ts';
