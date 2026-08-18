'use client';

import type { AnswerResponse, Citation } from '@hatko/shared';
import { PressedLeafSpecimen } from './marks.tsx';
import { cx } from './ui.tsx';

/**
 * The answer, and the sources it stands on.
 *
 * Rebuilt from scratch after a review of the live page. Two things were structurally
 * wrong, and both were about what the design made important:
 *
 * 1. **The citation was the weakest mark on the page.** The bridge between a claim and its
 *    evidence was an 11px pale chip at the end of a sentence, in a product whose whole
 *    promise is that every claim carries its source. It is now a bordered, underlined
 *    target with a real hit area, and it is no longer the only route to the evidence.
 * 2. **The answer could not be checked without leaving it.** Knowing which passages an
 *    answer used meant reading a separate rail and matching numbers by eye. The answer now
 *    carries its own short bibliography: one row per cited passage, naming the document,
 *    which jumps to the full passage below.
 *
 * The measure stays at 68ch and the abstain state keeps the care it had. Both of those
 * were right.
 */

/** Matches the markers the answer model emits. Validated server-side before it gets here. */
const MARKER = /\[(\d+)\]/g;

export function Answer({
  response,
  onCitationClick,
}: {
  response: AnswerResponse;
  /** Scrolls the matching passage into view and promotes it briefly. */
  onCitationClick: (chunkId: number) => void;
}) {
  const byIndex = new Map(response.citations.map((citation) => [citation.index, citation]));

  if (response.abstained) return <Abstained />;

  return (
    <div className="max-w-[68ch]">
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

      {response.citations.length > 0 && (
        <CitedSources citations={response.citations} onCitationClick={onCitationClick} />
      )}
    </div>
  );
}

/**
 * The answer while it is still being written.
 *
 * Deliberately plainer than the finished article: no citation targets, no bibliography, no
 * deprecation caveat, no `rise` entrance. Every one of those would be a claim this text has
 * not earned yet. The markers in it have not been checked against the passages, and the
 * whole answer may still be withheld as an abstention once it turns out to cite nothing, so
 * markers stay as the literal `[1]` the model wrote and the caret says it is unfinished.
 *
 * Muted rather than full-strength body text, for the same reason.
 */
export function AnswerDraft({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="max-w-[68ch] text-body text-text-muted">
      {paragraphs.map((paragraph, i) => (
        <p key={i} className={i > 0 ? 'mt-4' : undefined}>
          {paragraph}
          {i === paragraphs.length - 1 && <span className="caret" aria-hidden="true" />}
        </p>
      ))}
    </div>
  );
}

/**
 * What the answer actually leaned on, listed under it.
 *
 * Six passages are retrieved and an answer typically cites one or two. Before this, working
 * out which one meant scanning six cards for a badge. Naming them here means the answer and
 * its evidence can be read as one thing, and the row is the same jump the inline marker is,
 * so a reader who missed a 12px marker mid-sentence still has a way through.
 *
 * A list rather than a paragraph of links, because that is what it is, and the count in the
 * heading is stated rather than left to be counted.
 */
