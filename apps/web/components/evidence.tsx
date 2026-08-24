'use client';

import { CATEGORY_UNCATEGORISED, type SearchResult } from '@hatko/shared';
import { catalogNumber, highlightSegments, passageBody } from '../lib/format.ts';
import { Badge, Eyebrow, cx } from './ui.tsx';

/**
 * The passages an answer was built from.
 *
 * Rebuilt from scratch after reviewing the live page, where the evidence was a 400px rail
 * beside a 631px answer. Four things followed from that width and all four were wrong:
 *
 * 1. **The passage had a 40-character measure**, the worst on the page, and the passage is
 *    the thing a reader is here to check. It now runs the full column at 78ch.
 * 2. **Retrieval telemetry outranked it.** Card order was title, path, relevance meter,
 *    cited badge, rule, `vector / bm25 / fused`, and only then the text. Three numbers most
 *    readers never look at sat above the evidence for the claim. The numbers are now under
 *    the passage, in one line.
 * 3. **Getting to a passage took three interactions**: scroll a capped region, open a
 *    `<details>` card, then click "Show full passage" on a clamped paragraph. All six
 *    passages are open now, in one section, and the page scrolls like a page.
 * 4. **Everything weighed the same.** With one of six cited, five cards competed with the
 *    one that mattered. Cited passages come first; the rest sit behind a single disclosure
 *    that says how many there are and that none was used.
 *
 * The section owns the ordering, so a caller passes sources and citations and gets the
 * arrangement. That is deliberate: which passage matters is a fact about the answer, not a
 * layout decision each page should make again.
 */

export function Evidence({
  sources,
  citedChunkIds,
  query,
  domIdFor,
  flashedDomId,
  abstained,
}: {
  /** Reranked passages, in the order retrieval returned them. */
  sources: SearchResult[];
  /** Which of them the validated answer cited. Empty while streaming, and when abstaining. */
  citedChunkIds: Set<number>;
  /** The question, for term highlighting inside the passages. */
  query: string;
  /** Stable element id per passage, so a citation can scroll to it. */
  domIdFor: (chunkId: number) => string;
  /** The passage a citation was just clicked for, promoted briefly. */
  flashedDomId: string | null;
  abstained: boolean;
}) {
  if (sources.length === 0) return null;

  const cited = sources.filter((source) => citedChunkIds.has(source.chunkId));
  const rest = sources.filter((source) => !citedChunkIds.has(source.chunkId));

  return (
    <section
      aria-labelledby="evidence-heading"
      className="mt-10 border-t-2 border-rule-strong pt-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Eyebrow as="h3" id="evidence-heading">
          {abstained ? 'Nearest passages' : 'Evidence'}
        </Eyebrow>
        <p className="text-caption text-text-muted">
          {abstained
            ? `${sources.length} retrieved, none answered the question`
            : `${cited.length} of ${sources.length} passages cited`}
        </p>
      </div>

      {cited.length > 0 && (
        <ol className="mt-4 grid gap-4">
          {cited.map((source) => (
            <li key={source.chunkId} className="min-w-0">
              <Passage
                result={source}
                index={indexOf(sources, source)}
                query={query}
                domId={domIdFor(source.chunkId)}
                flashed={flashedDomId === domIdFor(source.chunkId)}
                cited
              />
            </li>
          ))}
        </ol>
      )}

      {rest.length > 0 && (
        <NotCited
          sources={rest}
          all={sources}
          query={query}
          domIdFor={domIdFor}
          flashedDomId={flashedDomId}
          openByDefault={cited.length === 0}
        />
      )}

      <ScoreLegend />
    </section>
  );
}

/** The passage's number as the reader sees it, which is its retrieval rank, not its tier. */
function indexOf(sources: SearchResult[], source: SearchResult): number {
  return sources.findIndex((candidate) => candidate.chunkId === source.chunkId) + 1;
}

/**
 * Everything retrieved that the answer did not use.
 *
 * One disclosure for the whole group rather than one per card. Six collapsed rows are six
 * decisions a reader has to make about text they have no reason to want yet; a single line
 * saying how many there are and that none was cited is the only thing they need to decide.
 *
 * Open by default when nothing was cited, because in the abstain case these near misses are
 * the entire evidence, and "we found nothing" is a claim the reader should be able to check
 * without opening anything.
 */
