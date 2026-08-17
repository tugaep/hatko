'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { apiErrorSchema } from '@sorrel/shared';
import { API_URL } from '../../lib/api.ts';
import { Button, Field, Input } from '../../components/ui.tsx';

/**
 * Sign-in posts straight to Better Auth, which sets the httpOnly session cookie. No
 * token is ever handled here — the browser cannot read the cookie, and this component
 * does not try.
 *
 * On success the server gates re-run via `router.refresh()`, so the decision about
 * where the user may go is made by the server that just issued the session, not by this
 * form guessing from a 200.
 */

/** Better Auth answers with its own error shape, not this application's envelope. */
const authErrorSchema = z.object({ message: z.string().min(1) });

/**
 * Turn a failed response into something worth reading.
 *
 * Deliberately does not distinguish "no such account" from "wrong password" — the
 * server does not, and inventing the distinction in the client would leak which emails
 * have accounts.
 */
async function messageFor(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);

  const envelope = apiErrorSchema.safeParse(body);
  if (envelope.success) return envelope.data.error.message;

  const authError = authErrorSchema.safeParse(body);
  if (authError.success) return authError.data.message;

  if (response.status === 429) return 'Too many attempts. Wait a moment and try again.';
  return `Sign-in failed (${response.status}).`;
}

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(`${API_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      });

      if (!response.ok) {
        setError(await messageFor(response));
        return;
      }

      router.replace(next);
      router.refresh();
    } catch {
      setError(`Could not reach the API at ${API_URL}. Check that it is running.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-8 grid gap-5">
      <Field label="Email" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          spellCheck={false}
          autoCapitalize="none"
          placeholder="you@studio.internal"
          invalid={error !== null}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={error ?? undefined}
        hint="Minimum 8 characters."
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          invalid={error !== null}
          aria-describedby={error ? 'password-error' : undefined}
        />
      </Field>

      <Button type="submit" size="lg" loading={busy} className="w-full">
        Sign in
      </Button>
    </form>
  );
}
