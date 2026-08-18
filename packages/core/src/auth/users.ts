import { adminUserSchema, roleSchema, type AdminUser, type Role } from '@hatko/shared';
import { transaction, type Db } from '../db/client.ts';

/**
 * Reading and changing accounts, for the admin user-management surface.
 *
 * Account *creation* is not here — it lives in `accounts.ts`, which owns the one path
 * that hashes a password through Better Auth. Splitting them keeps this file free of
 * credentials entirely: nothing below reads, writes or returns a password.
 *
 * The guards in `assertNotSelf` and `assertNotLastAdmin` are the interesting part. An
 * admin surface that can lock every administrator out of the system is a worse outage
 * than the one it was built to prevent, and both mistakes are one click apart.
 */

/** Thrown when a change is refused because it would lock administrators out. */
export class UserManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserManagementError';
  }
}

/**
 * Thrown when the account being changed does not exist.
 *
 * Its own type because the two failures are not the same kind of thing and the API has to
 * answer them differently. The lockout guards above refuse a well-formed request that
 * conflicts with the state of the system — 409, and the fix is to promote someone else.
 * A missing id is 404, and the fix is to look again. Both were `UserManagementError`, so
 * `PUT /api/admin/users/nope` answered `409 conflict: No such account.` — a status that
 * tells a client the resource exists and is in the wrong state.
 *
 * A subclass, so a caller that only cares that the update was refused still catches one
 * type. `errors.ts` tests for this one first, which the ordering there notes.
 */
export class UserNotFoundError extends UserManagementError {
  constructor() {
    super('No such account.');
    this.name = 'UserNotFoundError';
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: unknown;
  disabled: number;
  createdAt: string;
}

/**
 * Narrow a row onto the shared contract.
 *
 * Same failing-closed rule as the session path: an unrecognised role degrades to
 * `user`, because a corrupt row should cost that account its privileges rather than
 * break the page that would let an administrator fix it.
 */
function toAdminUser(row: UserRow, currentUserId: string): AdminUser {
  const role = roleSchema.safeParse(row.role);
  return adminUserSchema.parse({
    id: row.id,
    email: row.email,
    name: row.name,
    role: role.success ? role.data : 'user',
    disabled: row.disabled !== 0,
    createdAt: row.createdAt,
    isSelf: row.id === currentUserId,
  });
}

export interface ListUsersOptions {
  limit: number;
  offset: number;
  q?: string | undefined;
}

export interface ListUsersResult {
  items: AdminUser[];
  total: number;
}

/**
 * One page of accounts, newest first.
 *
 * `currentUserId` is required rather than optional so every row can carry `isSelf`. The
 * UI needs it to disable the controls that would lock the current administrator out,
 * and computing it here means the client never has to compare ids itself and get it
 * wrong.
 */
export function listUsers(
  db: Db,
  currentUserId: string,
  options: ListUsersOptions,
): ListUsersResult {
  const filters: string[] = [];
  const params: unknown[] = [];

  if (options.q) {
    /**
     * Parameterised, so the text cannot alter the statement — but binding is not the
     * whole job. LIKE reads `%` and `_` in the *value* as wildcards, so a search for
     * `_` would match every account. Escaped the same way document search escapes it;
     * an administrator typing `%` into a filter box is searching, not writing SQL.
     */
    filters.push(`(lower("name") LIKE ? ESCAPE '\\' OR lower("email") LIKE ? ESCAPE '\\')`);
    const needle = `%${options.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    params.push(needle, needle);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT count(*) n FROM "user" ${where}`).get(...(params as never[])) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT "id", "email", "name", "role", "disabled", "createdAt"
         FROM "user" ${where}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...([...params, options.limit, options.offset] as never[])) as unknown as UserRow[];

  return {
    items: rows.map((row) => toAdminUser(row, currentUserId)),
    total: Number(total),
  };
}