function NotCited({
  sources,
  all,
  query,
  domIdFor,
  flashedDomId,
  openByDefault,
}: {
  sources: SearchResult[];
  all: SearchResult[];
  query: string;
  domIdFor: (chunkId: number) => string;
  flashedDomId: string | null;
  openByDefault: boolean;
}) {
  return (
    <details open={openByDefault} className="mt-4 border-t border-rule pt-3">
      {/*
       * The native marker is the affordance, so nothing here is a flex container: `display:
       * flex` on a summary drops the triangle in Chrome. `list-outside` keeps the marker in
       * the padding rather than in the flow.
       */}
      <summary className="hit-touch list-outside cursor-pointer text-body-sm text-text marker:text-text-muted">
        {openByDefault
          ? `${sources.length} nearest passages`
          : `${sources.length} more retrieved, none cited`}
      </summary>
      <ol className="mt-4 grid gap-4">
        {sources.map((source) => (
          <li key={source.chunkId} className="min-w-0">
            <Passage
              result={source}
              index={indexOf(all, source)}
              query={query}
              domId={domIdFor(source.chunkId)}
              flashed={flashedDomId === domIdFor(source.chunkId)}
              cited={false}
            />
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * One passage: what it is, what it says, and how it scored, in that order.
 *
 * That order is the whole redesign. Identity first so the reader knows whose words these
 * are, then the words, then the measurements for anyone who wants to argue with the
 * ranking. Nothing is hidden and nothing is clamped, because a passage in this corpus is
 * about 800 characters and a page is allowed to be long.
 */
function Passage({
  result,
  index,
  query,
  domId,
  flashed,
  cited,
}: {
  result: SearchResult;
  index: number;
  query: string;
  domId: string;
  flashed: boolean;
  cited: boolean;
}) {
  return (
    <article
      id={domId}
      aria-label={`${cited ? 'Cited passage' : 'Retrieved passage'} ${index}: ${result.documentTitle}`}
      className={cx(
        'min-w-0 scroll-mt-24 border-l-2 bg-bg-raised py-3 pl-4 pr-3 transition-colors duration-240 ease-brand',
        flashed ? 'border-border-interactive' : cited ? 'border-brand' : 'border-rule',
      )}
    >
      {/*
       * Deprecation is a fact the ingest pipeline established, not something inferred from
       * the answer text, and it goes above the passage because burying it is the failure
       * this line exists to prevent. Attention rather than danger: a superseded document
       * among the sources is a caveat, and the danger palette is for something broken.
       */}
      {result.isDeprecated && (
        <p className="mb-2 border-l-2 border-attention bg-attention-subtle px-2 py-1 text-caption text-text">
          <span className="font-medium">Deprecated.</span>{' '}
          {result.supersededBy ? `Superseded by ${result.supersededBy}.` : 'No replacement named.'}
        </p>
      )}

      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {/*
         * The rank sits beside the heading, not inside it. Inside, its digit ran straight
         * into the title in the accessible name: the tree read
         * `3Postmortem: November 2025 Analytics Leak`, and marking the span `aria-hidden`
         * did not reliably keep it out of a name computed from the heading contents. The
         * rank is not lost, because the article label above already says
         * "Cited passage 3: Postmortem…" — which is a better phrasing than any prefix
         * inside the heading would be.
         */}
        <span
          aria-hidden="true"
          className="text-mono-label border border-rule-strong px-1 font-mono text-text-muted"
        >
          {index}
        </span>
        <h4 className="text-h4 min-w-0 text-text">{result.documentTitle}</h4>
        {cited && <Badge tone="attention">cited</Badge>}
        <span className="text-mono-label ml-auto shrink-0 font-mono uppercase text-text-muted">
          {catalogNumber('DOC', result.documentId)}
        </span>
      </div>

      {/* `path`, not `truncate`: the end of a path is the identifying part, and a nowrap
          run forces its grid track wider than the viewport. */}
      <p className="text-mono path mt-1 font-mono text-text-muted">
        {result.sourcePath}
        {result.category !== CATEGORY_UNCATEGORISED && ` · ${result.category}`}
        {result.heading && ` · ${result.heading}`}
      </p>

      {/*
       * The passage, at a measure it can be read at. `whitespace-pre-line` keeps the
       * author's line breaks, and the leading `# Title` is dropped when it only repeats the
       * title printed above it, which on this corpus is every document.
       */}
      {/* 58ch, measured rather than picked: 78ch came out at 724px, about a hundred
          characters a line, which is past the point where the eye loses its place returning
          to the left edge. This lands near 77 and stays narrower than the answer above it,
          so the answer is still the widest text on the page. */}
      <p className="mt-3 max-w-[58ch] text-body-sm whitespace-pre-line text-text">
        {highlightSegments(passageBody(result.content, result.documentTitle), query).map(
          (segment, i) => (segment.match ? <mark key={i}>{segment.text}</mark> : segment.text),
        )}
      </p>

      <Scores result={result} />
    </article>
  );
}

/**
 * The four numbers behind this passage, under it.
 *
 * The judged grade leads and keeps its meter, because it is the only absolute figure here
 * and the one abstention is decided from. The other three are ranking internals: printed,
 * because a reader who cannot interrogate a result has to take it on faith, but printed
 * last and quietly, which is the weight they deserve.
 */
function Scores({ result }: { result: SearchResult }) {
  return (
    <dl className="text-mono-label mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-rule pt-2.5 font-mono text-text-muted">
      {result.rerankScore !== null && (
        <div className="flex items-center gap-2">
          <dt>judged</dt>
          <dd className="flex items-center gap-2">
            {/* Capped so the meter stays a meter in a wide column rather than stretching
                into a rule across the card. */}
            <span aria-hidden="true" className="h-[3px] w-16 bg-bg-sunken">
              <span
                className="block h-full bg-brand"
                style={{ width: `${Math.round(result.rerankScore * 100)}%` }}
              />
            </span>
            {/*
             * A zero-length bar reads as content that failed to render, and in the abstain
             * state every bar is zero, which is precisely when the reader most needs to
             * trust what they are looking at. The word says what the empty track means.
             */}
            <span className="tabular text-text">
              {result.rerankScore === 0 ? 'not relevant' : result.rerankScore.toFixed(2)}
            </span>
          </dd>
        </div>
      )}
      <Measure label="vector" value={result.vectorScore} digits={2} />
      <Measure label="bm25" value={result.keywordScore} digits={2} />
      <Measure label="fused" value={result.score} digits={3} />
    </dl>
  );
}

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
       * `none` is retrieval evidence: it is how a reader sees that the lexical arm alone
       * found this passage. It was drawn in `--rule-strong`, which computes to 1.65:1 on
       * the card fill, so information was rendered invisible. Muted carries the same
       * de-emphasis at 5.77:1, and the word carries the meaning either way.
       */}
      <dd className={cx('tabular', value === null ? 'text-text-muted' : 'text-text')}>
        {value === null ? 'none' : value.toFixed(digits)}
      </dd>
    </div>
  );
}

/**
 * What the four numbers mean.
 *
 * The product's promise is that a result can be interrogated, and it prints `vector 0.84`
 * to make that possible. Exposing internals without a legend is not transparency, it is
 * trivia. A `<details>` because the legend is needed once and then never again, and it sits
 * after the passages rather than before them: it explains something, so it belongs next to
 * the thing it explains, and a reader who arrives at the evidence wants the evidence first.
 */
function ScoreLegend() {
  return (
    <details className="mt-5 border-t border-rule pt-3">
      <summary className="hit-touch list-outside cursor-pointer text-caption text-text-muted marker:text-text-muted">
        What these numbers mean
      </summary>
      <dl className="mt-3 grid max-w-[70ch] gap-2 text-caption text-text-muted">
        <div>
          <dt className="font-medium text-text">judged</dt>
          <dd>
            An absolute grade from 0 to 1: how well this passage answers the question, judged after
            retrieval by reading it. Below 0.67 nothing is answered from it, which is how abstention
            is decided.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-text">vector</dt>
          <dd>
            Cosine similarity of meaning, 0 to 1. Finds passages that say the same thing in
            different words. <span className="font-mono">none</span> means keyword search alone
            surfaced this passage.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-text">bm25</dt>
          <dd>
            Keyword match strength, normalised 0 to 1. Finds exact terms a paraphrase would miss,
            which is what separates one document from its near-identical neighbours.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-text">fused</dt>
          <dd>
            The combined ranking the two arms agreed on. Derived from positions rather than scores,
            so it orders results and says nothing about how good the best one is. That is why it is
            printed and not drawn as a bar.
          </dd>
        </div>
      </dl>
    </details>
  );
}
