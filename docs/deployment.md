# Deploying Hatko

Target for this deployment: **`hatko.tugrap.dev`**.

Three Node processes and one reverse proxy. No database server, no container runtime
required, no build pipeline for the backend — Node runs the TypeScript directly.

The corpus is internal, so the whole site sits behind the same sign-in. There is no
public sign-up and no anonymous page except the sign-in screen itself and `/health`.

---

## 1. Topology: one origin

Everything is served from `https://hatko.tugrap.dev`, with a reverse proxy in front:

| Path             | Process      | Port |
| ---------------- | ------------ | ---- |
| `/mcp`           | `@hatko/mcp` | 4100 |
| `/api/*`         | `@hatko/api` | 4000 |
| `/.well-known/*` | `@hatko/api` | 4000 |
| `/health`        | `@hatko/api` | 4000 |
| everything else  | `@hatko/web` | 3000 |

**One origin rather than subdomains, deliberately.** Split across
`app.` and `api.`, the session cookie has to be widened to the parent domain and every
browser request becomes cross-origin — so CORS, `SameSite` and cookie `Domain` all
become things that have to be right, and each is a way to lock yourself out or to leak a
cookie further than intended. On one origin none of those questions exist: the cookie is
host-only, requests are same-origin, and CORS never enters the picture. The API keeps its
`/api` prefix and the MCP server its own port, so nothing has to be renamed to make this
work.

---

## 2. Install and build

Requires **Node 24 or newer** (the code uses `node:sqlite` and runs TypeScript through
type stripping).

```bash
git clone <this repository> hatko && cd hatko
npm install
```

`npm install` needs no native toolchain — `sqlite-vec` ships prebuilt binaries and
everything else is JavaScript.

The web app is the only thing that builds. The API and MCP server run their sources
directly. **The build is deliberately not in this step**, because it cannot be done until
section 3 has set `NEXT_PUBLIC_API_URL`. It is the last step of that section.

---

## 3. Configure

```bash
cp .env.example .env
```

Generate a real secret and set the production values:

```bash
openssl rand -base64 32
```

```ini
NODE_ENV=production
BETTER_AUTH_SECRET=<the value you just generated>

API_URL=https://hatko.tugrap.dev
WEB_URL=https://hatko.tugrap.dev
NEXT_PUBLIC_API_URL=https://hatko.tugrap.dev
MCP_URL=https://hatko.tugrap.dev/mcp
MCP_ALLOWED_HOSTS=hatko.tugrap.dev

DATABASE_PATH=/var/lib/hatko/hatko.db
CORPUS_PATH=/var/lib/hatko/corpus

OPENAI_API_KEY=<key>

SEED_ADMIN_EMAIL=<your admin address>
SEED_ADMIN_PASSWORD=<a password you choose>
SEED_USER_EMAIL=<a user address>
SEED_USER_PASSWORD=<a password you choose>
```

Four of these are load-bearing, and each fails in its own way:

- **`NODE_ENV=production`** makes session cookies `Secure`. The app then stops working
  over plain HTTP, which is the point rather than a fault.
- **`BETTER_AUTH_SECRET`** signs sessions and derives the key that encrypts the stored
  API key. The placeholder from `.env.example` is refused by name, so a copied file
  cannot ship. Changing it later invalidates every session and makes an API key saved
  through the UI undecryptable — the app says so and asks for it again.
- **`MCP_ALLOWED_HOSTS`** must name the public hostname. The MCP server rejects a `Host`
  it does not recognise, and behind a proxy that Host is `hatko.tugrap.dev` — omit this
  and every MCP request is a 403.
- **`NEXT_PUBLIC_API_URL`** is baked into the browser bundle at build time. Change it
  and you must re-run `npm run build:web`.

**Change the seeded passwords.** The defaults are published in this repository's README
as demo credentials.

### Then build the web app, with that configuration loaded

`NEXT_PUBLIC_API_URL` is not read at runtime. Next inlines every `NEXT_PUBLIC_*` value
into the client bundle **at build time**, so a build that cannot see it bakes in the
fallback from `apps/web/lib/api.ts`, which is `http://localhost:4000`. The result is a
site that serves, signs nobody in, and reports "Could not reach the API at
http://localhost:4000" in the browser of every visitor, while `curl https://…/health`
answers perfectly from the server side. That exact failure was shipped to production from
this guide, because the build used to sit in section 2, above the section that writes the
value.

