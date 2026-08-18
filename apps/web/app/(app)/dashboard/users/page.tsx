import { UsersPanel } from '../users-panel.tsx';

/**
 * Accounts. Reachable only with `users:manage`, which the layout's `dashboard:view` gate
 * does not imply — so the panel's own routes answer 403 to an admin-shaped session that
 * lacks it, and this page renders the refusal rather than pretending to be empty.
 */
export default function UsersPage() {
  return <UsersPanel />;
}
