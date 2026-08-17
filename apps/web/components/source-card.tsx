'use client';

import { useState } from 'react';
import type { SearchResult } from '@sorrel/shared';
import { catalogNumber, highlightSegments } from '../lib/format.ts';
import { Badge, Eyebrow, cx } from './ui.tsx';

/**
 * A retrieved passage, shown the way a specimen is labelled: title, provenance,
 * measurements, and the material itself.
 *
 * The scores are on the card deliberately. The product promise is that a result can
 * be interrogated rather than trusted, and a meter without its number is decoration —
 * so every bar carries the figure that produced it.
 */

export function SourceCard({
  result,
  index,
  query,
  domId,
  flashed = false,
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
  /** Set for 1.2s when a citation in the answer points here. */
  flashed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = result.content.length > 320;

  return (
    <article
      id={domId}
      aria-label={`Source ${index}: ${result.documentTitle}`}
      className={cx(
        'scroll-mt-24 border bg-bg-raised transition-colors duration-240 ease-brand',
        flashed ? 'border-border-interactive' : 'border-rule hover:border-rule-strong',
      )}
    >
      {/*
       * Deprecation is a fact the ingest pipeline established, not something inferred
       * from the answer text. It goes above the title because burying it is the failure
       * this strip exists to prevent.
       */}
      {result.isDeprecated && (
        <p className="border-b border-danger bg-danger-subtle px-3 py-2 text-caption text-text">
          <span className="font-semibold">Deprecated.</span>{' '}
          {result.supersededBy ? `Superseded by ${result.supersededBy}.` : 'No replacement named.'}
        </p>
      )}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-h4 text-text">
              <span className="text-mono-label mr-1.5 font-mono text-text-muted">[{index}]</span>
              {result.documentTitle}
            </h3>
            <p
              className="text-mono mt-1 truncate font-mono text-text-muted"
              title={result.sourcePath}
            >
              {result.sourcePath}
            </p>
          </div>
          <span className="text-mono-label shrink-0 pt-1 font-mono uppercase text-text-muted">
            {catalogNumber('DOC', result.documentId)}
          </span>
        </div>

        <ScoreRow result={result} />

        <p
          className={cx(
            'mt-3 text-body-sm whitespace-pre-line text-text',
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
            onClick={() => setExpanded((open) => !open)}
            className="mt-2 rounded-sm text-caption font-medium text-text underline decoration-rule-strong underline-offset-2 transition-colors duration-120 ease-brand hover:decoration-text"
          >
            {expanded ? 'Show less' : 'Show full passage'}
          </button>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{result.category}</Badge>
          {result.heading && <Badge tone="neutral">{result.heading}</Badge>}
          {result.isDeprecated && <Badge tone="danger">Deprecated</Badge>}
        </div>
      </div>
    </article>
  );
}

/**
 * Relevance gets the meter; the retrieval internals get numbers.
 *
 * The fused score is rank-derived — RRF's top result scores the same constant whether
 * it answers the question or is the least bad of 142 — so drawing it as a bar would
 * imply a confidence it cannot carry. The rerank grade is absolute 0..1, which is
 * exactly what a meter means, and it is the number abstention is decided from.
 */
function ScoreRow({ result }: { result: SearchResult }) {
  const parts = [
    result.vectorScore !== null && `vector ${result.vectorScore.toFixed(2)}`,
    result.keywordScore !== null && `bm25 ${result.keywordScore.toFixed(2)}`,
    `fused ${result.score.toFixed(3)}`,
  ].filter(Boolean) as string[];

  return (
    <div className="mt-3 border-t border-rule pt-3">
      {result.rerankScore !== null && (
        <div className="flex items-center gap-2">
          <Eyebrow className="w-20 shrink-0">Relevance</Eyebrow>
          {/* Capped so the meter stays a meter in a wide single-column layout rather than
              stretching into a rule across the card. */}
          <span aria-hidden="true" className="h-[3px] max-w-56 flex-1 bg-bg-sunken">
            <span
              className="block h-full bg-brand"
              style={{ width: `${Math.round(result.rerankScore * 100)}%` }}
            />
          </span>
          <span className="text-mono-label tabular font-mono text-text">
            {result.rerankScore.toFixed(2)}
          </span>
        </div>
      )}
      <p className="text-mono-label mt-2 font-mono tabular text-text-muted">{parts.join(' · ')}</p>
    </div>
  );
}