The variable is passed explicitly rather than by sourcing `.env`, which keeps the
secrets in that file out of the build environment:

```bash
NEXT_PUBLIC_API_URL="$(grep '^NEXT_PUBLIC_API_URL=' .env | cut -d= -f2-)" npm run build:web
```

Then check the artifact rather than trusting the command, because this failure is silent:

```bash
grep -rl "localhost:4000" apps/web/.next/static | wc -l   # must be 0
```

---

## 4. Corpus and database

```bash
sudo mkdir -p /var/lib/hatko
sudo chown hatko:hatko /var/lib/hatko
cp -r sample_dataset/corpus /var/lib/hatko/corpus   # or your real corpus
npm run setup
```

`setup` runs migrations, seeds the accounts and ingests the corpus. Pointing it at a
different corpus is the `CORPUS_PATH` change above and nothing else.

Ingestion costs one embedding call per changed document, so the first run bills for the
whole corpus and later runs bill for the difference.

---

## 5. Run the processes

Three services. `systemd` units, with a template for the shared parts:

```ini
# /etc/systemd/system/hatko-api.service
[Unit]
Description=Hatko API
After=network.target

[Service]
Type=simple
User=hatko
WorkingDirectory=/srv/hatko
ExecStart=/usr/bin/npm run start:api
Restart=always
RestartSec=5
# The .env file lives in WorkingDirectory and is read by the process itself.

[Install]
WantedBy=multi-user.target
```

The other two are identical but for `Description` and `ExecStart`:

