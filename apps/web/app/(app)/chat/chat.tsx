'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  answerStreamEventSchema,
  healthSchema,
  type AnswerResponse,
  type Permission,
  type SearchResult,
} from '@hatko/shared';
import { ApiRequestError, isAuthError, messageOf } from '../../../lib/api.ts';
import { apiStream } from '../../../lib/client.ts';
import { formatMs } from '../../../lib/format.ts';
import { Answer, AnswerDraft } from '../../../components/answer.tsx';
import { FernSpecimen } from '../../../components/marks.tsx';
import { SourceCard } from '../../../components/source-card.tsx';
import { Button, ErrorCard, Eyebrow, Input, SkeletonLine, cx } from '../../../components/ui.tsx';
import { useApi } from '../../../lib/use-api.ts';
import { AnswerModelPicker } from './model-picker.tsx';

/**
 * Ask a question, read the answer, check its sources.
 *
 * One request per question, streamed: `/api/answer` reports the retrieved passages as
 * soon as they are reranked, then the answer as it is written, then the validated result.
 * The sources on screen are provably the ones the answer was generated from rather than a
 * second retrieval that might differ.
 *
 * The draft the stream produces is never treated as the answer. It is replaced wholesale
 * by the terminal event, which is the only version that has been through citation
 * validation and the abstain decision — an answer can stream forty words of confident
 * prose and still end as "No documents cover this" if none of it cites a passage.
 */

interface Turn {
  /** Local, monotonic. Also namespaces source-card element ids across turns. */
  id: number;
  query: string;
  /** The validated answer. Null until the stream's terminal event arrives. */
  response: AnswerResponse | null;
  /** What has arrived so far. Provisional, and discarded once `response` is set. */
  draft: { sources: SearchResult[]; text: string } | null;
  error: string | null;
  /** The reader stopped this one. Not an error, and styled as neither. */
  stopped: boolean;
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

export function Chat({
  denied,
  canManageModels = false,
}: {
  denied?: Permission;
  canManageModels?: boolean;
}) {
  /**
   * Whether anything is indexed at all, read from the public `/health`.
   *
   * Public rather than `/api/admin/stats` deliberately: a regular user cannot read the
   * admin stats, and the person most likely to meet an unindexed corpus is exactly the
   * person with no permission to diagnose it. `/health` discloses a count and nothing
   * else, which is all this needs.
   */
  const health = useApi('/health', healthSchema);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [flashed, setFlashed] = useState<string | null>(null);
  /**
   * What assistive tech is told, as phases rather than as content.
   *
   * The list of turns used to carry `aria-live` itself, which meant every streamed token
   * mutated a live region — a screen reader narrated the answer being typed, then
   * narrated the whole of it again when the validated version replaced the draft. The
   * announcements a reader actually needs are the three transitions.
   */
  const [announcement, setAnnouncement] = useState('');
  const composerRef = useRef<HTMLInputElement>(null);
  const tailRef = useRef<HTMLLIElement>(null);
  const nextId = useRef(1);
  // `ask` is stable across renders, so its guard against overlapping requests reads the
  // current value from a ref rather than closing over a stale `pending`.
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  /** The in-flight request, so the reader can stop one that is going nowhere. */
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || pendingRef.current) return;

    const id = nextId.current++;
    const controller = new AbortController();
    abortRef.current = controller;
    /** Update just this turn. `setTurns` is functional throughout, so deltas cannot race. */
    const update = (fields: (turn: Turn) => Partial<Turn>) =>
      setTurns((previous) =>
        previous.map((turn) => (turn.id === id ? { ...turn, ...fields(turn) } : turn)),
      );

    setTurns((previous) => [
      ...previous,
      { id, query: trimmed, response: null, draft: null, error: null, stopped: false },
    ]);
    setPending(true);
    setAnnouncement('Searching the corpus.');

