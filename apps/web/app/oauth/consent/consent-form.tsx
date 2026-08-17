'use client';

import { useState } from 'react';
import { z } from 'zod';
import { API_URL } from '../../../lib/api.ts';
import { AlertIcon, Button } from '../../../components/ui.tsx';

/**
 * Approve or deny an OAuth authorization request.
 *
 * Both answers post to the same endpoint and both return a redirect URI — a denial is
 * not an error, it is an answer the waiting client is entitled to receive. Sending the
 * user back either way is what closes the loop; leaving them on a dead page would
 * leave the client hanging until its own timeout.
 */

const consentResponseSchema = z.object({ redirectURI: z.string() });

/** Better Auth answers with its own error shape here, not this application's envelope. */
const authErrorSchema = z.object({
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export function ConsentForm({ consentCode }: { consentCode: string }) {
  const [error, setError] = useState<string | null>(null);
  // Which button is working, so the other can be disabled without both showing a
  // spinner. Two buttons sharing one boolean is how "Deny" ends up looking like it
  // approved something.
  const [busy, setBusy] = useState<'accept' | 'deny' | null>(null);

  async function decide(accept: boolean) {
    setError(null);
    setBusy(accept ? 'accept' : 'deny');

    try {
      const response = await fetch(`${API_URL}/api/auth/oauth2/consent`, {
        method: 'POST',
        // The API also holds the consent code in a signed httpOnly cookie on its own
        // origin, and it verifies against that. Credentials must travel or the code in
        // this body is the only evidence, which is the weaker of the two.
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const parsed = authErrorSchema.safeParse(body);
        const message = parsed.success
          ? (parsed.data.error_description ?? parsed.data.message)
          : undefined;
        // A consent code is single-use and short-lived, so an expired one is the
        // likeliest failure by a wide margin. Say what to do about it.
        setError(
          message ??
            'This authorization request is no longer valid. Start again from your MCP client.',
        );
        setBusy(null);
        return;
      }

      const { redirectURI } = consentResponseSchema.parse(body);

      /**
       * `location.assign`, not `router.push`. The destination belongs to the client
       * application, not to this app, so there is no Next.js route to navigate to — and
       * a client-side transition would leave the user on our origin looking at nothing.
       */
      window.location.assign(redirectURI);
    } catch (error) {
      setError(
        error instanceof Error && error.name === 'TypeError'
          ? `Could not reach the API at ${API_URL}. Check that it is running.`
          : 'Something went wrong recording your decision. Try again.',
      );
      setBusy(null);
    }
  }

  return (
    <div className="mt-8">
      {error && (
        <p
          role="alert"
          className="mb-4 flex items-start gap-2 border border-danger bg-danger-subtle p-3 text-body-sm text-text"
        >
          <AlertIcon className="mt-0.5 size-4 shrink-0 text-danger-text" />
          <span>{error}</span>
        </p>
      )}

      {/*
       * Approve first in DOM order because it is the primary action, and on a phone the
       * two stack rather than shrinking to unreadable width. Deny is a real choice, not
       * a link in small print.
       */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="button"
          onClick={() => void decide(true)}
          disabled={busy !== null}
          loading={busy === 'accept'}
          className="sm:flex-1"
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void decide(false)}
          disabled={busy !== null}
          loading={busy === 'deny'}
          className="sm:flex-1"
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
