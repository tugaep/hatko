import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The API key is a live credential that an admin types into a browser, so the
 * things worth pinning are: it is unreadable in the database file, it never comes
 * back out through a status call, and resolution order is unambiguous when both
 * the database and the environment supply one.
 *
 * config.ts snapshots process.env when it is imported, and static imports are
 * hoisted above any statement — so the encryption secret has to be in place
 * before the module graph loads, and the imports below are therefore dynamic.
 * Without this the suite would only pass for someone who happened to have a real
 * BETTER_AUTH_SECRET exported in their shell.
 */
process.env.BETTER_AUTH_SECRET ??= 'test-only-secret-not-used-outside-node-test-runs';

const { openDb } = await import('./db/client.ts');
const { requireAppSecret } = await import('./config.ts');
const {
  SETTING_KEYS,
  clearSecret,
  decryptSecret,
  encryptSecret,
  getApiKeyStatus,
  getSecret,
  requireApiKey,
  resolveApiKey,
  setSecret,
} = await import('./settings.ts');

const REAL_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789a91f';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorrel-settings-'));
  const file = path.join(dir, 'test.db');
  const db = openDb(file);
  return {
    db,
    file,
    [Symbol.dispose]() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a secret round-trips through encryption', () => {
  assert.equal(decryptSecret(encryptSecret(REAL_KEY)), REAL_KEY);
});

test('encryption is non-deterministic, so equal keys do not produce equal ciphertext', () => {
  // A fresh IV per write. Without it, someone holding two database files could
  // tell they share a key without decrypting either.
  assert.notEqual(encryptSecret(REAL_KEY), encryptSecret(REAL_KEY));
});

test('a tampered ciphertext fails loudly rather than decrypting to garbage', () => {
  const raw = Buffer.from(encryptSecret(REAL_KEY), 'base64');
  raw[raw.length - 1] = (raw.at(-1) ?? 0) ^ 0xff;

  // GCM authentication. Without the tag check this would yield corrupted bytes
  // that surface much later as an inexplicable 401 from the provider.
  assert.throws(() => decryptSecret(raw.toString('base64')));
});

test('the stored key is not recoverable from the database file', () => {
  using ctx = tempDb();
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY, 'user-1');

  const bytes = fs.readFileSync(ctx.file).toString('binary');

  assert.ok(!bytes.includes(REAL_KEY), 'plaintext key must not appear in the database file');
  assert.ok(!bytes.includes('sk-proj-abcdefghij'), 'not even a recognisable prefix');
});

test('status reports the key without exposing it', () => {
  using ctx = tempDb();
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY, 'user-1');

  const status = getApiKeyStatus(ctx.db);

  assert.equal(status.configured, true);
  assert.equal(status.source, 'database');
  assert.equal(status.hint, '…a91f', 'only the last four characters');
  assert.equal(status.updatedBy, 'user-1');
  assert.ok(status.updatedAt);

  // The point of the whole shape: nothing returned can reconstruct the key.
  assert.ok(!JSON.stringify(status).includes(REAL_KEY));
});

test('a stored key resolves ahead of the environment', () => {
  using ctx = tempDb();
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY);

  assert.equal(resolveApiKey(ctx.db), REAL_KEY);
  assert.equal(getApiKeyStatus(ctx.db).source, 'database');
});

test('clearing the stored key falls back to the environment', () => {
  using ctx = tempDb();
  const ENV_KEY = 'sk-environment-fallback-0000-0000';

  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY);
  assert.equal(resolveApiKey(ctx.db, ENV_KEY), REAL_KEY, 'the stored key wins while it exists');

  clearSecret(ctx.db, SETTING_KEYS.openaiApiKey);

  assert.equal(getSecret(ctx.db, SETTING_KEYS.openaiApiKey), null);
  assert.equal(resolveApiKey(ctx.db, ENV_KEY), ENV_KEY, 'and the environment takes over');
  assert.equal(resolveApiKey(ctx.db, null), null, 'with neither set, nothing is resolved');
});

test('re-saving replaces rather than accumulating rows', () => {
  using ctx = tempDb();
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY, 'user-1');
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, 'sk-second-key-value-0000-beef', 'user-2');

  const rows = ctx.db.prepare('SELECT count(*) n FROM settings').get() as { n: number };

  assert.equal(rows.n, 1);
  assert.equal(getSecret(ctx.db, SETTING_KEYS.openaiApiKey), 'sk-second-key-value-0000-beef');
  assert.equal(getApiKeyStatus(ctx.db).updatedBy, 'user-2');
});

test('an empty secret is refused rather than silently stored', () => {
  using ctx = tempDb();
  assert.throws(() => setSecret(ctx.db, SETTING_KEYS.openaiApiKey, '   '), /empty/i);
});

test('a key saved under a different secret reports rotation, not "unset"', () => {
  using ctx = tempDb();
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY);

  // Simulate BETTER_AUTH_SECRET having been rotated after the key was saved.
  const stored = ctx.db.prepare('SELECT value FROM settings').get() as { value: string };
  const corrupted = Buffer.from(stored.value, 'base64');
  corrupted[30] = (corrupted.at(30) ?? 0) ^ 0xff;
  ctx.db.prepare('UPDATE settings SET value = ?').run(corrupted.toString('base64'));

  // Falling through to the environment here would tell the operator no key is
  // configured while the admin screen plainly shows one — so it throws instead.
  assert.throws(() => resolveApiKey(ctx.db), /BETTER_AUTH_SECRET changed/);
});

test('a missing key produces an actionable error naming both ways to set it', () => {
  using ctx = tempDb();
  // The fallback is passed explicitly rather than left to the ambient
  // environment: config.ts loads .env from disk, so relying on absence would make
  // this pass or fail based on the developer's machine — and would print a real
  // key into the assertion output when it failed.
  assert.throws(
    () => requireApiKey(ctx.db, null),
    (error: Error) => {
      assert.match(error.message, /admin settings/i);
      assert.match(error.message, /OPENAI_API_KEY/);
      return true;
    },
  );
});

/**
 * The application secret gates two things — session signing and the settings
 * encryption key — and for a while only one of them refused the placeholder that
 * `.env.example` ships. It is 39 characters, so the length-only check that guarded
 * sessions accepted it, and anyone who copied the example file unchanged signed
 * their sessions with a value published in this repository.
 *
 * Both consumers now go through this one function, so guarding it here covers both.
 * Asserted against the literal string read from `.env.example` rather than a copy,
 * so editing that file without updating the guard fails here instead of silently
 * reopening the hole.
 */
test('the secret shipped in .env.example is refused', () => {
  const example = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const placeholder = /^BETTER_AUTH_SECRET=(.+)$/m.exec(example)?.[1];

  assert.ok(placeholder, '.env.example must declare BETTER_AUTH_SECRET');
  assert.ok(placeholder.length >= 32, 'the placeholder is long enough to pass a length-only check');

  assert.throws(() => requireAppSecret(placeholder), /not set to a real value/);
  assert.throws(() => requireAppSecret(''), /not set to a real value/);
  assert.throws(() => requireAppSecret('too-short'), /at least 32/);

  const real = 'x'.repeat(32);
  assert.equal(requireAppSecret(real), real);
});
