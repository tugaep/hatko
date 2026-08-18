'use client';

import { useEffect, useState } from 'react';
import { CATEGORY_UNCATEGORISED, type SearchResult } from '@hatko/shared';
import { catalogNumber, highlightSegments } from '../lib/format.ts';
import { Badge, Eyebrow, cx } from './ui.tsx';

/**
 * A retrieved passage, shown the way a specimen is labelled: title, provenance,
 * measurements, and the material itself.
 *
 * The scores are on the card deliberately. The product promise is that a result can
 * be interrogated rather than trusted, and a meter without its number is decoration —
 * so every bar carries the figure that produced it.
 *
 * The card is a disclosure, and which ones start open is the caller's call. Six cards
 * printing a whole document each made the evidence rail 2,271px tall beside a 217px
 * answer — a 10:1 split in favour of passages the answer never cited. Identity and
 * relevance stay in the summary, because that is what the reader triages on; the
 * retrieval internals and the passage itself are what the disclosure holds.
 */

export function SourceCard({
  result,
  index,
  query,
  domId,
  cited = false,
  flashed = false,
  startOpen = false,
}: {
  result: SearchResult;
  /** 1-based marker matching the citation in the answer. */
  index: number;
  query: string;
  /**
   * Supplied by the caller rather than derived from `chunkId`, because the same passage
   * can be cited by two different questions in one session and duplicate element ids
   * would send both citations to whichever card rendered first.
   */
  domId: string;
  /**
   * Whether the answer actually cited this passage.
   *
   * Retrieval returns six; an answer typically cites one or two. Drawing all six
   * identically means the reader has to hold the bracketed numbers from the prose in
   * their head to know which card carried a claim — in a product whose one principle is
   * "every claim carries its source", that is the principle undone in the component
   * built to express it.
   */
  cited?: boolean;
  /** Set for 1.2s when a citation in the answer points here. */
  flashed?: boolean;
  /** Whether the passage body is disclosed on first render. */
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [expanded, setExpanded] = useState(false);
  const long = result.content.length > 320;

  /*
   * Cited status arrives with the validated answer, and the passages were on screen
   * before that — reported early precisely so they can be read during the wait. So a
   * card that turns out to have carried a claim opens itself when that lands. It only
   * ever opens: a card the reader closed by hand stays closed.
   */
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);

  return (
    <article
      id={domId}
      aria-label={`${cited ? 'Cited source' : 'Retrieved passage'} ${index}: ${result.documentTitle}`}
      className={cx(
        'min-w-0 scroll-mt-24 border bg-bg-raised transition-colors duration-240 ease-brand',
        flashed
          ? 'border-border-interactive'
          : cited
            ? 'border-rule-strong hover:border-border-interactive'
            : 'border-rule hover:border-rule-strong',
      )}
    >
      {/*
       * Deprecation is a fact the ingest pipeline established, not something inferred
       * from the answer text. It goes above the title because burying it is the failure
       * this strip exists to prevent — and outside the disclosure, because a closed card
       * must still carry it. Stated once here and once at answer level.
       */}
      {result.isDeprecated && (
        <p className="border-b border-danger bg-danger-subtle px-3 py-2 text-caption text-text">
          <span className="font-semibold">Deprecated.</span>{' '}
          {result.supersededBy ? `Superseded by ${result.supersededBy}.` : 'No replacement named.'}
        </p>
      )}

      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        {/*
         * The native marker is the affordance, which is why nothing here is a flex
         * container — `display: flex` on a summary drops the triangle in Chrome. The
         * heading is `inline` for the same reason: a block child pushes the marker onto
         * a line of its own. `ScoreLegend` in the same rail is a plain `<details>` too,
         * so this is the vocabulary already on screen rather than a new one.
         */}
        {/* `list-outside` so the marker sits in the padding rather than in the flow: an
            inside marker indented the title 12px past the path beneath it. */}
        <summary className="hit-touch list-outside cursor-pointer px-4 py-3 marker:text-text-muted">
          <span className="text-mono-label float-right pt-1 pl-3 font-mono uppercase text-text-muted">
            {catalogNumber('DOC', result.documentId)}
          </span>
          <h3 className="inline text-h4 text-text">
            <span
              className={cx(
                'text-mono-label mr-1.5 rounded-sm px-1 font-mono',
                cited ? 'bg-attention-subtle text-text' : 'text-text-muted',
              )}
            >
              {index}
            </span>
            {result.documentTitle}
          </h3>
          {/* `path`, not `truncate`: the end of a path is the identifying part, and a
              nowrap run forces its grid track wider than the viewport. */}
          <p className="text-mono path mt-1 font-mono text-text-muted">{result.sourcePath}</p>
          <RelevanceMeter score={result.rerankScore} />
          {cited && (
            <span className="mt-2 inline-flex">
              <Badge tone="attention">cited</Badge>
            </span>
          )}
        </summary>

        <div className="px-4 pb-4">
          {/*
           * One figure per row rather than a dot-delimited string. `vector 0.84 · bm25
           * 0.99 · fused 0.174` reads as one opaque token; three labelled columns read as
           * three measurements, which is what they are.
           */}
          <dl className="text-mono-label flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-3 font-mono text-text-muted">
            <Measure label="vector" value={result.vectorScore} digits={2} />
            <Measure label="bm25" value={result.keywordScore} digits={2} />
            <Measure label="fused" value={result.score} digits={3} />
          </dl>

          <p
            className={cx(
              'mt-3 max-w-[68ch] text-body-sm whitespace-pre-line text-text',
              !expanded && long && 'line-clamp-6',
            )}
          >
            {highlightSegments(result.content, query).map((segment, i) =>
              segment.match ? <mark key={i}>{segment.text}</mark> : segment.text,
            )}
          </p>

          {long && (
            <button
              type="button"
              onClick={() => setExpanded((isOpen) => !isOpen)}
              className="hit-touch mt-2 inline-block rounded-sm text-caption font-medium text-text underline decoration-rule-strong underline-offset-2 transition-colors duration-120 ease-brand hover:decoration-text"
            >
              {expanded ? 'Show less' : 'Show full passage'}
            </button>
          )}

          {/* A badge whose value is "no value" is noise; `uncategorised` is the ingest
              fallback for a file at the corpus root, not a category worth labelling. */}
          {(result.category !== CATEGORY_UNCATEGORISED || result.heading) && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {result.category !== CATEGORY_UNCATEGORISED && <Badge>{result.category}</Badge>}
              {result.heading && <Badge>{result.heading}</Badge>}
            </div>
          )}
        </div>
      </details>
    </article>
  );
}

