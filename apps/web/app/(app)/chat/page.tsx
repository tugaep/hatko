import type { Metadata } from 'next';
import { requirePermission } from '../../../lib/session.ts';
import { Chat } from './chat.tsx';

export const metadata: Metadata = { title: 'Ask' };

/**
 * The end-user surface. Gated on `search:run`, which both roles hold — the gate is here
 * anyway so the page cannot be reached without a verified session, rather than relying
 * on the layout above it staying correct.
 */
export default async function ChatPage() {
  await requirePermission('search:run', '/chat');
  return <Chat />;
}
