'use client';

import type { AnswerResponse, Citation } from '@hatko/shared';
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

  return (
    // The live region is mounted by the parent and never unmounts, so this content
    // arriving inside it is an announcement. A region inserted together with its own
    // content is not announced by most assistive tech, which is what shipped first.
    <div className="max-w-[68ch]">
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
                {renderWithCitations(paragraph, byIndex, onCitationClick)}
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
        Hatko answers only from the indexed corpus, and nothing in it addresses this question. The
        nearest passages it found are listed alongside, with their scores.
      </p>
      {/*
       * Not a dead end. The question is already recorded in the corpus-gap list an admin
       * reads on the dashboard, so saying so turns a refusal into the first half of a
       * loop. Stated rather than linked: a regular user cannot open that page.
       */}
      <p className="mt-4 max-w-[46ch] border-t border-rule pt-4 text-caption text-text-muted">
        This question is recorded as a corpus gap. An administrator sees it on the dashboard as a
        document worth writing.
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
  onClick: (chunkId: number) => void,
) {
  return text.split(MARKER).map((part, i) => {
    // split() with one capture group alternates literal, capture, literal, …
    if (i % 2 === 0) return part;

    const citation = byIndex.get(Number(part));
    if (!citation) return `[${part}]`;

    return <CitationChip key={i} citation={citation} onClick={() => onClick(citation.chunkId)} />;
  });
}

/**
 * A citation marker. Click scrolls to the source card and promotes it for 1.2s.
 *
 * **There is deliberately no hover popover here, and design.md §8 asks for one.** It was
 * built, measured, and removed, and the reasoning is worth keeping because the deviation
 * is visible:
 *
 * It duplicated the rail. The popover showed the document title, the path and the first
 * four lines of the passage — all of which sit in a source card a few inches to the right,
 * permanently visible, with the *whole* passage and the retrieval scores. Clicking already
 * takes the reader there.
 *
 * And it could not be positioned correctly without JavaScript. Anchored left, it projected
 * 275 unreachable pixels past the right edge of a phone — and being `position: absolute`,
 * it widened the document even while hidden, for readers who never hovered. Centred, it
 * moved the same overflow to the left edge (measured: `left: -182` in a 1280 viewport).
 * Fixing it properly means measuring on pointerenter and positioning a `fixed` layer,
 * which is real machinery for an affordance that repeats what is already on screen.
 *
 * The `aria-label` carries the same information for anyone who cannot see the rail, which
 * is the part that actually had to work.
 */
function CitationChip({ citation, onClick }: { citation: Citation; onClick: () => void }) {
  return (
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
  );
}