/**
 * Relevance gets the meter; the retrieval internals get numbers.
 *
 * The fused score is rank-derived — RRF's top result scores the same constant whether
 * it answers the question or is the least bad of 142 — so drawing it as a bar would
 * imply a confidence it cannot carry. The rerank grade is absolute 0..1, which is
 * exactly what a meter means, and it is the number abstention is decided from. That is
 * also why it sits in the summary: it is the figure a reader triages a closed card on.
 */
function RelevanceMeter({ score }: { score: number | null }) {
  if (score === null) return null;

  return (
    <span className="mt-3 flex items-center gap-2">
      <Eyebrow as="span" className="w-20 shrink-0">
        Relevance
      </Eyebrow>
      {/* Capped so the meter stays a meter in a wide single-column layout rather than
          stretching into a rule across the card. */}
      <span aria-hidden="true" className="h-[3px] max-w-56 flex-1 bg-bg-sunken">
        <span className="block h-full bg-brand" style={{ width: `${Math.round(score * 100)}%` }} />
      </span>
      {/*
       * A zero-length bar reads as content that failed to render, and in the abstain
       * state every bar is zero — precisely when the reader most needs to trust what
       * they are looking at. The word says what the empty track means.
       */}
      <span className="text-mono-label tabular shrink-0 font-mono text-text">
        {score === 0 ? 'not relevant' : score.toFixed(2)}
      </span>
    </span>
  );
}

/** A single retrieval figure. Null means that arm did not return this passage at all. */
function Measure({
  label,
  value,
  digits,
}: {
  label: string;
  value: number | null;
  digits: number;
}) {
  return (
    <div className="flex gap-1.5">
      <dt>{label}</dt>
      {/*
       * `none` is retrieval evidence — it is how a reader sees that the lexical arm
       * alone found this passage. It was drawn in `--rule-strong`, which computes to
       * 1.65:1 on the card fill: information rendered invisible. Muted carries the
       * de-emphasis at 5.77:1, and the word carries the meaning either way.
       */}
      <dd className={cx('tabular', value === null ? 'text-text-muted' : 'text-text')}>
        {value === null ? 'none' : value.toFixed(digits)}
      </dd>
    </div>
  );
}
