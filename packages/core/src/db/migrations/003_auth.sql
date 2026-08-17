-- Better Auth schema.
--
-- Generated with Better Auth's own migration compiler and committed as an
-- ordinary migration, rather than letting the library migrate at startup. Two
-- reasons: all schema then lives in one system that can be read and reviewed in
-- one place, and the shape of the auth tables becomes part of the diff instead of
-- appearing at runtime on a reviewer's machine.
--
-- Column names are camelCase and quoted because Better Auth's queries expect
-- exactly these identifiers. The rest of this schema is snake_case; the
-- inconsistency is the library's, and renaming would mean maintaining a mapping
-- for no benefit.
--
-- `role` is an additional field declared in packages/core/src/auth/index.ts. It is
-- NOT accepted from client input — see the `input: false` there — so a user cannot
-- assign themselves a role at sign-up. Authorization is decided server-side from
-- the session, never from anything the browser sends.

CREATE TABLE "user" (
  "id"            text    NOT NULL PRIMARY KEY,
  "name"          text    NOT NULL,
  "email"         text    NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL,
  "image"         text,
  "createdAt"     date    NOT NULL,
  "updatedAt"     date    NOT NULL,
  "role"          text    NOT NULL DEFAULT 'user' CHECK ("role" IN ('user', 'admin'))
);

CREATE TABLE "session" (
  "id"        text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL,
  "token"     text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id"                    text NOT NULL PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  date,
  "refreshTokenExpiresAt" date,
  "scope"                 text,
  -- Hashed by Better Auth (scrypt). Never a plaintext password.
  "password"              text,
  "createdAt"             date NOT NULL,
  "updatedAt"             date NOT NULL
);

CREATE TABLE "verification" (
  "id"         text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  date NOT NULL,
  "createdAt"  date NOT NULL,
  "updatedAt"  date NOT NULL
);

CREATE INDEX "session_userId_idx"          ON "session" ("userId");
CREATE INDEX "account_userId_idx"          ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- search_queries.user_id was left without a foreign key in migration 001 because
-- the user table did not exist yet. SQLite cannot add a constraint to an existing
-- table, and rebuilding it to gain one is not worth it here: analytics rows are
-- deliberately retained when a user is deleted, so the reference is intentionally
-- loose. Recorded so the omission reads as a decision rather than an oversight.
CREATE INDEX IF NOT EXISTS search_queries_user_idx2 ON search_queries (user_id);
