import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  activeModels,
  clearModelSettings,
  getSetting,
  providerConfigured,
  requireApiKey,
  resolveApiKey,
  setSecret,
  setSetting,
} = await import('./settings.ts');

const REAL_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789a91f';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatko-settings-'));
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

  // This test's name promised a state the code could not express. `getApiKeyStatus`
  // never attempted decryption, so it reported `configured: true, source:
  // 'database'` for a key that would not decrypt — the settings page reading
  // healthy while every provider call failed on the key it was showing.
  const status = getApiKeyStatus(ctx.db);
  assert.equal(status.source, 'unreadable', 'a stored-but-undecryptable key is its own state');
  assert.equal(status.configured, false, 'a key that cannot be decrypted is not configured');
  assert.equal(status.hint, '…a91f', 'the hint still identifies which key is stuck there');
  assert.ok(status.updatedAt, 'and when it was set, so the rotation can be dated');
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

/**
 * The documented first command of a fresh install has to work.
 *
 * `.env.example` ships `OPENAI_API_KEY=` and a comment inviting you to leave it blank and
 * set the key from the admin UI. `process.loadEnvFile` reads that as `''`, and
 * `z.string().min(1).optional()` rejects `''` because `.optional()` admits only
 * `undefined` — so `cp .env.example .env` made config.ts throw at import and killed
 * migrate, seed, ingest, eval, the API and the MCP server. `npm run setup` failed on its
 * first command, on the one configuration every new reader starts in.
 *
 * Asserted in a child process against the example file itself, rather than against a
 * hand-written copy of what it contains. The bug was a disagreement between that file and
 * the schema, so a test that restates the file cannot see it: adding a new blank variable
 * to `.env.example` has to fail here.
 *
 * The secret is overridden because the example's placeholder is deliberately refused by
 * the test above; everything else comes from the file verbatim.
 */
test('cp .env.example .env leaves every process able to start', () => {
  const examplePath = new URL('../../../.env.example', import.meta.url);
  const example = fs.readFileSync(examplePath, 'utf8');

  assert.match(example, /^OPENAI_API_KEY=\s*$/m, 'the example still ships a blank API key');

  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const line of example.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  env.BETTER_AUTH_SECRET = 'x'.repeat(32);

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./packages/core/src/config.ts');"],
    { cwd: fileURLToPath(new URL('../../..', import.meta.url)), env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `config.ts refused to load:\n${result.stderr}`);
});

// --- model selection --------------------------------------------------------

/**
 * The provider is now a setting rather than a constant, which introduces two ways to be
 * quietly wrong: a stored choice that never takes effect, and a stored *secret* leaking
 * out through the plaintext reader that model settings use.
 */

test('a stored model choice overrides the environment, and clearing it restores it', () => {
  using ctx = tempDb();

  const fromEnv = activeModels(ctx.db);
  assert.equal(fromEnv.source, 'environment');

  setSetting(ctx.db, SETTING_KEYS.modelBaseUrl, 'http://localhost:11434/v1', 'user-1');
  setSetting(ctx.db, SETTING_KEYS.answerModel, 'qwen2.5:7b', 'user-1');
  setSetting(ctx.db, SETTING_KEYS.rerankModel, 'qwen2.5:7b', 'user-1');

  const stored = activeModels(ctx.db);
  assert.equal(stored.source, 'database');
  assert.equal(stored.answerModel, 'qwen2.5:7b');
  assert.equal(stored.isOpenAI, false, 'a local address is not OpenAI');
  assert.equal(stored.providerLabel, 'localhost:11434', 'errors name the local server, not OpenAI');

  clearModelSettings(ctx.db);
  assert.deepEqual(activeModels(ctx.db), fromEnv, 'reset returns exactly to the environment');
});

test('a trailing slash on the base URL does not create a second distinct provider', () => {
  using ctx = tempDb();
  setSetting(ctx.db, SETTING_KEYS.modelBaseUrl, 'https://api.openai.com/v1/', 'user-1');

  // Without normalisation this reads as a self-hosted provider, and the API key stops
  // being required — turning a stray keystroke into unauthenticated requests to OpenAI.
  assert.equal(activeModels(ctx.db).isOpenAI, true);
});

test('a self-hosted provider needs no API key, while OpenAI still does', () => {
  using ctx = tempDb();
  assert.equal(providerConfigured(ctx.db), Boolean(resolveApiKey(ctx.db)));

  setSetting(ctx.db, SETTING_KEYS.modelBaseUrl, 'http://localhost:11434/v1');
  assert.equal(providerConfigured(ctx.db), true, 'a local server is usable with no key at all');
});

test('the plaintext reader refuses to return an encrypted secret', () => {
  using ctx = tempDb();
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY, 'user-1');

  // getSetting feeds the admin settings endpoint, which is read back into a browser.
  // If it ever answered for a secret row it would publish ciphertext — and the bug
  // would look like a rendering glitch rather than a leak.
  assert.equal(getSetting(ctx.db, SETTING_KEYS.openaiApiKey), null);
});

test('a provider chosen from the dashboard is reported as self-hosted, not as a missing key', () => {
  using ctx = tempDb();

  // The situation an operator running entirely locally is in: no OPENAI_API_KEY anywhere.
  assert.equal(getApiKeyStatus(ctx.db, null).source, 'unset');

  setSetting(ctx.db, SETTING_KEYS.modelBaseUrl, 'http://localhost:11434/v1', 'user-1');

  // This read `config.isOpenAI` — the *environment's* provider — so switching to a local
  // server from the dashboard left it true, and a working keyless installation reported
  // "not configured", warning that every answer would fail while it answered fine.
  const status = getApiKeyStatus(ctx.db, null);
  assert.equal(status.source, 'self-hosted');
  assert.equal(status.configured, true, 'a keyless local install is not a broken one');
  assert.equal(status.hint, 'localhost:11434', 'and it names which server is in use');
});

test('a real key still wins over the self-hosted state, because it is still being sent', () => {
  using ctx = tempDb();
  setSetting(ctx.db, SETTING_KEYS.modelBaseUrl, 'http://localhost:11434/v1');
  setSecret(ctx.db, SETTING_KEYS.openaiApiKey, REAL_KEY, 'user-1');

  // vLLM and friends can be started with --api-key, so a stored key against a local
  // server is a real configuration and the panel must name it rather than the address.
  assert.equal(getApiKeyStatus(ctx.db, null).source, 'database');
});
