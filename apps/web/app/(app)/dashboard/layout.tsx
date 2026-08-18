import { requirePermission } from '../../../lib/session.ts';
import { DashboardTabs } from './tabs.tsx';

/**
 * The gate and the frame for every admin section.
 *
 * One `requirePermission` here rather than one per tab: a page added under this directory
 * inherits the check instead of needing to remember it, which is the failure mode a
 * per-page gate has. Every endpoint these pages call is independently gated on the API,
 * so this decides what markup a browser receives, never what it is allowed to read.
 *
 * `/dashboard` is the returnTo for all of them, so a signed-out admin who followed a link
 * to Users lands back in the admin area rather than on a sub-page whose tab strip has not
 * rendered yet.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('dashboard:view', '/dashboard');

  return (
    <div className="grid gap-8 py-6 pb-[calc(var(--nav-h)+3rem)] sm:py-8">
      <div className="grid gap-4">
        <h1 className="font-display text-h1 text-text">Admin</h1>
        <DashboardTabs />
      </div>
      {children}
    </div>
  );
}
