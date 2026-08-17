-- Deactivating an account.
--
-- A column rather than deleting the row, because deletion is not the operation an
-- administrator wants for someone who has left: the foreign keys in 003 and 007
-- cascade, so deleting a user destroys their OAuth tokens *and* takes their search
-- history out of the analytics the dashboard reports. Disabling revokes access while
-- keeping the record of what was asked.
--
-- Enforced in `getSessionUser`, which is the one place both surfaces resolve an
-- identity, so a disabled account loses the web app and the MCP server at once —
-- including sessions and access tokens issued before it was disabled. A flag that only
-- blocks new sign-ins is not a revocation.
--
-- integer, because SQLite has no boolean and the rest of the Better Auth tables in
-- this schema already spell booleans this way (see "emailVerified" in 003).
ALTER TABLE "user" ADD COLUMN "disabled" integer NOT NULL DEFAULT 0;

-- The admin list sorts by creation date and filters on name and email; none of that
-- needs an index at the scale of an internal tool's user table, and one would be
-- maintained on every write to earn nothing. Deliberately none added.
