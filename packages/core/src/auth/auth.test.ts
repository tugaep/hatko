import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Authentication and authorization.
 *
 * The auth module reads config at import time and binds to the process-wide
 * database, so a secret and an isolated database file are set up before the
 * module graph loads — hence the dynamic imports.
 *
 * What is asserted here is what must hold no matter which library is underneath:
 * a password never reaches the database in a readable form, a role cannot be
 * claimed by a client, and permission checks refuse by default.
 */

process.env.BETTER_AUTH_SECRET ??= 'test-only-secret-not-used-outside-node-test-runs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-auth-'));
const dbFile = path.join(dir, 'auth.db');
process.env.DATABASE_PATH = dbFile;

const { getDb, closeDb } = await import('../db/client.ts');
const { auth, getSessionUser, requirePermission, requireUser, AuthorizationError } =
  await import('./index.ts');
const { can } = await import('@sorrel/shared');
const { upsertAccount } = await import('./accounts.ts');

/** Structural shape of AuthorizationError; the class arrives via dynamic import. */
type AuthError = { status: number; code: string; message: string };

const db = getDb();

const PASSWORD = 'correct-horse-battery';

async function createUser(email: string, role: 'user' | 'admin') {
  const created = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: email.split('@')[0]! },
  });
  db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run(role, created.user.id);
  return created.user.id;
}

/** Sign in and return the cookie header a browser would send back. */
async function signIn(email: string, password = PASSWORD): Promise<string | null> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  if (response.status !== 200) return null;
  return response.headers.getSetCookie().join('; ');
}

const adminId = await createUser('admin@test.local', 'admin');
await createUser('user@test.local', 'user');

test.after(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- credential storage -----------------------------------------------------

test('no password is recoverable from the database file', () => {
  // The regression this pins actually happened: the seed script's re-seed path
  // called updatePassword with a plaintext value, and since that function stores
  // rather than hashes, the password landed in the account table verbatim.
  // Sign-in kept working, so nothing failed — the only visible symptom was the
  // row itself.
  const rows = db
    .prepare('SELECT password FROM account WHERE password IS NOT NULL')
    .all() as Array<{
    password: string;
  }>;

  assert.ok(rows.length >= 2, 'both demo accounts have stored credentials');
  for (const row of rows) {
    assert.ok(!row.password.includes(PASSWORD), 'plaintext password stored in the account table');
  }

  const bytes = fs.readFileSync(dbFile).toString('binary');
  assert.ok(!bytes.includes(PASSWORD), 'plaintext password present in the database file');
});

test('re-seeding an existing account stores a hash, not the plaintext', async () => {
  // This is the path that broke. The original code passed the raw password to
  // updatePassword, which stores rather than hashes, so the plaintext replaced the
  // hash written at sign-up — and sign-in kept working, so nothing failed.
  const account = {
    email: 'reseed@test.local',
    password: 'a-distinctive-seed-password',
    name: 'Reseed',
    role: 'admin' as const,
  };

  assert.equal(await upsertAccount(db, account), 'created');
  assert.equal(await upsertAccount(db, account), 'updated', 'second run takes the update path');

  const row = db
    .prepare(
      'SELECT a.password FROM account a JOIN "user" u ON u.id = a."userId" WHERE u.email = ?',
    )
    .get(account.email) as { password: string };

  assert.ok(!row.password.includes(account.password), 'plaintext survived the update path');

  // And the reset password must still authenticate afterwards.
  const ctx = await auth.$context;
  assert.equal(await ctx.password.verify({ hash: row.password, password: account.password }), true);

  const bytes = fs.readFileSync(dbFile).toString('binary');
  assert.ok(!bytes.includes(account.password), 'plaintext present in the database file');
});

test('re-seeding applies the role by server-side write', async () => {
  const row = db.prepare('SELECT role FROM "user" WHERE email = ?').get('reseed@test.local') as {
    role: string;
  };
  assert.equal(row.role, 'admin');
});

test('a stored credential verifies against the right password and no other', async () => {
  const ctx = await auth.$context;
  const row = db.prepare('SELECT password FROM account WHERE "userId" = ?').get(adminId) as {
    password: string;
  };

  assert.equal(await ctx.password.verify({ hash: row.password, password: PASSWORD }), true);
  assert.equal(await ctx.password.verify({ hash: row.password, password: 'wrong' }), false);
});

// --- sessions ---------------------------------------------------------------

test('a valid sign-in yields a session that resolves to the right user and role', async () => {
  const cookie = await signIn('admin@test.local');
  assert.ok(cookie, 'sign-in succeeded');

  const user = await getSessionUser(new Headers({ cookie }));
  assert.equal(user?.email, 'admin@test.local');
  assert.equal(user?.role, 'admin');
});

test('a wrong password does not produce a session', async () => {
  assert.equal(await signIn('admin@test.local', 'not-the-password'), null);
});

test('no cookie means no user, rather than an error', async () => {
  assert.equal(await getSessionUser(new Headers()), null);
});

test('a forged cookie is rejected', async () => {
  // The session token is signed; inventing one must not authenticate.
  const forged = 'better-auth.session_token=forged-token-value-that-was-never-issued';
  assert.equal(await getSessionUser(new Headers({ cookie: forged })), null);
});

test('the session cookie is httpOnly and same-site', async () => {
  const response = await auth.api.signInEmail({
    body: { email: 'user@test.local', password: PASSWORD },
    asResponse: true,
  });
  const setCookie = response.headers.getSetCookie().join('; ');

  assert.match(setCookie, /HttpOnly/i, 'not readable from JavaScript');
  assert.match(setCookie, /SameSite=Lax/i, 'not sent on cross-site requests');
});

// --- role assignment --------------------------------------------------------

test('a client cannot assign itself a role at sign-up', async () => {
  // `input: false` on the role field. Without it this request would create an
  // admin, and every authorization check downstream would be decorative.
  await auth.api.signUpEmail({
    body: {
      email: 'sneaky@test.local',
      password: PASSWORD,
      name: 'Sneaky',
      role: 'admin',
    } as never,
  });

  const row = db.prepare('SELECT role FROM "user" WHERE email = ?').get('sneaky@test.local') as {
    role: string;
  };
  assert.equal(row.role, 'user', 'the requested admin role was ignored');
});

// --- authorization ----------------------------------------------------------

test('permissions are refused without a session', async () => {
  await assert.rejects(requirePermission(new Headers(), 'search:run'), (error: AuthError) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'unauthorized');
    return true;
  });
});

