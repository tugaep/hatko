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
npm run build:web
```

`npm install` needs no native toolchain — `sqlite-vec` ships prebuilt binaries and
everything else is JavaScript.

The web app is the only thing that builds. The API and MCP server run their sources
directly.

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
# {"status":"ok","indexedChunks":142}

# Discovery, which is what an MCP client reads first.
curl -s https://hatko.tugrap.dev/.well-known/oauth-protected-resource
# resource must be https://hatko.tugrap.dev/mcp

# Unauthenticated MCP call: expect 401 with a WWW-Authenticate header, NOT a 403.
# A 403 here means MCP_ALLOWED_HOSTS is missing the hostname.
curl -si -X POST https://hatko.tugrap.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -1
```

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

**Backups.** One SQLite file. Copy it with the WAL checkpointed rather than while it is
being written:

```bash
sqlite3 /var/lib/hatko/hatko.db ".backup '/var/backups/hatko-$(date +%F).db'"
```

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
git pull && npm install && npm run build:web
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

- **No rate limiting.** A signed-in account can drive unlimited rerank calls, which is
  real spend. Fine behind an internal sign-in; add a limit before anything wider.
- **No horizontal scaling.** SQLite means one machine. The protocol layers are stateless,
  so the ceiling is the database file, and the migration path is Postgres + pgvector —
  a storage swap rather than a redesign, because retrieval is confined to
  `packages/core/src/retrieval`.
- **No email.** Password resets and invitations do not exist; an administrator sets an
  initial password and passes it on.
- **No metrics or alerting.** The dashboard reports index health, abstain rate and p95
  latency, but nothing pages anyone.
