'use client';

import { useState } from 'react';
import { adminUserSchema, paginated, roleSchema, type AdminUser, type Role } from '@hatko/shared';
import { messageOf } from '../../../lib/api.ts';
import { apiSend } from '../../../lib/client.ts';
import { useApi } from '../../../lib/use-api.ts';
import { formatDateTime } from '../../../lib/format.ts';
import {
  Badge,
  Button,
  ErrorCard,
  Eyebrow,
  Field,
  Input,
  LabelFrame,
  SkeletonLine,
} from '../../../components/ui.tsx';

/**
 * Accounts: who exists, what they may do, and who is switched off.
 *
 * Every control here is a courtesy over a server-side rule, not a substitute for one.
 * The API refuses to let an administrator change their own account or remove the last
 * active administrator; this panel disables those buttons so the refusal is rare rather
 * than the way people discover the rule. If the two ever disagree, the server wins and
 * the error appears in the card.
 */

const usersResponseSchema = paginated(adminUserSchema);

/** Roles as an administrator reads them, rather than as the permission map spells them. */
const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  user: 'User',
};

export function UsersPanel() {
  const [query, setQuery] = useState('');
  // The request path carries the filter, so `useApi` aborts the in-flight request when
  // it changes and a slow earlier response cannot land after a faster later one.
  const path = `/api/admin/users?limit=50${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`;
  const users = useApi(path, usersResponseSchema);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function update(user: AdminUser, changes: { role?: Role; disabled?: boolean }) {
    setBusyId(user.id);
    setActionError(null);
    try {
      await apiSend('PUT', `/api/admin/users/${user.id}`, adminUserSchema, changes);
      users.reload();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="users-heading" className="grid gap-4">
      <div>
        <h2 id="users-heading" className="font-display text-h2 text-text">
          Users
        </h2>
        <p className="mt-1 text-body-sm text-text-muted">
          Who can sign in, and what their role lets them reach. Deactivating an account ends its
          sessions and its MCP access immediately.
        </p>
      </div>

      <AddUserForm onAdded={users.reload} />

      <LabelFrame
        title={
          <Eyebrow as="h3">
            Accounts
            {users.data ? ` — ${users.data.total}` : ''}
          </Eyebrow>
        }
      >
        <div className="grid gap-4">
          <Field label="Filter" htmlFor="user-filter">
            <Input
              id="user-filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or email…"
            />
          </Field>

          {actionError && <ErrorCard title="That change was not applied." detail={actionError} />}

          {users.error ? (
            <ErrorCard
              title="Could not load accounts."
              detail={users.error}
              onRetry={users.reload}
            />
          ) : users.loading && !users.data ? (
            <div className="grid gap-2">
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-5/6" />
              <SkeletonLine className="w-4/6" />
            </div>
          ) : users.data && users.data.items.length === 0 ? (
            <p className="text-body-sm text-text-muted">
              {query.trim() ? 'No account matches that filter.' : 'No accounts yet.'}
            </p>
          ) : (
            /*
             * A table, because this is tabular data and a screen reader should be able to
             * say "row 3, Role, Admin". It scrolls inside its own container rather than
             * pushing the page sideways on a phone.
             */
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[36rem] border-collapse text-body-sm">
                <thead>
                  <tr className="border-b border-rule text-left">
                    <th scope="col" className="text-caption py-2 pr-4 font-normal text-text-muted">
                      Account
                    </th>
                    <th scope="col" className="text-caption py-2 pr-4 font-normal text-text-muted">
                      Role
                    </th>
                    <th scope="col" className="text-caption py-2 pr-4 font-normal text-text-muted">
                      Added
                    </th>
                    <th
                      scope="col"
                      className="text-caption py-2 text-right font-normal text-text-muted"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.data?.items.map((user) => (
                    <UserRow
                      key={user.id}
                      user={user}
                      busy={busyId === user.id}
                      disabledControls={busyId !== null}
                      onUpdate={update}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </LabelFrame>
    </section>
  );
}

function UserRow({
  user,
  busy,
  disabledControls,
  onUpdate,
}: {
  user: AdminUser;
  busy: boolean;
  disabledControls: boolean;
  onUpdate: (user: AdminUser, changes: { role?: Role; disabled?: boolean }) => void;
}) {
  const nextRole: Role = user.role === 'admin' ? 'user' : 'admin';

  return (
    <tr className="border-b border-rule align-middle">
      <td className="py-3 pr-4">
        <div className="text-text">{user.name}</div>
        <div className="text-caption break-all text-text-muted">{user.email}</div>
      </td>
      <td className="py-3 pr-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={user.role === 'admin' ? 'brand' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge>
          {user.disabled && <Badge tone="danger">Deactivated</Badge>}
          {/* Said plainly, because it is the reason the buttons beside it are inert. */}
          {user.isSelf && <span className="text-caption text-text-muted">you</span>}
        </div>
      </td>
      <td className="tabular py-3 pr-4 text-text-muted">{formatDateTime(user.createdAt)}</td>
      <td className="py-3">
        <div className="flex justify-end gap-2">
          {/*
           * Both actions are withheld for your own account. The server refuses them
           * anyway — this stops an administrator discovering that by locking themselves
           * out of the page they are standing on.
           */}
          <Button
            size="sm"
            variant="ghost"
            disabled={user.isSelf || disabledControls}
            loading={busy}
            onClick={() => onUpdate(user, { role: nextRole })}
            title={user.isSelf ? 'You cannot change your own role.' : undefined}
          >
            Make {ROLE_LABELS[nextRole].toLowerCase()}
          </Button>
          <Button
            size="sm"
            variant={user.disabled ? 'secondary' : 'danger'}
            disabled={user.isSelf || disabledControls}
            loading={busy}
            onClick={() => onUpdate(user, { disabled: !user.disabled })}
            title={user.isSelf ? 'You cannot deactivate your own account.' : undefined}
          >
            {user.disabled ? 'Reactivate' : 'Deactivate'}
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Add an account.
 *
 * "Add", not "invite": there is no mail service, so the administrator sets an initial
 * password and passes it on themselves. Labelling this "invite" would promise an email
 * that never arrives, which is the kind of small lie that costs a support conversation.
 */
function AddUserForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('user');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy(true);

    try {
      await apiSend('POST', '/api/admin/users', adminUserSchema, {
        email: String(form.get('email') ?? '').trim(),
        name: String(form.get('name') ?? '').trim(),
        password: String(form.get('password') ?? ''),
        role,
      });
      setOpen(false);
      setRole('user');
      onAdded();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Add an account
        </Button>
      </div>
    );
  }

  return (
    <LabelFrame title={<Eyebrow as="h3">New account</Eyebrow>}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="new-user-name">
            <Input id="new-user-name" name="name" required maxLength={120} autoComplete="off" />
          </Field>
          <Field label="Email" htmlFor="new-user-email">
            <Input
              id="new-user-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              placeholder="you@studio.internal"
            />
          </Field>
        </div>

        <Field
          label="Initial password"
          htmlFor="new-user-password"
          hint="At least 8 characters. Pass it on yourself — Hatko sends no email."
        >
          {/*
           * `type="text"`, deliberately. The administrator has to read this value in
           * order to hand it over, and a masked field they cannot check is how a typo
           * becomes an account nobody can sign in to. `autoComplete="new-password"`
           * keeps the browser from filling in their own credentials.
           */}
          <Input
            id="new-user-password"
            name="password"
            type="text"
            required
            minLength={8}
            maxLength={200}
            autoComplete="new-password"
          />
        </Field>

        <Field label="Role" htmlFor="new-user-role">
          {/*
           * A native select: it is a short list of mutually exclusive options, and the
           * platform control is keyboard-accessible, screen-reader-correct and behaves
           * like every other one on the user's device without any code from us.
           */}
          <select
            id="new-user-role"
            value={role}
            onChange={(event) => setRole(roleSchema.parse(event.target.value))}
            className="h-10 w-full rounded-sm border border-border-interactive bg-bg px-3 text-body-sm text-text"
          >
            <option value="user">User — can search and ask questions</option>
            <option value="admin">Admin — can also manage the corpus and accounts</option>
          </select>
        </Field>

        {error && <ErrorCard title="The account was not created." detail={error} />}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>
            Create account
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </LabelFrame>
  );
}
