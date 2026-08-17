'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { answerResponseSchema, type AnswerResponse } from '@sorrel/shared';
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

export function Chat() {
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

        {turns.length === 0 ? (
          <EmptyState onPick={ask} disabled={pending} />
        ) : (
          <ol className="mt-8 grid gap-12">
            {turns.map((turn, i) => (
              <li
                key={turn.id}
                ref={i === turns.length - 1 ? tailRef : null}
                className="scroll-mt-20"
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
        )}
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
 * to a readable measure and the evidence sits beside it, not behind a disclosure. Below
 * `lg` the evidence collapses to a count the reader opens, because a phone cannot show
 * both at once and the answer is what they asked for.
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

  return (
    <article>
      {/* The question, as a chip rather than a bubble — this is not a chat with a persona. */}
      <div className="flex justify-end">
        <h2 className="max-w-[560px] rounded-sm bg-bg-sunken px-3 py-2 text-body-sm text-text">
          {turn.query}
        </h2>
      </div>

      <div className="mt-6 lg:grid lg:grid-cols-[minmax(0,720px)_360px] lg:items-start lg:gap-10">
        <div className="min-w-0">
          {turn.error ? (
            <ErrorCard
              title="Could not answer that question."
              detail={turn.error}
              onRetry={onRetry}
            />
          ) : turn.response ? (
            <>
              <Answer response={turn.response} onCitationClick={onCitationClick} />
              <p className="text-mono-label tabular mt-4 font-mono uppercase text-text-muted">
                {turn.response.abstained ? 'Abstained' : `${turn.response.citations.length} cited`}{' '}
                · {turn.response.sources.length} passages · {formatMs(turn.response.latencyMs)}
              </p>
            </>
          ) : (
            <AnswerSkeleton />
          )}
        </div>

        {(turn.response?.sources.length ?? 0) > 0 && turn.response && (
          <aside className="mt-6 lg:mt-0" aria-label="Sources">
            <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
              <Eyebrow>{turn.response.abstained ? 'Nearest passages' : 'Sources'}</Eyebrow>
              <button
                type="button"
                onClick={() => setSourcesOpen((open) => !open)}
                aria-expanded={sourcesOpen}
                aria-controls={panelId}
                className="rounded-sm text-caption font-medium text-text lg:hidden"
              >
                {sourcesOpen ? 'Hide' : `Show ${turn.response.sources.length}`}
              </button>
            </div>

            <div
              id={panelId}
              className={cx('mt-3 grid gap-3', sourcesOpen ? 'grid' : 'hidden lg:grid')}
            >
              {turn.response.sources.map((source, i) => (
                <SourceCard
                  key={source.chunkId}
                  result={source}
                  index={i + 1}
                  query={turn.query}
                  domId={sourceDomId(turn.id, source.chunkId)}
                  flashed={flashed === sourceDomId(turn.id, source.chunkId)}
                />
              ))}
            </div>
          </aside>
        )}
      </div>
    </article>
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
        Ask in plain language. Press <kbd className="text-mono font-mono">/</kbd> to jump to the
        question field.
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
  }

  return (
    <form
      onSubmit={submit}
      className="sticky bottom-[var(--nav-h)] z-20 -mx-4 border-t border-rule bg-bg px-4 py-3 sm:-mx-6 sm:px-6"
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
          disabled={pending}
        />
        <Button type="submit" loading={pending} disabled={value.trim().length < 2}>
          Ask
        </Button>
      </div>
    </form>
  );
}
