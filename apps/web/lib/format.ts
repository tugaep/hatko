/**
 * Display formatting. The brand voice is numbers over adjectives, so these get used
 * everywhere and are worth having in one place — and every timestamp in the API is
 * ISO 8601 with an explicit `Z`, so `new Date` is safe on all of them.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** `17 Aug 2026, 14:32` — fixed locale so the server and the browser agree. */
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : dateTime.format(date);
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** `DOC-0142`, `RUN-0007`, `CHUNK-08` — the catalog number motif. */
export function catalogNumber(prefix: string, id: number, width = 4): string {
  return `${prefix}-${String(id).padStart(width, '0')}`;
}

/**
 * Words too common to be worth marking.
 *
 * Without this, "which languages must every playable ship with" highlighted `with`,
 * `every`, `must` and `the` throughout every passage — which is not emphasis, it is
 * confetti, and it hides the two words that actually matched.
 */
// A space-separated list rather than an array of quoted strings: the same words in a
// fifth of the lines, and the formatter leaves it alone.
const STOPWORDS = new Set(
  `the and for with that this are was were what which who how why when where does did
  from into than then they them their there here have has had but not all any can could
  should would will must may might our your you about every each some most more also
  only just very much many its it is do a an of in on to or be by as at if we us`.split(/\s+/),
);

/**
 * Split a passage on the query's terms so they can be wrapped in `<mark>`.
 *
 * Returns alternating plain/matched segments. Terms are escaped before they reach the
 * expression — a query is user input and `C++ (v2)` would otherwise be an invalid
 * pattern, which is a thrown error in the middle of rendering a result.
 */
export function highlightSegments(text: string, query: string): { text: string; match: boolean }[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));

  // A plural also marks its singular, and vice versa. Not stemming — the retrieval layer
  // has a real porter stemmer for that — just the one inflection common enough that
  // asking about "languages" and seeing "Language" left unmarked reads as a bug.
  const terms = [
    ...new Set(
      words.flatMap((term) =>
        term.endsWith('s') && term.length > 3 ? [term, term.slice(0, -1)] : [term, `${term}s`],
      ),
    ),
  ];

  if (terms.length === 0) return [{ text, match: false }];

  // Longest first: with `language|languages`, the shorter alternative would win and split
  // "languages" into a marked "language" plus a stray "s".
  const pattern = new RegExp(
    `(${[...terms]
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})`,
    'gi',
  );

  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, match: terms.includes(part.toLowerCase()) }));
}