    try {
      for await (const event of apiStream(
        '/api/answer',
        answerStreamEventSchema,
        { query: trimmed },
        controller.signal,
      )) {
        if (event.type === 'passages') {
          // The rail can be read and checked while the answer is still being written,
          // which is most of the wait.
          update((turn) => ({ draft: { sources: event.sources, text: turn.draft?.text ?? '' } }));
          setAnnouncement(`${event.sources.length} passages retrieved. Writing the answer.`);
        } else if (event.type === 'delta') {
          update((turn) => ({
            draft: {
              sources: turn.draft?.sources ?? [],
              text: (turn.draft?.text ?? '') + event.text,
            },
          }));
        } else if (event.type === 'answer') {
          update(() => ({ response: event.response, draft: null }));
          setAnnouncement(
            event.response.abstained
              ? 'No documents cover this question. The nearest passages are listed.'
              : `Answer ready, with ${event.response.citations.length} citations.`,
          );
        } else {
          // A failure after the first byte. Status 0 because there is no status left to
          // report — the 200 went out with the passages — so the code carries the meaning.
          throw new ApiRequestError(0, event.error.code, event.error.message);
        }
      }
    } catch (error) {
      // Stopping is a deliberate act, not a failure, so it does not take the error path.
      // The draft still goes: nothing in it was validated.
      if (controller.signal.aborted) {
        update(() => ({ stopped: true, draft: null }));
        setAnnouncement('Stopped.');
        return;
      }
      // A 401 here means the session expired mid-session. A full reload lets the server
      // gate make the call, rather than this component guessing at a redirect.
      if (isAuthError(error)) {
        window.location.reload();
        return;
      }
      // The draft goes with it. A truncated answer left on screen beside an error card
      // reads as a partial result, when in fact nothing about it was ever validated.
      update(() => ({ error: messageOf(error), draft: null }));
      setAnnouncement('That question could not be answered.');
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }, []);

  /** Retrying reuses `ask`, so a stopped turn has to lose its stopped state first. */
  const retry = useCallback(
    (turn: Turn) => {
      setTurns((previous) => previous.filter((existing) => existing.id !== turn.id));
      void ask(turn.query);
    },
    [ask],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // A pending request outliving the page it belongs to is a leak with a cost attached:
  // the answer model keeps generating and the allowance keeps being spent.
  useEffect(() => () => abortRef.current?.abort(), []);

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
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display text-h1 text-text">Ask the corpus</h1>
            <p className="mt-2 max-w-[60ch] text-body-sm text-text-muted">
              Every answer comes from indexed passages, and each claim carries the passage it came
              from.
            </p>
          </div>
          {canManageModels && <AnswerModelPicker />}
        </header>

        {/*
         * Not an error card. Being sent here is the correct outcome of asking for a page
         * your role does not hold, so it is stated as a fact in the neutral informational
         * tone rather than dressed in clay.
         */}
        {/*
         * An empty index is a setup state, not a fault, so it is stated in the neutral
         * informational tone rather than as an error. Before this, asking a question here
         * produced "the model provider could not be reached" — an accurate description of
         * a symptom and a useless description of the cause, which was that nobody had run
         * ingestion yet. Admins get the step; everyone else gets the honest status and
         * nobody to blame.
         */}
        {health.data?.indexedChunks === 0 && (
          <p className="fade mt-4 border border-rule-strong bg-bg-sunken p-3 text-body-sm text-text">
            {canManageModels ? (
              <>
                Nothing is indexed yet, so there is nothing to answer from. Finish setup on the{' '}
                <a href="/dashboard" className="underline underline-offset-2">
                  dashboard
                </a>
                : add a provider key, choose a model, then run ingestion.
              </>
            ) : (
              'Nothing is indexed yet, so there is nothing to answer from. An administrator has to run ingestion before this page can be used.'
            )}
          </p>
        )}

        {denied && (
          <p className="fade mt-4 border border-rule-strong bg-bg-sunken p-3 text-body-sm text-text">
            {DENIED_COPY[denied] ?? 'That page is for administrators.'}
          </p>
        )}

        {/*
         * The live region is mounted here, once, for the life of the page — not created
         * along with each answer. A region inserted together with its content is not
         * announced by most assistive tech, which meant pressing Ask produced silence.
         * It carries phase messages rather than the answer itself; see `announcement`.
         */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {/*
         * `grid-cols-[minmax(0,1fr)]` rather than a bare `grid`: an auto track takes its
         * minimum from its content, and one unbreakable source path was enough to push the
         * whole column past the viewport on a phone.
         *
         * Turns are ruled off rather than only spaced. `gap-12` alone left a third
         * question indistinguishable from a continuation of the second.
         */}
        <ol
          aria-busy={pending}
          className={cx('grid grid-cols-[minmax(0,1fr)]', turns.length > 0 && 'mt-8')}
        >
          {turns.map((turn, i) => (
            <li
              key={turn.id}
              ref={i === turns.length - 1 ? tailRef : null}
              className={cx(
                'min-w-0 scroll-mt-20',
                i > 0 && 'mt-10 border-t border-rule pt-10',
              )}
            >
              <TurnView
                turn={turn}
                flashed={flashed}
                onCitationClick={(chunkId) => jumpToSource(turn.id, chunkId)}
                onRetry={() => retry(turn)}
              />
            </li>
          ))}
        </ol>

        {turns.length === 0 && <EmptyState onPick={ask} disabled={pending} />}
      </div>

      <Composer inputRef={composerRef} pending={pending} onSubmit={ask} onStop={stop} />
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

  // The rail is drawn from whichever is available. The draft's passages are the same rows
  // the finished response will carry — reported early precisely so they can be read during
  // the wait — so the cards do not move or change when the answer lands.
  const sources = response?.sources ?? turn.draft?.sources ?? [];

  /** Escape closes the disclosure and returns focus to the control that opened it. */
  function onPanelKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape' || !sourcesOpen) return;
    setSourcesOpen(false);
    toggleRef.current?.focus();
  }

  // Which passages the answer actually leaned on. Retrieval returns six; an answer
  // typically cites one or two, and the reader should not have to work that out.
  const citedChunkIds = new Set(response?.citations.map((citation) => citation.chunkId) ?? []);
  const citedCount = sources.filter((source) => citedChunkIds.has(source.chunkId)).length;

  return (
    <article>
      {/*
       * The question, as a chip rather than a bubble — this is not a chat with a persona.
       * Right-aligned to the answer column, not the outer container: aligned to the
       * container it floated over the *sources* rail while its own answer sat diagonally
       * opposite.
       */}
      {/*
       * `68ch`, matching the answer's own measure, not the width of the column it sits
       * in. Aligned to the column the chip's right edge landed 119px past the end of
       * every line of the answer beneath it — aligned to nothing the reader can see.
       */}
      <div className="lg:max-w-[68ch]">
        <div className="flex justify-end">
          <h2 className="max-w-[560px] rounded-sm bg-bg-sunken px-3 py-2 text-body-sm text-text">
            {turn.query}
          </h2>
        </div>
      </div>

      {/*
       * `1fr` for the answer and a bounded track for the evidence, rather than the fixed
       * `720px 360px` that left 112px of unexplained space to the right of the rail at
       * 1280. The answer caps itself at 68ch regardless, so the slack belongs to the
       * passages, which are the thing that benefits from width.
       */}
      <div className="mt-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-start lg:gap-10">
        <div className="min-w-0">
          {turn.error ? (
            <ErrorCard
              title="Could not answer that question."
              detail={turn.error}
              onRetry={onRetry}
            />
          ) : turn.stopped ? (
            /*
             * Stopping is the reader's decision, so it is stated in the neutral
             * informational tone — not an ErrorCard. The passages that had already
             * arrived stay in the rail; they were retrieved and are still true.
             */
            <div className="fade border border-rule-strong bg-bg-sunken p-4">
              <p className="text-body-sm text-text">
                Stopped before the answer was finished. Nothing was validated, so nothing
                is shown.
              </p>
              <Button size="sm" variant="secondary" onClick={onRetry} className="mt-3">
                Ask again
              </Button>
            </div>
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
          ) : turn.draft && turn.draft.text.length > 0 ? (
            <AnswerDraft text={turn.draft.text} />
          ) : (
            // Passages may already be on screen; the answer column has nothing yet.
            <AnswerSkeleton />
          )}
        </div>

        {sources.length > 0 && (
          /*
           * The rail is its own scroll region from `lg` up. Before this it was an ordinary
           * 2,271px column beside a 217px answer: reading the fourth passage put the
           * answer it was evidence for entirely off-screen, which is the one thing a
           * citation is supposed to make unnecessary. Capped, one question and all six of
           * its passages fit on one screen and the evidence scrolls under a stationary
           * answer.
           *
           * `14rem` is measured, not chosen. A turn has to clear the 3.5rem header, the
           * 4rem composer, the 5rem `scroll-mt` the new turn lands at, and the question
           * chip above the row: 13.1rem of fixed cost, so 14rem leaves about 15px of
           * slack at any viewport height. At 10rem a turn came to 804px against 779px of
           * usable height — off by exactly the amount that made it not fit.
           *
           * No `overscroll-contain`. It was here first and it was wrong: a pointer resting
           * over the rail could scroll the rail to its end and then the page would not
           * move at all. Chaining to the page is the behaviour a reader expects.
           */
          <aside
            className={cx(
              'mt-6 min-w-0 lg:mt-0',
              'lg:sticky lg:top-20 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto',
            )}
            aria-labelledby={`${panelId}-heading`}
            onKeyDown={onPanelKeyDown}
          >
            {/* Sticky within that scroll region, so the count stays legible while the
                cards move under it. */}
            <div className="sticky top-0 z-[1] flex items-center justify-between gap-3 border-b border-rule bg-bg pb-2">
              <div className="flex min-w-0 items-center gap-2">
                <Eyebrow as="h3" id={`${panelId}-heading`}>
                  {response?.abstained ? 'Nearest passages' : 'Sources'}
                </Eyebrow>
                {/* Which of the six carried a claim, stated rather than counted by the
                    reader off six border colours. */}
                {citedCount > 0 && (
                  <span className="text-caption text-text-muted">
                    {citedCount} of {sources.length} cited
                  </span>
                )}
              </div>
              {/*
               * `lg:hidden`, not `md:hidden`. The two-column grid starts at `lg`, so
               * between 768 and 1023 the panel was permanently open *and* had no toggle:
               * a 772px-wide, 2,166px-tall stack of cards under the answer with no way to
               * put it away. The breakpoint that shows the rail inline is the breakpoint
               * that may drop the control, and that is `lg`.
               */}
              <button
                type="button"
                ref={toggleRef}
                onClick={() => setSourcesOpen((open) => !open)}
                aria-expanded={sourcesOpen}
                aria-controls={panelId}
                className="hit-touch rounded-sm text-caption font-medium text-text lg:hidden"
              >
                {sourcesOpen ? 'Hide' : `Show ${sources.length}`}
              </button>
            </div>

            <div
              id={panelId}
              className={cx(
                'mt-3 grid grid-cols-[minmax(0,1fr)] gap-3',
                sourcesOpen ? 'grid' : 'hidden lg:grid',
              )}
            >
              {/* At the head of the rail, where the first score a reader meets is. It
                  used to sit below all six cards — 2,300px past the numbers it explains. */}
              <ScoreLegend />
              {sources.map((source, i) => (
                <SourceCard
                  key={source.chunkId}
                  result={source}
                  index={i + 1}
                  query={turn.query}
                  domId={sourceDomId(turn.id, source.chunkId)}
                  cited={citedChunkIds.has(source.chunkId)}
                  flashed={flashed === sourceDomId(turn.id, source.chunkId)}
                  /*
                   * Cited passages are open; the rest are a titled row the reader opens.
                   * When nothing was cited — the abstain case — the top-ranked passage
                   * opens instead, so "here is the nearest thing we found" still shows
                   * something to judge rather than six closed rows.
                   */
                  startOpen={
                    citedChunkIds.size > 0 ? citedChunkIds.has(source.chunkId) : i === 0
                  }
                />
              ))}
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
  onStop,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  pending: boolean;
  onSubmit: (query: string) => void;
  onStop: () => void;
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
        {/*
         * While a request is in flight the primary control is Stop, not a disabled Ask
         * with a spinner in it. A generation costs money and takes seconds, and the
         * reader who has just realised they asked the wrong question had no exit at all.
         */}
        {pending ? (
          <Button type="button" variant="secondary" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={value.trim().length < 2}>
            Ask
          </Button>
        )}
      </div>
    </form>
  );
}
