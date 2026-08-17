import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { can, oauthClientSchema, type OauthClient } from '@hatko/shared';
import { API_URL } from '../../../lib/api.ts';
import { requireUser } from '../../../lib/session.ts';
import { Logo, Wordmark } from '../../../components/marks.tsx';
import { ConsentForm } from './consent-form.tsx';

export const metadata: Metadata = { title: 'Authorize a client' };

/**
 * The OAuth consent screen, shown when an MCP client asks for access to the corpus.
 *
 * This page exists in the web app rather than as an HTML string returned by the API —
 * Better Auth offers both — because it is the moment the product asks to be trusted.
 * A page that matched nothing else the user had seen, at exactly that moment, would be
 * the worst possible place for the design system to stop.
 *
 * It renders no secret. The consent code is a short-lived one-time value the API
 * already issued and also holds in a signed cookie, and the approval itself is written
 * server-side by the API — this page collects a yes or a no and nothing more.
 */

/**
 * What each scope actually lets the client do, in the terms of this product.
 *
 * "openid, profile, email, offline_access" describes an OAuth contract, not a
 * consequence, and consent screens that list raw scope names are how people learn to
 * click through them. Anything unrecognised is shown verbatim rather than hidden: an
 * unexplained scope is a reason to hesitate, so hiding it would be the wrong way round.
 */
const SCOPE_MEANINGS: Record<string, string> = {
  openid: 'Confirm which Hatko account you are',
  profile: 'Read your name',
  email: 'Read your email address',
  offline_access: 'Stay connected without asking you again each time',
};

/**
 * Resolve the client asking for access, or null.
 *
 * Null is a rendered state rather than an error: an unregistered or disabled
 * `client_id` means the request is stale or forged, and saying "this application could
 * not be identified" next to a disabled button is more useful than a crash. The
 * approve path is withheld in that case — approving something unidentifiable is
 * precisely what this screen exists to prevent.
 */
async function fetchClient(clientId: string | undefined): Promise<OauthClient | null> {
  if (!clientId) return null;

  try {
    const response = await fetch(
      `${API_URL}/api/oauth/client/${encodeURIComponent(clientId)}`,
      // The session cookie is httpOnly, so it is forwarded rather than read.
      { headers: { cookie: (await cookies()).toString() }, cache: 'no-store' },
    );
    if (!response.ok) return null;
    return oauthClientSchema.parse(await response.json());
  } catch {
    return null;
  }
}

/** The host a code would be delivered to — the detail worth checking before approving. */
function redirectHost(uris: string[]): string | null {
  const first = uris[0];
  if (!first) return null;
  try {
    return new URL(first).host;
  } catch {
    return first;
  }
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ consent_code?: string; client_id?: string; scope?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined) as [string, string][],
  );

  // Signed in first, and returning here afterwards: the authorize endpoint sends
  // unauthenticated callers to /sign-in, but a session can also expire between there
  // and here.
  const user = await requireUser(`/oauth/consent?${query.toString()}`);

  const scopes = (params.scope ?? '').split(' ').filter(Boolean);

  /**
   * A client that arrives without a consent code has not come from the authorize
   * endpoint — a bookmarked or hand-typed URL, or a stale tab. There is nothing to
   * approve, and rendering an Approve button that cannot work would be worse than
   * saying so.
   */
  if (!params.consent_code) {
    return (
      <Shell>
        <h1 className="font-display text-h2 text-text">Nothing to authorize</h1>
        <p className="mt-3 text-body-sm text-text-muted">
          This page is shown when an application asks for access to the corpus. It was opened
          directly, so there is no pending request. Start from your MCP client and it will send you
          back here.
        </p>
      </Shell>
    );
  }

  /**
   * The role check, stated on the page rather than only enforced at the MCP server.
   *
   * A user without `search:run` can complete this flow and receive a token that every
   * query then refuses — technically safe, and a genuinely confusing experience. The
   * MCP server is still the enforcement point; this is the courtesy of saying so before
   * the client spends a round trip finding out.
   */
  const permitted = can(user.role, 'search:run');
  const client = await fetchClient(params.client_id);

  /**
   * An unidentifiable client gets no Approve button.
   *
   * The whole value of this screen is letting a person recognise what is asking. If the
   * `client_id` resolves to nothing, there is nothing to recognise, and rendering
   * Approve anyway would train exactly the reflex this page is meant to interrupt.
   */
  if (!client) {
    return (
      <Shell>
        <h1 className="font-display text-h2 text-text">Application not recognised</h1>
        <p className="mt-3 text-body-sm text-text-muted">
          The application behind this request is not registered, or has been disabled. Nothing has
          been approved. Start again from your MCP client, and if this keeps happening, tell an
          administrator.
        </p>
      </Shell>
    );
  }

  const host = redirectHost(client.redirectUris);

  return (
    <Shell>
      <h1 className="font-display text-h2 text-text">Authorize access to the corpus</h1>
      <p className="mt-3 text-body-sm text-text-muted">
        An application is asking to search Hatko as <span className="text-text">{user.email}</span>.
        It will be able to read any passage you could read yourself.
      </p>

      <dl className="border-rule mt-6 border-t">
        {/*
         * The name is chosen by whoever registered the client — dynamic registration is
         * open by design — so it is untrusted text. React escapes it, and `break-words`
         * keeps a deliberately long name from pushing the buttons off screen rather than
         * trusting it to be short.
         */}
        <div className="border-rule flex items-baseline justify-between gap-4 border-b py-3">
          <dt className="text-caption text-text-muted shrink-0">Application</dt>
          <dd className="text-body-sm text-right break-words text-text">{client.name}</dd>
        </div>

        {host && (
          <div className="border-rule flex items-baseline justify-between gap-4 border-b py-3">
            <dt className="text-caption text-text-muted shrink-0">Sends the code to</dt>
            {/*
             * The security-relevant line. A name can claim to be any familiar tool; the
             * host is where the authorization code actually goes, so an unfamiliar one
             * beside a familiar name is the mismatch worth noticing.
             */}
            <dd className="text-body-sm tabular text-right break-all text-text">{host}</dd>
          </div>
        )}
      </dl>

      {scopes.length > 0 && (
        <>
          <p className="text-caption text-text-muted mt-6">It is asking to</p>
          <ul className="mt-2 space-y-2">
            {scopes.map((scope) => (
              <li key={scope} className="text-body-sm flex gap-2 text-text">
                <span aria-hidden="true" className="text-text-muted">
                  —
                </span>
                <span>
                  {SCOPE_MEANINGS[scope] ?? (
                    <>
                      Unrecognised permission <code className="text-text-muted">{scope}</code>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {!permitted && (
        <p className="text-body-sm border-rule bg-bg-sunken mt-6 border p-3 text-text-muted">
          Your account does not have search access, so this application will not be able to run
          queries even if you approve it. Ask an administrator to change your role first.
        </p>
      )}

      <ConsentForm consentCode={params.consent_code} />

      <p className="text-caption text-text-muted mt-6">
        Approving does not share your password. You can revoke access by signing out of Hatko.
      </p>
    </Shell>
  );
}

/** The frame both states share. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-4 py-10 sm:px-6">
      <div className="flex items-center gap-2">
        <Logo className="size-5 text-brand" />
        <Wordmark />
      </div>
      <main className="flex flex-1 items-center justify-center">
        <div className="border-rule bg-bg-raised w-full max-w-md border p-6 sm:p-8">{children}</div>
      </main>
    </div>
  );
}