function CitedSources({
  citations,
  onCitationClick,
}: {
  citations: Citation[];
  onCitationClick: (chunkId: number) => void;
}) {
  return (
    <div className="mt-6 border-t border-rule pt-3">
      <h3 className="text-caption text-text-muted">
        {citations.length === 1 ? 'Cited one passage' : `Cited ${citations.length} passages`}
      </h3>
      <ul className="mt-2 grid gap-1">
        {citations.map((citation) => (
          <li key={`${citation.index}-${citation.chunkId}`}>
            <button
              type="button"
              onClick={() => onCitationClick(citation.chunkId)}
              className={cx(
                'hit-touch group flex w-full items-baseline gap-2.5 rounded-sm text-left',
                'transition-colors duration-120 ease-brand hover:bg-bg-sunken',
              )}
            >
              <span
                aria-hidden="true"
                className="text-mono-label shrink-0 border border-rule-strong bg-attention-subtle px-1 font-mono text-text"
              >
                {citation.index}
              </span>
              <span className="min-w-0 text-body-sm text-text underline decoration-rule-strong underline-offset-2 group-hover:decoration-text">
                {citation.documentTitle}
              </span>
              {/* The path is the identifying half of a source, so it travels with the
                  title rather than being something the reader has to open a card for. */}
              <span className="text-mono path min-w-0 font-mono text-text-muted">
                {citation.sourcePath}
              </span>
              {citation.isDeprecated && (
                <span className="text-mono-label shrink-0 font-mono uppercase text-attention-text">
                  deprecated
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The most important state in the application, and not an error.
 *
 * No clay, no warning icon, no apology. Styling this as a failure would teach people that
 * honesty is a malfunction, so it gets a specimen plate and a flat statement of fact, and
 * the nearest passages stay on the page so the reader can judge the miss themselves.
 *
 * The copy says "below" rather than "alongside" because the evidence moved: it is a
 * full-width section under the answer now, not a rail beside it.
 */
function Abstained() {
  return (
    <div className="rise flex max-w-[68ch] flex-col items-center border border-rule bg-bg-raised px-6 py-10 text-center">
      <PressedLeafSpecimen />
      <h2 className="font-display text-h2 mt-4 text-text">No documents cover this.</h2>
      <p className="mt-2 max-w-[46ch] text-body-sm text-text-muted">
        Answers come only from the indexed corpus, and nothing in it addresses this question. The
        nearest passages it found are below, with the grade each one was given.
      </p>
      {/*
       * Not a dead end. The question is already recorded in the corpus-gap list an admin
       * reads on the dashboard, so saying so turns a refusal into the first half of a loop.
       * Stated rather than linked: a regular user cannot open that page.
       */}
      <p className="mt-4 max-w-[46ch] border-t border-rule pt-4 text-caption text-text-muted">
        hatko records this question as a corpus gap. An administrator sees it on the dashboard as a
        document worth writing.
      </p>
    </div>
  );
}

/**
 * A superseded document among the sources.
 *
 * Attention, not danger. It was drawn in the danger tone, which is the palette this system
 * reserves for something that went wrong, and a correct answer that mentions a retired
 * document is not that. design.md's own anti-pattern list makes the same point about the
 * abstain state; the reasoning does not stop there.
 */
function DeprecationNotices({ notices }: { notices: AnswerResponse['deprecationNotices'] }) {
  return (
    <div className="fade mb-5 border-l-2 border-attention bg-attention-subtle px-3 py-2.5">
      <ul className="grid gap-1">
        {notices.map((notice) => (
          <li key={notice.sourcePath} className="text-body-sm text-text">
            <span className="font-medium">{notice.documentTitle}</span> is superseded
            {notice.supersededBy ? ` by ${notice.supersededBy}` : ''}.{' '}
            <span className="text-mono font-mono text-text-muted">{notice.sourcePath}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Split prose on citation markers and swap each one for a target.
 *
 * A marker with no matching citation is left as plain text rather than dropped: the server
 * already strips invented markers, so anything reaching here is real, and silently deleting
 * characters from an answer is worse than showing them.
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
 * An inline citation. Click jumps to the passage and promotes it for 1.2s.
 *
 * Drawn as a real control this time. It was a pale fill with no border, which at 11px on a
 * paper background is the lowest-contrast element in the answer, and it is the one element
 * carrying the product's central claim. It now has a border, a baseline underline that
 * strengthens on hover, and a 24px hit area.
 *
 * **There is deliberately no hover popover, and design.md §8 asks for one.** It was built,
 * measured and removed, and the reasoning is worth keeping because the deviation is
 * visible: it duplicated the passage that is already on the page, and it could not be
 * positioned without JavaScript. Anchored left it projected 275 unreachable pixels past the
 * right edge of a phone, and being absolute it widened the document even while hidden, for
 * readers who never hovered. Centred, the same overflow moved to the left edge. The
 * `aria-label` carries the information for anyone who cannot see the passage list, which is
 * the part that actually had to work.
 */
function CitationChip({ citation, onClick }: { citation: Citation; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Source ${citation.index}: ${citation.documentTitle}`}
      className={cx(
        /*
         * No `min-w`, deliberately. A 24px-wide box around a single digit left a visible
         * gap between the marker and the punctuation that follows it, so `change [1].`
         * rendered as `change 1 .`. The vertical hit area stays; the horizontal one is the
         * digit plus its padding, and touch readers get the full-width row in the cited
         * list below, which is a target no inline marker can compete with.
         */
        'text-mono-label mx-px inline-flex min-h-6 items-center justify-center rounded-sm',
        'border border-rule-strong bg-attention-subtle px-1.5 align-[0.15em] font-mono text-text',
        'transition-colors duration-120 ease-brand hover:border-text hover:bg-attention',
      )}
    >
      {citation.index}
    </button>
  );
}
