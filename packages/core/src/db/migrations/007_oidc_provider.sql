-- OAuth 2.1 / OIDC provider tables, for MCP client authorization.
--
-- Same reasoning as migration 003: Better Auth's plugins declare these tables, and
-- rather than let the library create them at runtime, the shape is committed as an
-- ordinary migration so all schema lives in one reviewable place. Field names come
-- from better-auth/plugins/oidc-provider/schema, and the camelCase identifiers are
-- quoted because the library's queries expect exactly these names.
--
-- Why these exist at all: the MCP server previously accepted only a Better Auth
-- session token as a bearer credential, which works for curl but asks an MCP client
-- to obtain a session out of band. With these, an MCP client runs the standard
-- discovery -> dynamic registration -> authorization-code + PKCE flow and gets its
-- own scoped token, and the human approves it once on a consent screen.
--
-- Access tokens are opaque and validated by lookup here, not as signed JWTs. That is
-- why there is no `jwks` table and no JWT plugin: verification is a database read
-- this process already does for every request, and an opaque token can be revoked by
-- deleting a row, which a self-contained JWT cannot.

CREATE TABLE "oauthApplication" (
  "id"           text    NOT NULL PRIMARY KEY,
  "name"         text    NOT NULL,
  "icon"         text,
  "metadata"     text,
  -- UNIQUE because the two tables below reference it rather than the surrogate id.
  "clientId"     text    NOT NULL UNIQUE,
  -- Null for public clients. MCP clients are public and use PKCE instead of a secret,
  -- which is the correct shape for a client that cannot keep one.
  "clientSecret" text,
  "redirectUrls" text    NOT NULL,
  "type"         text    NOT NULL,
  "disabled"     integer NOT NULL DEFAULT 0,
  -- Who registered the client. Nullable: dynamic registration is unauthenticated by
  -- design in the MCP flow, so the client exists before any user has approved it.
  "userId"       text    REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt"    date    NOT NULL,
  "updatedAt"    date    NOT NULL
);

CREATE TABLE "oauthAccessToken" (
  "id"                     text NOT NULL PRIMARY KEY,
  "accessToken"            text NOT NULL UNIQUE,
  "refreshToken"           text NOT NULL UNIQUE,
  "accessTokenExpiresAt"   date NOT NULL,
  "refreshTokenExpiresAt"  date NOT NULL,
  "clientId"               text NOT NULL REFERENCES "oauthApplication" ("clientId") ON DELETE CASCADE,
  -- Cascade is the revocation path that matters: deleting a user takes their MCP
  -- tokens with them, so a removed account cannot keep querying the corpus through a
  -- client it authorized last week.
  "userId"                 text REFERENCES "user" ("id") ON DELETE CASCADE,
  "scopes"                 text NOT NULL,
  "createdAt"              date NOT NULL,
  "updatedAt"              date NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id"           text    NOT NULL PRIMARY KEY,
  "clientId"     text    NOT NULL REFERENCES "oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId"       text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "scopes"       text    NOT NULL,
  "consentGiven" integer NOT NULL,
  "createdAt"    date    NOT NULL,
  "updatedAt"    date    NOT NULL
);

-- The lookups these tables actually serve: validating a presented token, and deciding
-- whether this user has already approved this client.
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthApplication_userId_idx" ON "oauthApplication" ("userId");
