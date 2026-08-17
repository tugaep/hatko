'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { answerResponseSchema, type AnswerResponse, type Permission } from '@hatko/shared';
import { isAuthError, messageOf } from '../../../lib/api.ts';
import { apiSend } from '../../../lib/client.ts';
import { formatMs } from '../../../lib/format.ts';
import { Answer } from '../../../components/answer.tsx';
import { FernSpecimen } from '../../../components/marks.tsx';
import { SourceCard } from '../../../components/source-card.tsx';
import { Button, ErrorCard, Eyebrow, Input, SkeletonLine, cx } from '../../../components/ui.tsx';

/**
 * Ask a question, read the answer, check its sources.
 *
 * One request per question: `/api/answer` returns the answer, the citations and the
 * passages behind them together, so the sources on screen are provably the ones the
 * answer was generated from rather than a second retrieval that might differ.
 */

interface Turn {
  /** Local, monotonic. Also namespaces source-card element ids across turns. */
  id: number;
  query: string;
  response: AnswerResponse | null;
  error: string | null;
}

/** Real questions from the sample set, including one the corpus cannot answer. */
const EXAMPLES = [
  'How do I initialize the current Lumen SDK, and what happened to lumen.track?',
  'Which languages must every playable ship with, and what is the fallback?',
  'What is the vacation policy?',
];

/** How long a cited source card stays promoted after its citation is clicked. */
const FLASH_MS = 1200;

/** What each permission means to the person who was just bounced for lacking it. */
const DENIED_COPY: Partial<Record<Permission, string>> = {
  'dashboard:view':
    'The dashboard is for administrators. Your account can search and ask questions.',
  'documents:manage': 'Corpus management is for administrators.',
  'ingestion:trigger': 'Running ingestion is for administrators.',
};

