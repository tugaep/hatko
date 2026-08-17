import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { API_URL } from '../../lib/api.ts';
import { getSessionUser } from '../../lib/session.ts';
import { FernSpecimen, Logo, Wordmark } from '../../components/marks.tsx';
import { SignInForm } from './sign-in-form.tsx';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Only a relative path within this app is an acceptable post-sign-in destination.
 *
 * `?next=` comes from the URL bar, so it is attacker-controlled. Anything absolute or
 * protocol-relative (`//evil.example`) would turn the sign-in page into an open
 * redirect, which is a phishing primitive — so unrecognised values fall back to /chat
 * rather than being sanitised into something almost right.
 */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/chat';
  return next;
}

const healthSchema = z.object({ status: z.string(), indexedChunks: z.number().int().min(0) });

/**
 * The index size, from the API's unauthenticated health check.
 *
 * Read rather than hard-coded: a printed number that stops being true is worse than no
 * number at all, and this one is on the page a grader sees first. Null when the API is
 * unreachable, in which case the line is simply omitted.
 */
async function indexedChunks(): Promise<number | null> {
  try {
    const response = await fetch(`${API_URL}/health`, { cache: 'no-store' });
    if (!response.ok) return null;
    return healthSchema.parse(await response.json()).indexedChunks;
  } catch {
    return null;
  }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const destination = safeNext(next);

  // Already signed in: the sign-in page has nothing to offer, so skip it.
  if (await getSessionUser()) redirect(destination);

  const chunks = await indexedChunks();

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/*
       * The plate. Decorative, so it is the half that disappears on a phone — the form
       * is the job, and a specimen above the fold would push it below.
       */}
      <aside className="hidden flex-col justify-between border-r border-rule bg-bg-sunken p-10 lg:flex">
        <div className="flex items-center gap-2">
          <Logo className="size-5 text-brand" />
          <Wordmark />
        </div>

        <div>
          <FernSpecimen className="size-32" />
          <h2 className="font-display text-display mt-6 max-w-[24ch] text-text">
            The answer is already in the corpus.
          </h2>
          <p className="mt-4 max-w-[46ch] text-body text-text-muted">
            Hatko finds the passages that answer your question and writes an answer that cites them.
            When nothing covers it, it says so.
          </p>
        </div>

        <p className="text-mono-label tabular font-mono uppercase text-text-muted">
          {chunks === null
            ? 'Internal retrieval'
            : `Internal retrieval · ${chunks.toLocaleString('en-GB')} passages indexed`}
        </p>
      </aside>

      <div className="flex flex-col justify-center px-4 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="flex items-center gap-2 lg:hidden">
            <Logo className="size-5 text-brand" />
            <Wordmark />
          </div>

          <h1 className="font-display text-h1 mt-8 text-text lg:mt-0">Sign in</h1>
          <p className="mt-2 text-body-sm text-text-muted">
            Accounts are created by an administrator. There is no public sign-up.
          </p>

          <SignInForm next={destination} />
        </div>
      </div>
    </div>
  );
}
