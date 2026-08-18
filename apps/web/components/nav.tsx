'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { can, type SessionUser } from '@hatko/shared';
import { API_URL } from '../lib/api.ts';
import { Logo, Wordmark } from './marks.tsx';
import { Badge, Button, cx } from './ui.tsx';

/**
 * The application shell.
 *
 * Nav entries are filtered through the same shared `can()` used by the API's route
 * guards, so a regular user is never offered the dashboard link. That is presentation,
 * not protection — the server-side page gate and the API's middleware are what actually
 * refuse the request. Hiding a link is a courtesy; it is never the control.
 */

const ITEMS = [
  { href: '/chat', label: 'Ask', permission: 'search:run' },
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard:view' },
] as const;

export function Shell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const pathname = usePathname();

  /**
   * Prefix match, not equality. The admin area is five routes under /dashboard now, and
   * an exact comparison unlit the nav item as soon as any tab but the first was open —
   * so the surface you were looking at claimed you were somewhere else.
   */
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const items = ITEMS.filter((item) => can(user.role, item.permission));
  // A single nav entry does not earn a bottom bar; one link belongs in the top bar alone.
  const bottomBar = items.length > 1;

  return (
    // Published so a sticky element inside a page can clear the bottom bar without
    // knowing whether this user has one. The chat composer is the caller.
    <div className="min-h-dvh" style={{ ['--nav-h' as string]: bottomBar ? '3.5rem' : '0rem' }}>
      {/* Opaque, not translucent — the interface is a printed surface, not glass. */}
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-rule bg-bg">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link
            href="/chat"
            className="flex items-center gap-2 rounded-sm"
            aria-label="hatko: ask a question"
          >
            <Logo className="size-5 text-brand" />
            <Wordmark />
          </Link>

          {/* Top bar from tablet up; phones get the bottom bar instead. */}
          <nav aria-label="Main" className="hidden md:flex md:items-center md:gap-1">
            {items.map((item) => (
              <TopLink key={item.href} href={item.href} active={isActive(item.href)}>
                {item.label}
              </TopLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-caption text-text-muted sm:inline">{user.email}</span>
            <Badge tone={user.role === 'admin' ? 'brand' : 'neutral'}>{user.role}</Badge>
            <SignOutButton />
          </div>
        </div>
      </header>

      {/* Vertical rhythm is the page's business — chat ends in a sticky composer, the
          dashboard in ordinary content, and they need different room at the bottom. */}
      <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">{children}</main>

      <Footer padForBottomBar={bottomBar} />

      {bottomBar && (
        <nav
          aria-label="Main"
          // Safe-area inset so the bar clears a home indicator rather than sitting under it.
          className="fixed inset-x-0 bottom-0 z-[var(--z-nav)] border-t border-rule bg-bg-raised pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <ul className="flex">
            {items.map((item) => (
              <li key={item.href} className="flex-1">
                <BottomLink href={item.href} active={isActive(item.href)}>
                  {item.label}
                </BottomLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

function TopLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'rounded-sm px-3 py-1.5 text-body-sm font-medium transition-colors duration-120 ease-brand',
        active ? 'bg-bg-sunken text-text' : 'text-text-muted hover:bg-bg-sunken hover:text-text',
      )}
    >
      {children}
    </Link>
  );
}

function BottomLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-14 items-center justify-center text-body-sm font-medium transition-colors duration-120 ease-brand',
        active
          ? 'border-t-2 border-brand text-text'
          : 'border-t-2 border-transparent text-text-muted',
      )}
    >
      {children}
    </Link>
  );
}

/**
 * Sign-out is a POST to Better Auth, which clears the httpOnly cookie server-side.
 * `router.refresh()` then re-runs the server gates, which redirect to sign-in — so the
 * client never decides it is signed out on its own.
 */
function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch(`${API_URL}/api/auth/sign-out`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } finally {
      // Even if the request failed, send them to sign-in: staying on an authenticated
      // page after pressing "sign out" is the worse outcome.
      router.replace('/sign-in');
      router.refresh();
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={signOut} loading={busy}>
      Sign out
    </Button>
  );
}

/**
 * Site footer. Product first: what hatko is, then who built it. The links are the two
 * that belong to the author of this build, and they open in a new tab so a half-written
 * question in the composer survives the trip.
 */
function Footer({ padForBottomBar }: { padForBottomBar: boolean }) {
  return (
    <footer
      className={cx(
        'mt-16 border-t border-rule',
        // Clears the fixed bottom bar on phones; the bar is md:hidden, so is this padding.
        padForBottomBar && 'pb-[var(--nav-h)] md:pb-0',
      )}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="max-w-md">
          <p className="text-body-sm font-medium text-text">hatko</p>
          <p className="mt-1 text-caption text-text-muted">
            Semantic search over an internal corpus. Answers are written from the passages it
            retrieves, and it says so when the corpus has no answer.
          </p>
        </div>

        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
          <span className="text-caption text-text-muted">Made by Tuğrap Efe Dikpınar</span>
          <FooterLink href="https://tugrap.dev">tugrap.dev</FooterLink>
          <FooterLink href="https://github.com/tugaep">GitHub</FooterLink>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-1.5 rounded-sm text-body-sm text-text-muted transition-colors duration-120 ease-brand hover:text-text"
    >
      {children}
      <ArrowUpRight className="size-3.5 transition-transform duration-120 ease-brand group-hover:-translate-y-px group-hover:translate-x-px" />
    </a>
  );
}

function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}
