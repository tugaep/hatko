import { requirePermission } from '../../../lib/session.ts';
import { Dashboard } from './dashboard.tsx';

/**
 * Admin-only. The gate runs on the server, so a regular user never receives this page's
 * markup — and every endpoint it calls is independently gated on the API, so bypassing
 * the redirect would still get 403s rather than data.
 */
export default async function DashboardPage() {
  await requirePermission('dashboard:view', '/dashboard');
  return <Dashboard />;
}