export function Chat({ denied }: { denied?: Permission }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [flashed, setFlashed] = useState<string | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const tailRef = useRef<HTMLLIElement>(null);
  const nextId = useRef(1);
  // `ask` is stable across renders, so its guard against overlapping requests reads the
  // current value from a ref rather than closing over a stale `pending`.
  const pendingRef = useRef(false);
  pendingRef.current = pending;

  const ask = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || pendingRef.current) return;

    const id = nextId.current++;
    setTurns((previous) => [...previous, { id, query: trimmed, response: null, error: null }]);
    setPending(true);

    try {
      const response = await apiSend('POST', '/api/answer', answerResponseSchema, {
        query: trimmed,
      });
      setTurns((previous) =>
        previous.map((turn) => (turn.id === id ? { ...turn, response } : turn)),
      );
    } catch (error) {
      // A 401 here means the session expired mid-session. A full reload lets the server
      // gate make the call, rather than this component guessing at a redirect.
      if (isAuthError(error)) {
        window.location.reload();
        return;
      }
      setTurns((previous) =>
        previous.map((turn) => (turn.id === id ? { ...turn, error: messageOf(error) } : turn)),
      );
    } finally {
      setPending(false);
    }
  }, []);

  /** `/` focuses the composer, unless the user is already typing somewhere. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Bring a new question into view; it lands just above the composer otherwise. */
  useEffect(() => {
    if (turns.length > 0) tailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [turns.length]);

  /** Clicking a citation scrolls to its card and promotes it briefly. */
  const flashTimer = useRef<number>(0);
  const jumpToSource = useCallback((turnId: number, chunkId: number) => {
    const domId = sourceDomId(turnId, chunkId);
    document.getElementById(domId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashed(domId);
    // One timer, restarted — clicking two citations in quick succession should not leave
    // the first card's promotion cancelling the second's.
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashed(null), FLASH_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col pb-[calc(var(--nav-h)+0.75rem)]">
      <div className="flex-1 py-6 sm:py-8">
        <header>
          <h1 className="font-display text-h1 text-text">Ask the corpus</h1>
          <p className="mt-2 max-w-[60ch] text-body-sm text-text-muted">
            Answers are written only from indexed passages, and every claim carries the source it
            came from.
          </p>
        </header>

        {/*
         * Not an error card. Being sent here is the correct outcome of asking for a page
         * your role does not hold, so it is stated as a fact in the neutral informational
         * tone rather than dressed in clay.
         */}
        {denied && (
          <p className="fade mt-4 border border-rule-strong bg-bg-sunken p-3 text-body-sm text-text">
            {DENIED_COPY[denied] ?? 'That page is for administrators.'}
          </p>
        )}

        {/*
         * The live region is mounted here, once, for the life of the page — not created
         * along with each answer. A region inserted together with its content is not
         * announced by most assistive tech, which meant pressing Ask produced silence.
         *
         * `grid-cols-[minmax(0,1fr)]` rather than a bare `grid`: an auto track takes its
         * minimum from its content, and one unbreakable source path was enough to push the
         * whole column past the viewport on a phone.
         */}
        <ol
          aria-live="polite"
          aria-busy={pending}
          className={cx('grid grid-cols-[minmax(0,1fr)] gap-12', turns.length > 0 && 'mt-8')}
        >
          {turns.map((turn, i) => (
            <li
              key={turn.id}
              ref={i === turns.length - 1 ? tailRef : null}
              className="min-w-0 scroll-mt-20"
            >
              <TurnView
                turn={turn}
                flashed={flashed}
                onCitationClick={(chunkId) => jumpToSource(turn.id, chunkId)}
                onRetry={() => ask(turn.query)}
              />
            </li>
          ))}
        </ol>

        {turns.length === 0 && <EmptyState onPick={ask} disabled={pending} />}
      </div>

      <Composer inputRef={composerRef} pending={pending} onSubmit={ask} />
    </div>
  );
}

function sourceDomId(turnId: number, chunkId: number): string {
  return `source-${turnId}-${chunkId}`;
}

/**
 * One question and everything it produced.
 *
 * The two-column split is the show-your-work principle in layout form: the answer holds
 * to a readable measure and the evidence sits beside it, not behind a disclosure. Only a
 * phone collapses the evidence to a count the reader opens, because only a phone genuinely
 * cannot show both. A tablet can, and design.md §9 says so.
 */
function TurnView({
  turn,
  flashed,
  onCitationClick,
  onRetry,
}: {
  turn: Turn;
  flashed: string | null;
  onCitationClick: (chunkId: number) => void;
  onRetry: () => void;
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const response = turn.response;

  /** Escape closes the disclosure and returns focus to the control that opened it. */
  function onPanelKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape' || !sourcesOpen) return;
    setSourcesOpen(false);
    toggleRef.current?.focus();
  }

  // Which passages the answer actually leaned on. Retrieval returns six; an answer
  // typically cites one or two, and the reader should not have to work that out.
  const citedChunkIds = new Set(response?.citations.map((citation) => citation.chunkId) ?? []);

  return (
    <article>
      {/*
       * The question, as a chip rather than a bubble — this is not a chat with a persona.
       * Right-aligned to the answer column, not the outer container: aligned to the
       * container it floated over the *sources* rail while its own answer sat diagonally
       * opposite.
       */}
      <div className="lg:max-w-[720px]">
        <div className="flex justify-end">
          <h2 className="max-w-[560px] rounded-sm bg-bg-sunken px-3 py-2 text-body-sm text-text">
            {turn.query}
          </h2>
        </div>
      </div>

      <div className="mt-6 lg:grid lg:grid-cols-[minmax(0,720px)_360px] lg:items-start lg:gap-10">
        <div className="min-w-0">
          {turn.error ? (
            <ErrorCard
              title="Could not answer that question."
              detail={turn.error}
              onRetry={onRetry}
            />
          ) : response ? (
            <>
              <Answer response={response} onCitationClick={onCitationClick} />
              {/*
               * Three measurements, three columns. As one dot-delimited string
               * (`3 CITED · 6 PASSAGES · 3.4S`) it read as a single opaque token, and
               * `uppercase` turned `3.4s` into `3.4S`, mangling the unit in a brand whose
               * rule is numbers over adjectives.
               */}
              <dl className="text-mono-label mt-4 flex flex-wrap gap-x-5 gap-y-1 font-mono text-text-muted">
                <Stat label="citations">
                  {response.abstained ? 'abstained' : response.citations.length}
                </Stat>
                <Stat label="passages">{response.sources.length}</Stat>
                <Stat label="took">{formatMs(response.latencyMs)}</Stat>
              </dl>
            </>
          ) : (
            <AnswerSkeleton />
          )}
        </div>

        {response && response.sources.length > 0 && (
          <aside
            className="mt-6 min-w-0 lg:mt-0"
            aria-labelledby={`${panelId}-heading`}
            onKeyDown={onPanelKeyDown}
          >
            <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
              <Eyebrow as="h3" id={`${panelId}-heading`}>
                {response.abstained ? 'Nearest passages' : 'Sources'}
              </Eyebrow>
              <button
                type="button"
                ref={toggleRef}
                onClick={() => setSourcesOpen((open) => !open)}
                aria-expanded={sourcesOpen}
                aria-controls={panelId}
                className="hit-touch rounded-sm text-caption font-medium text-text md:hidden"
              >
                {sourcesOpen ? 'Hide' : `Show ${response.sources.length}`}
              </button>
            </div>

            <div
              id={panelId}
              className={cx(
                'mt-3 grid grid-cols-[minmax(0,1fr)] gap-3',
                sourcesOpen ? 'grid' : 'hidden md:grid',
              )}
            >
              {response.sources.map((source, i) => (
                <SourceCard
                  key={source.chunkId}
                  result={source}
                  index={i + 1}
                  query={turn.query}
                  domId={sourceDomId(turn.id, source.chunkId)}
                  cited={citedChunkIds.has(source.chunkId)}
                  flashed={flashed === sourceDomId(turn.id, source.chunkId)}
                />
              ))}
              <ScoreLegend />
            </div>
          </aside>
        )}
      </div>
    </article>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="tabular text-text">{children}</dd>
    </div>
  );
}

/**
 * What the three numbers on every source card mean.
 *
 * The product's whole promise is that a result can be interrogated, and it prints
 * `vector 0.84 · bm25 0.99 · fused 0.174` to make that possible — then explained none of
 * it anywhere. Exposing internals without a legend is not transparency, it is trivia. A
 * `<details>` because the legend is needed once and then never again.
 */
function ScoreLegend() {
  return (
    <details className="border border-rule bg-bg p-3">
      <summary className="hit-touch cursor-pointer text-caption font-medium text-text">
        What these numbers mean
      </summary>
      <dl className="mt-3 grid gap-2 text-caption text-text-muted">
        <div>
          <dt className="font-medium text-text">Relevance</dt>
          <dd>
            An absolute grade from 0 to 1: how well this passage answers the question, judged after
            retrieval. Below 0.67 nothing is answered from it, which is how abstention is decided.
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
            which is what cuts through 78 near-identical delivery reports.
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

/** Skeleton, not a spinner: the answer column keeps its geometry while it fills. */
function AnswerSkeleton() {
  return (
    <div aria-hidden="true" className="grid max-w-[68ch] gap-2.5">
      {['w-full', 'w-full', 'w-11/12', 'w-full', 'w-2/3'].map((width, i) => (
        <SkeletonLine key={i} className={width} />
      ))}
    </div>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (query: string) => void; disabled: boolean }) {
  return (
    <div className="mt-10 flex flex-col items-center border border-rule bg-bg-raised px-6 py-12 text-center">
      <FernSpecimen />
      <h2 className="font-display text-h2 mt-4 text-text">Nothing asked yet.</h2>
      <p className="mt-2 max-w-[48ch] text-body-sm text-text-muted">
        Ask in plain language.
        {/* Hidden where there is no keyboard to press it with. */}
        <span className="hover-only">
          {' '}
          Press <kbd className="text-mono font-mono">/</kbd> to jump to the question field.
        </span>
      </p>

      <ul className="mt-6 grid w-full max-w-[60ch] gap-2 text-left">
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(example)}
              className={cx(
                'w-full border border-rule bg-bg px-3 py-2.5 text-left text-body-sm text-text',
                'transition-colors duration-120 ease-brand hover:border-rule-strong hover:bg-bg-sunken',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              {example}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The composer sticks above the bottom nav rather than to the viewport floor, using the
 * `--nav-h` the shell publishes — a regular user has no bottom bar and should not get a
 * 56px gap under the field.
 */
function Composer({
  inputRef,
  pending,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  pending: boolean;
  onSubmit: (query: string) => void;
}) {
  const [value, setValue] = useState('');

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
    setValue('');
    // Keep the caret where the person put it. Disabling the field while the answer
    // generated used to throw focus to <body>, so a keyboard user had to traverse six
    // source cards and every citation chip to ask a second question.
    inputRef.current?.focus();
  }

  return (
    <form
      onSubmit={submit}
      // The inset belongs here as well as on the bottom nav: a regular user has only one
      // nav destination, gets no bottom bar, and would otherwise have the field sitting
      // underneath the home indicator.
      className={cx(
        'sticky bottom-[var(--nav-h)] z-[var(--z-sticky)] -mx-4 border-t border-rule bg-bg',
        'px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6',
      )}
    >
      <div className="flex gap-2">
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <Input
          id="question"
          ref={inputRef}
          name="question"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          // Matches `searchRequestSchema` so the field cannot compose a request the API
          // will reject on length.
          maxLength={500}
          autoComplete="off"
          placeholder="Ask a question about the corpus…"
          // Deliberately not disabled while pending. Overlapping submits are already
          // refused by the `pendingRef` guard in `ask`, and disabling the one element the
          // user is focused on is a worse cure than the disease.
          readOnly={pending}
        />
        <Button type="submit" loading={pending} disabled={value.trim().length < 2}>
          Ask
        </Button>
      </div>
    </form>
  );
}
