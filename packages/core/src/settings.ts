import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config, requireAppSecret } from './config.ts';
import { getDb, type Db } from './db/client.ts';

/**
 * Runtime settings with encrypted secrets.
 *
 * The OpenAI key can be supplied two ways: the OPENAI_API_KEY environment
 * variable, or an admin entering it in the web UI. Both are supported on purpose —
 * the environment variable is what the ingestion CLI uses before any user
 * account exists, and the brief requires keys to be suppliable that way, while
 * the UI is what lets an operator rotate a key without shell access.
 *
 * When both are present the database wins: someone typing a key into the admin
 * screen is making a more deliberate and more recent statement than whatever the
 * process happened to boot with.
 */

export const SETTING_KEYS = {
  openaiApiKey: 'openai.api_key',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Where a resolved secret came from, so the UI can say which one is live. */
export type SecretSource = 'database' | 'environment' | 'unset';

export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  /** Last four characters, e.g. `…a91f`. Never the key itself. */
  hint: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

// --- encryption -------------------------------------------------------------

/**
 * Derive the settings encryption key from the application secret.
 *
 * HKDF with a distinct `info` string gives domain separation, so the key used to
 * encrypt settings is independent of the one Better Auth uses to sign sessions
 * even though both descend from BETTER_AUTH_SECRET. One secret to configure,
 * two keys that cannot be substituted for one another.
 *
 * What counts as a usable secret is decided by `requireAppSecret` in config.ts, so
 * this and Better Auth apply the same rule.
 */
function encryptionKey(): Buffer {
  // A constant salt is acceptable here: HKDF's salt guards against a low-entropy
  // input, and the root secret is already 32+ random bytes.
  return Buffer.from(
    hkdfSync('sha256', requireAppSecret(), 'sorrel-settings', 'sorrel:settings:v1', 32),
  );
}

/** AES-256-GCM. Output is base64 of iv(12) ‖ authTag(16) ‖ ciphertext. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < 29) throw new Error('Stored secret is malformed (too short).');

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  // GCM authentication means a tampered or wrongly-keyed value throws here rather
  // than silently decrypting to garbage that would later look like a bad API key.
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// --- storage ----------------------------------------------------------------

interface SettingRow {
  value: string;
  is_secret: number;
  hint: string | null;
  updated_by: string | null;
  updated_at: string;
}

function readRow(db: Db, key: SettingKey): SettingRow | undefined {
  return db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
}

/** Last four characters, so an operator can tell which key is installed. */
const hintOf = (secret: string) => (secret.length <= 4 ? '••••' : `…${secret.slice(-4)}`);

export function setSecret(db: Db, key: SettingKey, plaintext: string, updatedBy?: string): void {
  const trimmed = plaintext.trim();
  if (!trimmed) throw new Error('Refusing to store an empty secret.');

  db.prepare(
    `INSERT INTO settings (key, value, is_secret, hint, updated_by, updated_at)
     VALUES (?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT (key) DO UPDATE SET
       value      = excluded.value,
       is_secret  = 1,
       hint       = excluded.hint,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(key, encryptSecret(trimmed), hintOf(trimmed), updatedBy ?? null);
}

/** Remove the stored override, falling back to the environment variable. */
export function clearSecret(db: Db, key: SettingKey): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Decrypted value from the database, or null when unset. */
export function getSecret(db: Db, key: SettingKey): string | null {
  const row = readRow(db, key);
  if (!row) return null;
  return decryptSecret(row.value);
}

// --- API key resolution -----------------------------------------------------

/**
 * Status for the admin UI. Deliberately returns no way to recover the secret:
 * a key can be replaced or cleared, never read back. There is no legitimate
 * reason for a browser to receive it, and an endpoint that returns it is one
 * XSS or one over-broad role check away from leaking a live credential.
 */
export function getApiKeyStatus(db: Db = getDb()): SecretStatus {
  const row = readRow(db, SETTING_KEYS.openaiApiKey);
  if (row) {
    return {
      configured: true,
      source: 'database',
      hint: row.hint,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }
  if (config.openaiApiKey) {
    return {
      configured: true,
      source: 'environment',
      hint: hintOf(config.openaiApiKey),
      updatedAt: null,
      updatedBy: null,
    };
  }
  return { configured: false, source: 'unset', hint: null, updatedAt: null, updatedBy: null };
}

/**
 * Resolved key, database first, then environment. Null when neither is set.
 *
 * The environment fallback is a parameter rather than read straight from config
 * so it can be controlled in tests. config.ts snapshots process.env at import and
 * loads .env from disk, so a test asserting "no key configured" would otherwise
 * pass or fail depending on whether the developer running it happens to have a
 * real key on the machine — and would print that key into the failure output.
 */
export function resolveApiKey(
  db: Db = getDb(),
  envFallback: string | null = config.openaiApiKey ?? null,
): string | null {
  try {
    const stored = getSecret(db, SETTING_KEYS.openaiApiKey);
    if (stored) return stored;
  } catch (error) {
    // A stored key that will not decrypt means BETTER_AUTH_SECRET changed. Falling
    // through to the environment silently would be worse than saying so: the
    // operator would see "key not configured" while the admin screen shows one set.
    throw new Error(
      `The stored API key could not be decrypted (${(error as Error).message}). ` +
        'This usually means BETTER_AUTH_SECRET changed after the key was saved. ' +
        'Re-enter the key in the admin settings, or restore the previous secret.',
    );
  }
  return envFallback;
}

/** Resolved key or an actionable error. Call sites are all provider requests. */
export function requireApiKey(
  db: Db = getDb(),
  envFallback: string | null = config.openaiApiKey ?? null,
): string {
  const key = resolveApiKey(db, envFallback);
  if (!key) {
    throw new Error(
      'No OpenAI API key is configured. Either set it in the admin settings page, ' +
        'or set OPENAI_API_KEY in .env (copy .env.example to .env).',
    );
  }
  return key;
}
