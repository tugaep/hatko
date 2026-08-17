'use client';

import type { AnswerResponse, Citation, SearchResult } from '@sorrel/shared';
import { PressedLeafSpecimen } from './marks.tsx';
import { Eyebrow, cx } from './ui.tsx';

/**
 * The answer, rendered as a document rather than a chat bubble.
 *
 * That is the show-your-work principle in layout form: prose capped at 68ch, citations
 * as the load-bearing element rather than a footnote, and the abstain state given the
 * same care as a successful answer.
 */

/** Matches the markers the answer model emits. Validated server-side before it gets here. */
const MARKER = /\[(\d+)\]/g;

export function Answer({
  response,
  onCitationClick,
}: {
  response: AnswerResponse;
  /** Scrolls the matching source card into view and promotes it briefly. */
  onCitationClick: (chunkId: number) => void;
}) {
  const byIndex = new Map(response.citations.map((citation) => [citation.index, citation]));
  const passages = new Map(response.sources.map((source) => [source.chunkId, source]));

  return (
    // Polite, not assertive: an answer arriving is new content, not an interruption.
    <div aria-live="polite" className="max-w-[68ch]">
      {response.abstained ? (
        <Abstained />
      ) : (
        <>
          {response.deprecationNotices.length > 0 && (
            <DeprecationNotices notices={response.deprecationNotices} />
          )}
          <div className="rise text-body text-text">
            {response.answer.split(/\n{2,}/).map((paragraph, i) => (
              <p key={i} className={i > 0 ? 'mt-4' : undefined}>
                {renderWithCitations(paragraph, byIndex, passages, onCitationClick)}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The most important state in the application, and not an error.
 *
 * No clay, no warning icon, no apology. Styling this as a failure would teach people
 * that honesty is a malfunction — so it gets a specimen plate and a flat statement of
 * fact, and the nearest passages stay on screen so the reader can judge the miss.
 */
function Abstained() {
  return (
    <div className="rise flex flex-col items-center border border-rule bg-bg-raised px-6 py-10 text-center">
      <PressedLeafSpecimen />
      <h2 className="font-display text-h2 mt-4 text-text">No documents cover this.</h2>
      <p className="mt-2 max-w-[46ch] text-body-sm text-text-muted">
        Hatko answers only from the indexed corpus. Nothing in it addresses this question — the
        nearest passages it found are listed alongside, so you can judge the miss yourself.
      </p>
    </div>
  );
}

function DeprecationNotices({ notices }: { notices: AnswerResponse['deprecationNotices'] }) {
  return (
    <div className="fade mb-4 border border-danger bg-danger-subtle p-3">
      <Eyebrow className="text-text">Deprecated sources</Eyebrow>
      <ul className="mt-2 grid gap-1">
        {notices.map((notice) => (
          <li key={notice.sourcePath} className="text-body-sm text-text">
            <span className="font-semibold">{notice.documentTitle}</span> is superseded
            {notice.supersededBy ? ` by ${notice.supersededBy}` : ''}.{' '}
            <span className="text-mono font-mono">{notice.sourcePath}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Split prose on citation markers and swap each one for a chip.
 *
 * A marker with no matching citation is left as plain text rather than dropped: the
 * server already strips invented markers, so anything reaching here is real, and
 * silently deleting characters from an answer is worse than showing them.
 */
function renderWithCitations(
  text: string,
  byIndex: Map<number, Citation>,
  passages: Map<number, SearchResult>,
  onClick: (chunkId: number) => void,
) {
  return text.split(MARKER).map((part, i) => {
    // split() with one capture group alternates literal, capture, literal, …
    if (i % 2 === 0) return part;

    const citation = byIndex.get(Number(part));
    if (!citation) return `[${part}]`;

    return (
      <CitationChip
        key={i}
        citation={citation}
        passage={passages.get(citation.chunkId)}
        onClick={() => onClick(citation.chunkId)}
      />
    );
  });
}

function CitationChip({
  citation,
  passage,
  onClick,
}: {
  citation: Citation;
  passage: SearchResult | undefined;
  onClick: () => void;
}) {
  return (
    <span className="group relative inline-block align-baseline">
      <button
        type="button"
        onClick={onClick}
        aria-label={`Source ${citation.index}: ${citation.documentTitle}`}
        className={cx(
          'hit-touch text-mono-label rounded-sm bg-attention-subtle px-1 py-px align-[0.1em] font-mono',
          'text-text transition-colors duration-120 ease-brand hover:bg-attention',
        )}
      >
        {citation.index}
      </button>

      {/*
       * L3 — the one level allowed the system's single shadow token. A layer floating
       * over prose cannot separate itself with a border alone, because the value behind
       * it is unknown.
       */}
      <span
        role="tooltip"
        className={cx(
          'pointer-events-none invisible absolute bottom-full left-0 z-20 mb-2 w-72 max-w-[min(18rem,calc(100vw-2rem))]',
          'translate-y-1 border border-border-interactive bg-bg-raised p-3 opacity-0 shadow-[var(--shadow-overlay)]',
          'transition-[opacity,transform] duration-180 ease-brand',
          'group-hover:visible group-hover:translate-y-0 group-hover:opacity-100',
          'group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100',
        )}
      >
        <span className="block text-h4 text-text">{citation.documentTitle}</span>
        <span className="text-mono mt-0.5 block truncate font-mono text-text-muted">
          {citation.sourcePath}
        </span>
        {passage && (
          <span className="mt-2 block line-clamp-4 text-caption text-text-muted">
            {passage.content}
          </span>
        )}
      </span>
    </span>
  );
}
