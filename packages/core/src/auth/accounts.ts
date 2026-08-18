import type { Role } from '@hatko/shared';
import type { Db } from '../db/client.ts';
import { getAuth } from './index.ts';

/**
 * Account creation and password reset, used by the seed script.
 *
 * Extracted from the CLI so the update path is reachable from a test. It broke
 * once and the CLI-only shape is why nothing caught it: `updatePassword` stores an
 * already-hashed value rather than hashing what it is given, so passing a
 * plaintext password wrote it to the account table verbatim. Sign-in continued to
 * work — verification compared a hash against a value that happened to be stored
 * where a hash belongs — so the only symptom was the row itself.
 */

export interface DemoAccount {
  email: string;
  password: string;
  name: string;
  role: Role;
}

export type UpsertOutcome = 'created' | 'updated';

/**
 * Create the account if absent, otherwise reset its password and role.
 *
 * The role is applied by direct write, deliberately. The sign-up API refuses role
 * input (`input: false` in ./index.ts) so that a crafted request cannot claim
 * admin; that refusal applies to this script too, which is why the privilege is
 * granted in a separate, explicitly server-side step.
 */
export async function upsertAccount(db: Db, account: DemoAccount): Promise<UpsertOutcome> {
  if (account.password.length < 8) {
    throw new Error(
      `The password for ${account.email} is shorter than the 8 character minimum. ` +
        'Check the SEED_* values in .env.',
    );
  }

  const existing = db.prepare('SELECT id FROM "user" WHERE email = ?').get(account.email) as
    { id: string } | undefined;

  const setRole = (id: string) =>
    db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run(account.role, id);

  if (existing) {
    const ctx = await getAuth().$context;
    // Hash first. updatePassword is the storage step, not the credential step.
    const hashed = await ctx.password.hash(account.password);
    await ctx.internalAdapter.updatePassword(existing.id, hashed);
    setRole(existing.id);
    return 'updated';
  }

  const created = await getAuth().api.signUpEmail({
    body: { email: account.email, password: account.password, name: account.name },
  });
  setRole(created.user.id);
  return 'created';
}

/** The two accounts the README documents, read from the environment with defaults. */
export function demoAccounts(): DemoAccount[] {
  return [
    {
      email: process.env.SEED_ADMIN_EMAIL ?? 'efe@tugrap.dev',
      password: process.env.SEED_ADMIN_PASSWORD ?? 'PlayableFactory7766',
      name: 'Demo Admin',
      role: 'admin',
    },
    {
      email: process.env.SEED_USER_EMAIL ?? 'user@tugrap.dev',
      password: process.env.SEED_USER_PASSWORD ?? 'PlayableFactory6677',
      name: 'Demo User',
      role: 'user',
    },
  ];
}
