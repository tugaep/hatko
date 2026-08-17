-- Runtime settings, editable by an admin from the web UI.
--
-- The only setting so far is the OpenAI API key. It exists because an operator
-- should be able to stand the system up without shell access to edit a .env and
-- restart a process.
--
-- Secret values are stored encrypted (AES-256-GCM, key derived from
-- BETTER_AUTH_SECRET). Be precise about what that buys: it protects the key if
-- the database file leaks on its own — a backup, a copied volume, an accidental
-- commit — because the file alone is not enough to decrypt. It does not protect
-- against compromise of the host, where the deriving secret is also present.
-- Storing the key in plaintext here would mean any read of the .db file yields a
-- live credential, which is the case actually worth defending against.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  -- Ciphertext (base64, iv+tag+payload) when is_secret = 1, plaintext otherwise.
  value      TEXT    NOT NULL,
  is_secret  INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
  -- Last few characters of the plaintext, kept so the UI can confirm *which* key
  -- is configured without ever decrypting or transmitting the secret itself.
  hint       TEXT,
  -- Better Auth user id of whoever last wrote this. Null when set by a CLI or seed.
  updated_by TEXT,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
