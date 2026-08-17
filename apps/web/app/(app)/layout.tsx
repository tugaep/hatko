import { requireUser } from '../../lib/session.ts';
import { Shell } from '../../components/nav.tsx';

/**
 * The gate for every authenticated page. Resolved on the server, so a signed-out
 * browser is redirected before any application markup is generated for it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser('/chat');
  return <Shell user={user}>{children}</Shell>;
}
