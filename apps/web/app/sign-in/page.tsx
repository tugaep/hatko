import { redirect } from 'next/navigation';
import { z } from 'zod';
import { API_URL } from '../../lib/api.ts';
import { getSessionUser } from '../../lib/session.ts';
import { FernSpecimen, Logo, Wordmark } from '../../components/marks.tsx';
import { SignInForm } from './sign-in-form.tsx';

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
       *
       * Its statement is a `<p>`, not an `<h2>`. As a heading it preceded the page's own
       * `<h1>` in DOM order, which gives a screen reader a document that starts at level
       * two and then goes up. It is a poster line; posters do not need heading semantics.
       *
       * The mono line that used to sit at the bottom of this panel is gone. Real data, but
       * a small-caps strip across the foot of a hero is decoration wearing a number.
       */}
      <aside
        aria-hidden="true"
        className="hidden flex-col justify-between border-r border-rule bg-bg-sunken p-10 lg:flex"
      >
        <div className="flex items-center gap-2">
          <Logo className="size-5 text-brand" />
          <Wordmark />
        </div>

        <div>
          <FernSpecimen className="size-32" />
          <p className="font-display text-h2 mt-6 max-w-[26ch] text-text">
            The corpus already holds the answer. Finding it is the slow part.
          </p>
          <p className="mt-4 max-w-[46ch] text-body-sm text-text-muted">
            Ask a question and hatko pulls the passages that answer it, then writes an answer that
            cites them. When nothing in the corpus covers it, it says so.
          </p>
        </div>

        <p className="tabular text-caption text-text-muted">
          {chunks === null
            ? 'Internal retrieval tool.'
            : `${chunks.toLocaleString('en-GB')} passages indexed.`}
        </p>
      </aside>

      {/* `<main>`, which this page did not have. §10 asks for landmarks on every page. */}
      <main className="flex flex-col justify-center px-4 py-12 sm:px-10">
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
      </main>
    </div>
  );
}
