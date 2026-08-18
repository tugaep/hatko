import { PERMISSIONS, can, type Permission } from '@hatko/shared';
import { requirePermission } from '../../../lib/session.ts';
import { Chat } from './chat.tsx';

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
  const user = await requirePermission('search:run', '/chat');

  // `?denied=` is set by `requirePermission` when it bounces someone off a page their
  // role cannot open. Validated against the permission map rather than rendered raw:
  // it arrives from the URL bar, so an unrecognised value is discarded, not displayed.
  const { denied } = await searchParams;
  const deniedPermission = denied && denied in PERMISSIONS ? (denied as Permission) : undefined;

  // Whether to offer the model switcher, decided from the verified session rather than
  // in the browser. The routes behind it are gated on the same permission server-side, so
  // this only decides what is rendered, never what is allowed.
  return (
    <Chat
      canManageModels={can(user.role, 'documents:manage')}
      {...(deniedPermission ? { denied: deniedPermission } : {})}
    />
  );
}
