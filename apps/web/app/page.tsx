import { redirect } from 'next/navigation';
import { getSessionUser } from '../lib/session.ts';

/**
 * There is no marketing surface: this is an internal tool, so the root is a fork.
 * Signed in goes to the thing you came to do; signed out goes to the door.
 */
export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? '/chat' : '/sign-in');
}