test('a regular user may search but not reach the dashboard', async () => {
  const cookie = await signIn('user@test.local');
  const headers = new Headers({ cookie: cookie! });

  const user = await requirePermission(headers, 'search:run');
  assert.equal(user.role, 'user');

  // 403, not 401: the difference between "sign in" and "your account cannot do
  // this", which the UI needs in order to say which.
  await assert.rejects(requirePermission(headers, 'dashboard:view'), (error: AuthError) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'forbidden');
    return true;
  });
});

test('a regular user cannot trigger ingestion or manage documents', async () => {
  const cookie = await signIn('user@test.local');
  const headers = new Headers({ cookie: cookie! });

  for (const permission of ['ingestion:trigger', 'documents:manage'] as const) {
    await assert.rejects(
      requirePermission(headers, permission),
      (error: AuthError) => error.status === 403,
      `a regular user must not hold ${permission}`,
    );
  }
});

test('an admin holds every permission a user does, and the admin-only ones too', async () => {
  const cookie = await signIn('admin@test.local');
  const headers = new Headers({ cookie: cookie! });

  for (const permission of [
    'search:run',
    'answer:generate',
    'dashboard:view',
    'documents:manage',
    'ingestion:trigger',
  ] as const) {
    const user = await requirePermission(headers, permission);
    assert.equal(user.role, 'admin');
  }
});

test('requireUser accepts any session but still refuses none', async () => {
  const cookie = await signIn('user@test.local');
  assert.equal((await requireUser(new Headers({ cookie: cookie! }))).role, 'user');
  await assert.rejects(requireUser(new Headers()), /Sign in/);
});

test('the permission map refuses an absent or unknown role', () => {
  // Fail closed. An account whose role column was corrupted loses access rather
  // than gaining it.
  assert.equal(can(undefined, 'search:run'), false);
  assert.equal(can('nonsense' as never, 'search:run'), false);
  assert.equal(can('user', 'dashboard:view'), false);
  assert.equal(can('admin', 'dashboard:view'), true);
});
