import type { Metadata } from 'next';
import { PERMISSIONS, type Permission } from '@hatko/shared';
import { requirePermission } from '../../../lib/session.ts';
import { Chat } from './chat.tsx';

export const metadata: Metadata = { title: 'Ask' };

/**
 * The end-user surface. Gated on `search:run`, which both roles hold — the gate is here
 * anyway so the page cannot be reached without a verified session, rather than relying
 * on the layout above it staying correct.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  await requirePermission('search:run', '/chat');

  // `?denied=` is set by `requirePermission` when it bounces someone off a page their
  // role cannot open. Validated against the permission map rather than rendered raw:
  // it arrives from the URL bar, so an unrecognised value is discarded, not displayed.
  const { denied } = await searchParams;
  const deniedPermission = denied && denied in PERMISSIONS ? (denied as Permission) : undefined;

  return <Chat {...(deniedPermission ? { denied: deniedPermission } : {})} />;
}