export function getUser(db: Db, id: string, currentUserId: string): AdminUser | null {
  const row = db
    .prepare(
      `SELECT "id", "email", "name", "role", "disabled", "createdAt" FROM "user" WHERE "id" = ?`,
    )
    .get(id) as unknown as UserRow | undefined;

  return row ? toAdminUser(row, currentUserId) : null;
}

/**
 * Refuse a change to the acting administrator's own account.
 *
 * Not paternalism: demoting or disabling yourself is the single click that most easily
 * ends with nobody able to administer the system, and it is never what someone means to
 * do from a list of other people's accounts. Changing your own role is a deliberate act
 * that belongs at a CLI, where `npm run seed` already does it.
 */
function assertNotSelf(id: string, currentUserId: string): void {
  if (id === currentUserId) {
    throw new UserManagementError(
      'You cannot change your own role or deactivate your own account. Ask another administrator.',
    );
  }
}

/**
 * Refuse a change that would leave no active administrator.
 *
 * The check has to count *active* admins, not admins: disabling the second-to-last
 * administrator is fine, disabling the last one locks the door with the keys inside.
 * Called inside the caller's transaction so the count and the write cannot be separated
 * by another connection's commit.
 */
function assertNotLastAdmin(db: Db, id: string): void {
  const activeAdmins = (
    db.prepare(`SELECT count(*) n FROM "user" WHERE "role" = 'admin' AND "disabled" = 0`).get() as {
      n: number;
    }
  ).n;

  const target = db.prepare(`SELECT "role", "disabled" FROM "user" WHERE "id" = ?`).get(id) as
    { role: string; disabled: number } | undefined;

  const targetIsActiveAdmin = target?.role === 'admin' && target.disabled === 0;

  if (targetIsActiveAdmin && Number(activeAdmins) <= 1) {
    throw new UserManagementError(
      'This is the only active administrator. Promote another account before changing this one.',
    );
  }
}

export interface UpdateUserChanges {
  role?: Role | undefined;
  disabled?: boolean | undefined;
}

/**
 * Change a role, a deactivation, or both. Returns the updated account.
 *
 * Both changes are applied in one statement so a request asking for both cannot half
 * apply — promoting someone and failing to re-enable them would be a confusing state to
 * debug from the UI, and there is no reason to allow it.
 *
 * The last-admin count and the write it guards are wrapped in one transaction. Within
 * this process they could not be separated anyway — node:sqlite is synchronous and there
 * is no `await` between them — but that is an accident of the driver rather than a rule,
 * and it stops being true the day someone adds one. The transaction is what makes the
 * guarantee belong to the code instead of to the runtime.
 */
export function updateUser(
  db: Db,
  id: string,
  currentUserId: string,
  changes: UpdateUserChanges,
): AdminUser {
  assertNotSelf(id, currentUserId);

  const updated = transaction(db, () => {
    const existing = db.prepare(`SELECT "id" FROM "user" WHERE "id" = ?`).get(id) as
      { id: string } | undefined;
    if (!existing) throw new UserNotFoundError();

    // Only when the change actually removes an administrator. Promoting someone to admin,
    // or disabling a regular user, cannot reduce the count.
    const removesAnAdmin = changes.role === 'user' || changes.disabled === true;
    if (removesAnAdmin) assertNotLastAdmin(db, id);

    const sets: string[] = [];
    const params: unknown[] = [];

    if (changes.role !== undefined) {
      sets.push('"role" = ?');
      params.push(changes.role);
    }
    if (changes.disabled !== undefined) {
      sets.push('"disabled" = ?');
      params.push(changes.disabled ? 1 : 0);
    }

    // Better Auth stamps this on its own writes; a raw update has to keep it honest.
    sets.push('"updatedAt" = ?');
    params.push(new Date().toISOString());

    db.prepare(`UPDATE "user" SET ${sets.join(', ')} WHERE "id" = ?`).run(
      ...([...params, id] as never[]),
    );

    return getUser(db, id, currentUserId);
  });

  if (!updated) throw new UserNotFoundError();
  return updated;
}
