import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ActiveModels, SecretSource, SecretStatus } from '@hatko/shared';
import { config, describeProvider, requireAppSecret } from './config.ts';
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
  modelBaseUrl: 'models.base_url',
  answerModel: 'models.answer',
  rerankModel: 'models.rerank',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/**
 * Raised when the system is missing or cannot read a credential it needs.
 *
 * A type rather than a message the API pattern-matches. `errors.ts` classified
 * this by testing `/API key/i` against an arbitrary Error's text, which is both
 * fragile — the message and its matcher are edited in different files — and too
 * broad, since any internal failure mentioning an API key would have been
 * reported to the client as its own bad request. The messages are written to be
 * actionable and are safe to forward; the type is what says so.
 */
export class ConfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

/**
 * The status shape and the source enum live in @hatko/shared, because the admin
 * settings panel renders exactly what this module produces. Re-exported so callers of
 * core do not need to know which package the contract is declared in.
 */
export type { ActiveModels, SecretSource, SecretStatus };

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
    hkdfSync('sha256', requireAppSecret(), 'hatko-settings', 'hatko:settings:v1', 32),
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

/**
 * Plain, unencrypted settings — model names and the provider address.
 *
 * Separate from `setSecret` rather than a flag on it, because the difference is not
 * cosmetic: these are read back to the browser verbatim and a secret never is. Writing
 * a key through this function would publish it on the settings endpoint, and the two
 * being different functions is what stops that being a one-character mistake.
 */
export function setSetting(db: Db, key: SettingKey, value: string, updatedBy?: string): void {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Refusing to store an empty setting.');

  db.prepare(
    `INSERT INTO settings (key, value, is_secret, hint, updated_by, updated_at)
     VALUES (?, ?, 0, NULL, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT (key) DO UPDATE SET
       value      = excluded.value,
       is_secret  = 0,
       hint       = NULL,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(key, trimmed, updatedBy ?? null);
}

/**
 * Plaintext value, or null when unset.
 *
 * Refuses to return a row marked secret. Without that check, renaming a key in
 * SETTING_KEYS — or a later feature storing something sensitive under a name this
 * function is asked for — would quietly hand ciphertext to the settings endpoint, and
 * the bug would look like a display glitch rather than a leak.
 */
export function getSetting(db: Db, key: SettingKey): string | null {
  const row = readRow(db, key);
  if (!row || row.is_secret === 1) return null;
  return row.value;
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
    // Decrypting here answers the question actually being asked — is a usable key
    // available — rather than the cheaper one the row alone can answer. Reporting
    // the row's existence showed `configured: true, source: 'database'` for a value
    // that would not decrypt, so after a secret rotation the settings page read
    // healthy while every embedding and answer call failed. `resolveApiKey` was
    // written to fail loudly in exactly this case; the status beside it disagreed.
    try {
      decryptSecret(row.value);
    } catch {
      return {
        configured: false,
        source: 'unreadable',
        // The hint is derived from the plaintext at write time and stored, so it
        // survives and still identifies which key is sitting there unusable.
        hint: row.hint,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    }

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
  // Last, so a key set either way still wins and is still reported as itself: a
  // self-hosted server can be started with one, and this panel should name what is
  // actually being sent. Its own state rather than `unset` because a working
  // installation must not be reported as broken — pointed at a local server with no
  // key, the panel used to show "not configured, embedding and answer generation will
  // fail" beside a system answering questions perfectly well.
  if (!config.isOpenAI) {
    return {
      configured: true,
      source: 'self-hosted',
      hint: config.providerLabel,
      updatedAt: null,
      updatedBy: null,
    };
  }
  return { configured: false, source: 'unset', hint: null, updatedAt: null, updatedBy: null };
}

/**
 * Whether a model provider can be called at all.
 *
 * The question every gate actually wanted to ask. They asked `resolveApiKey() !== null`
 * instead, which was the same question only while OpenAI was the only possible
 * provider: pointed at a local server, that test refuses to run the vector arm of a
 * retriever that would work fine.
 */
export function providerConfigured(db: Db = getDb()): boolean {
  const models = activeModels(db);
  return !models.isOpenAI || resolveApiKey(db) !== null;
}

// --- model selection --------------------------------------------------------

/**
 * Which models are actually in use, database over environment.
 *
 * The same precedence as the API key, for the same reason: an admin choosing a model on
 * the settings page is making a more deliberate and more recent statement than whatever
 * the process booted with. Resolved per call rather than cached, so a change takes
 * effect on the next request instead of the next restart — these are three indexed
 * reads from a local SQLite file, against a network call to a model server.
 *
 * The embedding model is deliberately absent. It is fixed by the width of the vector
 * column, so changing it is a schema rebuild and not a setting; `activeModels` reports
 * it read-only so the panel can explain that rather than offer a control that would
 * corrupt the index. See docs/self-hosted.md.
 */
export function activeModels(db: Db = getDb()): ActiveModels {
  const storedBaseUrl = getSetting(db, SETTING_KEYS.modelBaseUrl);
  const baseUrl = (storedBaseUrl ?? config.modelBaseUrl).replace(/\/+$/, '');
  const { isOpenAI, label } = describeProvider(baseUrl);

  const storedAnswer = getSetting(db, SETTING_KEYS.answerModel);
  const storedRerank = getSetting(db, SETTING_KEYS.rerankModel);

  return {
    baseUrl,
    isOpenAI,
    providerLabel: label,
    answerModel: storedAnswer ?? config.answerModel,
    rerankModel: storedRerank ?? config.rerankModel,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    source: storedBaseUrl || storedAnswer || storedRerank ? 'database' : 'environment',
  };
}

/** Drop every stored model override, returning to what `.env` specifies. */
export function clearModelSettings(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)').run(
    SETTING_KEYS.modelBaseUrl,
    SETTING_KEYS.answerModel,
    SETTING_KEYS.rerankModel,
  );
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
    throw new ConfigurationError(
      `The stored API key could not be decrypted (${(error as Error).message}). ` +
        'This usually means BETTER_AUTH_SECRET changed after the key was saved. ' +
        'Re-enter the key in the admin settings, or restore the previous secret.',
      { cause: error },
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
    throw new ConfigurationError(
      'No OpenAI API key is configured. Either set it in the admin settings page, ' +
        'or set OPENAI_API_KEY in .env (copy .env.example to .env).',
    );
  }
  return key;
}
