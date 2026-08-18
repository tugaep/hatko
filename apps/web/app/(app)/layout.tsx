import { headers } from 'next/headers';
import { requireUser } from '../../lib/session.ts';
import { PATHNAME_HEADER } from '../../lib/pathname-header.ts';
import { Shell } from '../../components/nav.tsx';

/**
 * The gate for every authenticated page. Resolved on the server, so a signed-out
 * browser is redirected before any application markup is generated for it.
 *
 * The path comes from `proxy.ts` because a layout is not given one, and it used to be
 * the literal `/chat`. That resolved before the page inside it, so `/dashboard` sent a
 * signed-out visitor to `/sign-in?next=/chat` and they arrived at the chat page having
 * asked for the dashboard — the page's own correct `returnTo` never ran. Falling back to
 * `/chat` keeps that behaviour if the header is ever absent, which is the safe direction:
 * a wrong destination is a nuisance, and no gate at all is not.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const requested = (await headers()).get(PATHNAME_HEADER);
  const user = await requireUser(requested ?? '/chat');
  return <Shell user={user}>{children}</Shell>;
}
