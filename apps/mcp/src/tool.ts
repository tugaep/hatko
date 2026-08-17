import {
  getDb,
  hasGroundedSupport,
  hybridSearch,
  recordSearchQuery,
  rerank,
  type SessionUser,
} from '@hatko/core';
import { searchRequestSchema, type SearchResult } from '@hatko/shared';

/**
 * The `search_corpus` tool: the same retrieval the chat page runs, addressed by a
 * machine instead of a person.
 *
 * One tool, not two. The HTTP API also exposes `/answer`, which wraps retrieval in
 * an LLM that writes prose and cites it — but an MCP client *is* an LLM, and it has
 * the user's actual question, the conversation around it and its own instructions.
 * Handing it passages lets it do that synthesis with all of that context; handing it
 * our pre-written paragraph throws that context away and asks it to trust a summary
 * it cannot check. Retrieval is the part the client cannot do for itself, so
 * retrieval is what the tool exposes.
 */

/**
 * Input schema, derived from the shared search contract rather than written beside
 * it.
 *
 * Every field comes out of `searchRequestSchema.shape` — the same object the HTTP
 * route validates — so the two surfaces cannot drift into disagreeing about what a
 * valid query is. A 500-character cap on one and a 1000-character cap on the other
 * is exactly the kind of gap that surfaces only as a confusing error from one
 * client.
 *
 * `limit` is unwrapped from its default and made optional. The SDK publishes this
 * shape to clients as JSON Schema, and a required field with a default reads to a
 * caller as something it must send. `.unwrap()` keeps the bounds (1..20) and drops
 * only the default, which the handler reapplies by parsing through the shared
 * schema — so the number 8 is still written down exactly once.
 */
export const searchToolInput = {
  query: searchRequestSchema.shape.query.describe(
    'A natural-language question about the corpus. Full questions retrieve better than keywords, because half the retriever is semantic.',
  ),
  limit: searchRequestSchema.shape.limit
    .unwrap()
    .optional()
    .describe('Passages to return after reranking. Defaults to 8.'),
  category: searchRequestSchema.shape.category.describe(
    'Restrict to one corpus category, e.g. "guides" or "postmortems". Omit to search everything; a wrong guess here silently hides the answer.',
  ),
};

/**
 * Render one passage for a reader that will cite it.
 *
 * Text, not JSON. The consumer is a language model, and the provenance it needs to
 * attribute a claim — which document, which heading, whether the document is still
 * current — reads better as a labelled block than as a nest of quoted keys. The
 * scores are included for the same reason the HTTP API returns them: a client that
 * can see a passage ranked 0.33 can decide not to lean on it.
 */
function renderPassage(result: SearchResult, index: number): string {
  const lines = [
    `[${index + 1}] ${result.documentTitle}`,
    `    source: ${result.sourcePath}  category: ${result.category}`,
  ];

  if (result.heading) lines.push(`    section: ${result.heading}`);

  // Stated before the content, not after it. A model that reads the passage first
  // and the caveat second tends to answer from the passage.
  if (result.isDeprecated) {
    lines.push(
      `    DEPRECATED: this document is superseded${result.supersededBy ? ` by ${result.supersededBy}` : ''}. ` +
        'Say so if you use it, and prefer the current document.',
    );
  }

  lines.push(
    `    relevance: ${result.score.toFixed(3)} fused` +
      (result.rerankScore === null ? '' : `, ${result.rerankScore.toFixed(2)} judged`),
    '',
    result.content,
  );

  return lines.join('\n');
}

/** No results, or nothing relevant enough to answer from. */
function renderAbstention(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No passages in the corpus match "${query}". Tell the user the corpus does not cover this rather than answering from your own knowledge.`;
  }

  // The near misses are still returned. An abstention the client cannot inspect is
  // one it has to take on faith, and a model told only "nothing found" will often
  // fill the silence itself.
  return [
    `No passage in the corpus answers "${query}" well enough to ground an answer on.`,
    'Tell the user the corpus does not cover this. Do not answer from your own knowledge.',
    'The nearest passages are below for context only — they were judged insufficient, so do not cite them as the answer.',
    '',
    results.map(renderPassage).join('\n\n'),
  ].join('\n');
}

/** What `search_corpus` gives back: passage text plus an explicit abstention signal. */
export interface SearchToolResult {
  text: string;
  /** True when the corpus does not support an answer. A correct outcome, not an error. */
  abstained: boolean;
  results: SearchResult[];
}

/**
 * Run a search on behalf of `user`.
 *
 * Takes the already-authorized user rather than the request, so the authorization
 * decision cannot be made here — it has been made before this function is reachable.
 */
export async function runSearchTool(
  user: SessionUser,
  input: { query: string; limit?: number | undefined; category?: string | undefined },
): Promise<SearchToolResult> {
  // Back through the shared schema, which is where `limit`'s default of 8 and the
  // trimming and length bounds live. The SDK has already validated the shape; this
  // applies the contract the HTTP route applies.
  const { query, limit, category } = searchRequestSchema.parse(input);

  const db = getDb();
  const started = performance.now();

  const retrieved = await hybridSearch(db, query, {
    limit,
    ...(category ? { category } : {}),
  });
  const results = await rerank(query, retrieved);
  const latencyMs = Math.round(performance.now() - started);

  const abstained = hasGroundedSupport(results) === false;

  // Recorded with `source: 'mcp'`, so the dashboard's search stats cover the whole
  // system rather than only the queries that came from the browser. The user id is
  // a real account, which is the other half of why the bearer token is a session
  // rather than a shared secret: MCP traffic is attributable.
  recordSearchQuery(db, {
    userId: user.id,
    source: 'mcp',
    query,
    resultCount: results.length,
    topScore: results[0]?.score ?? null,
    abstained,
    latencyMs,
  });

  if (abstained) {
    return { text: renderAbstention(query, results), abstained, results };
  }

  return {
    text: [
      `${results.length} passage${results.length === 1 ? '' : 's'} for "${query}".`,
      'Answer only from these passages, and cite the source path of each one you use.',
      '',
      results.map(renderPassage).join('\n\n'),
    ].join('\n'),
    abstained,
    results,
  };
}