- `hatko-web.service` → `ExecStart=/usr/bin/npm run start:web`
- `hatko-mcp.service` → `ExecStart=/usr/bin/npm run start:mcp`

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hatko-api hatko-web hatko-mcp
```

### Optional: keep the index current by itself

```ini
# /etc/systemd/system/hatko-ingest.service
ExecStart=/usr/bin/npm run ingest:watch
```

This watches `CORPUS_PATH` and re-indexes when documents change — incrementally, so
unchanged files are not re-embedded. Skip it if the corpus is updated by a deploy, in
which case run `npm run ingest` as a deploy step instead.

Do not run both the watcher and an ingestion triggered from the dashboard at the same
moment: the second one is refused with a 409 rather than corrupting anything, and the
watcher retries after the first finishes.

---

## 6. Reverse proxy and TLS

Caddy, because it obtains and renews the certificate without a second tool:

```caddyfile
hatko.tugrap.dev {
    handle /mcp* {
        reverse_proxy 127.0.0.1:4100
    }
    handle /api/* {
        reverse_proxy 127.0.0.1:4000
    }
    handle /.well-known/* {
        reverse_proxy 127.0.0.1:4000
    }
    handle /health {
        reverse_proxy 127.0.0.1:4000
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

The nginx equivalent needs `proxy_set_header Host $host;` on every block — the MCP
server's rebinding guard reads that header, and nginx's default of `$proxy_host` would
make it see `127.0.0.1:4100` instead of the public name. That would happen to pass, since
loopback is always allowed, but it would also mean the guard was checking nothing.

Bind the three services to loopback only, so the proxy is the sole route in. They already
listen on all interfaces by default, so use a firewall or put them in a network namespace
if the host is exposed.

---

## 7. Verify the deployment

```bash
curl -s https://hatko.tugrap.dev/health
# {"status":"ok","indexedChunks":7539}

# Discovery, which is what an MCP client reads first.
curl -s https://hatko.tugrap.dev/.well-known/oauth-protected-resource
# resource must be https://hatko.tugrap.dev/mcp

# Unauthenticated MCP call: expect 401 with a WWW-Authenticate header, which is what
# starts a client's OAuth flow. Anything else — 403, 404, a Caddy error page — means the
# request is not reaching the MCP process.
curl -si -X POST https://hatko.tugrap.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -1
```

**This probe cannot tell you whether `MCP_ALLOWED_HOSTS` is right, and no unauthenticated
probe can.** The rebinding guard sits behind the bearer check, so a request with no token
is a 401 under every `Host` — including the one you forgot to configure. Read it from the
startup banner instead, which prints the list the process actually loaded:

```bash
journalctl -u hatko-mcp -n 20 | grep hosts
#   hosts      localhost, 127.0.0.1, [::1], localhost:4100, 127.0.0.1:4100, [::1]:4100, hatko.tugrap.dev
```

If the public hostname is absent there, every authenticated client will get a 403 — all
of them, at once, after the deployment looked healthy. Fix `MCP_ALLOWED_HOSTS` and
restart before connecting anything.

Then in a browser: sign in, ask a question on the chat page, confirm the dashboard loads,
and confirm a non-admin account is bounced away from `/dashboard`.

Connect a client to check the OAuth path end to end:

```bash
claude mcp add --transport http hatko https://hatko.tugrap.dev/mcp
```

It should send you to a Hatko consent screen naming the client, and work after you
approve it.

---

## 8. Operating it

**Backups.** One SQLite file, copied through the database rather than off the filesystem,
so a write in flight cannot land half of itself in the copy.

Node does this without a second package, which matters here: this command has to work on
the machine the guide just finished setting up, and that machine has Node and nothing else.
The version below replaced a `sqlite3 … ".backup …"` one-liner that was in this guide
through the first deployment and never ran on it, because the `sqlite3` CLI was not
installed. It failed silently inside an `&&` chain, which is the worst way for a backup
command to be wrong.

```bash
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const out = "/var/backups/hatko-" + new Date().toISOString().slice(0, 10) + ".db";
  const db = new DatabaseSync("/var/lib/hatko/hatko.db", { readOnly: true });
  db.exec("VACUUM INTO \x27" + out + "\x27");
  db.close();
  console.log("backup written: " + out);
'
```

Check the size afterwards. A backup materially smaller than the live database is a failed
one, and `VACUUM INTO` refuses to overwrite, so a same-day rerun errors rather than
truncating yesterday's copy.

It contains accounts, sessions, OAuth clients and tokens, the encrypted API key and the
whole index. Everything except the accounts and the key can be rebuilt from the corpus
with `npm run db:reset && npm run setup`.

**Rotating the OpenAI key.** Do it from the dashboard rather than by editing `.env`: the
stored value takes precedence and no restart is needed. The settings panel names which
source is active.

**Removing someone's access.** Deactivate the account from the dashboard's Users panel.
That ends their existing sessions and their MCP tokens immediately, on both surfaces, and
is reversible. Deleting the account instead would also delete their search history from
the dashboard analytics.

**Logs.** `journalctl -u hatko-api -f`. Provider failures and unexpected errors are
logged with detail server-side; clients only ever receive a generalised message.

**Updating.**

```bash
git pull && npm install
NEXT_PUBLIC_API_URL="$(grep '^NEXT_PUBLIC_API_URL=' .env | cut -d= -f2-)" npm run build:web
grep -rl "localhost:4000" apps/web/.next/static | wc -l   # must be 0
npm run db:migrate
sudo systemctl restart hatko-api hatko-web hatko-mcp
```

Migrations are forward-only and run once each; `db:migrate` on an up-to-date database
does nothing. Restart all three — they share `@hatko/core`, so a schema change affects
every one of them, and a process left running on old code is how a fixed bug appears not
to be fixed.

---

## 9. Taking it down

The brief asks for the deployment to come down after review.

```bash
sudo systemctl disable --now hatko-api hatko-web hatko-mcp hatko-ingest
```

Then remove the DNS record and delete `/var/lib/hatko`, which is the only place corpus
content and credentials live.

---

## 10. What this deployment does not have

Stated rather than implied, because each is a real gap and none is hard to add later.

- **Rate limiting does not survive a second process.** There is a limit now —
  `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_SECONDS` per account across `/search`,
  `/answer` and the MCP tool, 30 a minute by default — but the counter is in memory, so
  running two API processes would grant each account the allowance twice and a restart
  forgets what anyone had spent. One process per service, which is what this guide sets
  up, is the condition under which it means what it says.
- **No horizontal scaling.** SQLite means one machine. The protocol layers are stateless,
  so the ceiling is the database file, and the migration path is Postgres + pgvector —
  a storage swap rather than a redesign, because retrieval is confined to
  `packages/core/src/retrieval`.
- **No email.** Password resets and invitations do not exist; an administrator sets an
  initial password and passes it on.
- **No metrics or alerting.** The dashboard reports index health, abstain rate and p95
  latency, but nothing pages anyone.
