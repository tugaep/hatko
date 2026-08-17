/**
 * Turning a natural-language question into an FTS5 MATCH expression.
 *
 * This is not optional sanitisation — FTS5 has a query grammar, and a plain
 * question is usually invalid in it. "What is the maximum file size for an
 * AppLovin playable, and how does it ship?" fails outright: bare `AND` and `OR`
 * are operators, `-` negates, `*` globs, `:` is a column filter, and an unbalanced
 * quote or parenthesis is a syntax error. Passing user text through raw means the
 * keyword arm throws on ordinary questions.
 *
 * The approach: extract word tokens, drop stopwords, quote each one as a literal
 * phrase, and OR them together. Quoting neutralises every operator character, so
 * no input can alter the query's structure.
 */

/**
 * Deliberately short. FTS5's porter tokenizer has no stoplist, and BM25 already
 * discounts common terms by inverse document frequency — so this only needs to
 * remove the words that are pure noise in a question ("what", "how", "does"),
 * not to do BM25's job for it.
 */
const STOPWORDS = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'get',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/**
 * Words are letters, digits and internal dots or hyphens, so identifiers survive
 * intact: `lumen.track`, `sdk-notes-v3` and `4.2` are exactly the tokens that
 * distinguish documents in this corpus, and splitting them would throw away the
 * most discriminating terms in a technical question.
 */
const TOKEN_RE = /[\p{L}\p{N}]+(?:[.\-_][\p{L}\p{N}]+)*/gu;

export function extractTerms(query: string): string[] {
  const raw = query.toLowerCase().match(TOKEN_RE) ?? [];
  const terms = raw.filter((term) => term.length > 1);

  const meaningful = terms.filter((term) => !STOPWORDS.has(term));
  // A query made entirely of stopwords ("what is it") still deserves an attempt;
  // returning nothing would drop the keyword arm without explanation.
  const chosen = meaningful.length > 0 ? meaningful : terms;

  return [...new Set(chosen)];
}

/**
 * Build an FTS5 MATCH expression, or null when there is nothing usable to match.
 *
 * Null is a real outcome — a query of only punctuation or single characters has
 * no keyword arm — and callers must fall back to vector-only rather than passing
 * an empty string to MATCH, which is itself a syntax error.
 */
export function toFtsQuery(query: string): string | null {
  const terms = extractTerms(query);
  if (terms.length === 0) return null;

  // Escaping doubles any embedded quote, per FTS5's string literal rules. Since
  // the whole term is then wrapped in quotes, every other special character —
  // AND, OR, NOT, NEAR, *, ^, :, -, (, ) — is treated as ordinary text.
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}
