'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The admin area's sections, as routes rather than as client-side tab state.
 *
 * Routes because every one of these is somewhere a person needs to send someone else:
 * "the ingestion history" is a link, the back button works, and a failed ingest can be
 * reopened where it was left. Tab state in a `useState` gives none of that and costs the
 * same to write.
 *
 * It also splits the work. Each tab now fetches only what it renders, so opening Users no
 * longer pulls the embedding projection, and one failing endpoint takes out one section
 * instead of the page — which was already the intent of loading each panel independently,
 * carried one level up.
 */

export const DASHBOARD_TABS = [
  // 'Analytics', not 'Dashboard'. The nav item above already says Dashboard, and a tab
  // repeating its parent's name says nothing about what is on it — this one is the only
  // section that reports rather than configures.
  { href: '/dashboard', label: 'Analytics' },
  { href: '/dashboard/models', label: 'Model configuration' },
  { href: '/dashboard/documents', label: 'Documents' },
  { href: '/dashboard/ingestion', label: 'Ingestion' },
  { href: '/dashboard/users', label: 'Users' },
] as const;

export function DashboardTabs() {
  const pathname = usePathname();

  return (
    // Horizontally scrollable rather than wrapping: five labels do not fit on a phone,
    // and a tab strip that reflows to two rows stops reading as one control.
    <nav aria-label="Dashboard sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-rule">
        {DASHBOARD_TABS.map((tab) => {
          // Exact match for the overview, prefix for the rest — otherwise every tab would
          // light up as soon as any of them is open, since all of them start with /dashboard.
          const active =
            tab.href === '/dashboard' ? pathname === tab.href : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? '-mb-px block border-b-2 border-brand px-3 py-2 text-body-sm text-text'
                    : '-mb-px block border-b-2 border-transparent px-3 py-2 text-body-sm text-text-muted transition-colors hover:text-text'
                }
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
