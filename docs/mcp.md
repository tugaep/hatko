# MCP server

Hatko exposes its retriever as an MCP tool, so the same search the chat page runs can
be called by an external MCP client.

- **Endpoint:** `http://localhost:4100/mcp`
- **Transport:** Streamable HTTP
- **Auth:** OAuth 2.1 / OIDC (discovery + dynamic registration + PKCE), or a bearer session token
- **Tool:** `search_corpus`

Two ways in. **OIDC** is the one an MCP client uses on its own: it discovers the
endpoints, registers itself, sends you to a consent screen, and gets its own scoped,
expiring token — scoped to that one client rather than being a copy of your session, and
not individually revocable today (see §7). **A bearer session token** is the one for
`curl`, scripts and CI,
where a browser redirect makes no sense. Both land on the same server-side role check,
so there is one authorization decision rather than two.

---

## 1. Start it

The MCP server is its own process, separate from the HTTP API. It needs the index to
exist, and it needs an OpenAI key to embed and rerank queries.

```bash
npm install && npm run setup
```

`setup` migrates the database, seeds the demo accounts and ingests the sample corpus.
Then:

```bash
npm run start:mcp
```

```
Hatko MCP on http://localhost:4100/mcp
  corpus     142 passages indexed
  auth       OAuth 2.1 / OIDC, or Authorization: Bearer <session token>
  clients    point them at this URL; see docs/mcp.md
```

The API must also be running (`npm run start:api`) if you want to mint a token, since
sign-in lives there.

---

## 2. Connect over OIDC (the normal path)

Nothing to configure and no token to paste. Point the client at the endpoint and it
does the rest:

```bash
claude mcp add --transport http hatko http://localhost:4100/mcp
```

What happens, and why each step is there:

1. The client calls `/mcp` with no credential and gets **401** with
   `WWW-Authenticate: Bearer realm="hatko", resource_metadata="…"`. That header is the
   bootstrap — without it the client has nowhere to look.
2. It fetches `/.well-known/oauth-protected-resource`, learning that the resource is
   `MCP_URL` and the authorization server is the API, then
   `/.well-known/oauth-authorization-server` for the endpoints.
3. It **registers itself** (RFC 7591). No administrator mints credentials. Registration
   grants nothing on its own — it only creates a client record.
4. It opens the authorize URL in your browser. Not signed in, and you get the Hatko
   sign-in page first.
5. **You approve it** on a consent screen naming the application and the host the
   authorization code will be sent to. Denying is a real answer and is reported back to
   the client.
6. The client exchanges the code for a token using PKCE, and calls the tool.

Access tokens last an hour and refresh tokens seven days. Both are opaque and stored
server-side, so revoking one is deleting a row rather than waiting for a JWT to expire.
Deleting a user deletes their tokens with them, which the schema enforces with a cascade.

**The consent screen is not optional.** Dynamic registration is open, as the flow
requires, so anybody can register a client — which means the only thing standing
between a crafted link and a signed-in user handing over a corpus-reading token is
being asked first. `prompt=consent` is forced server-side for every authorization,
including ones that do not request it, so a client cannot skip the question.

---

## 3. Get a bearer token instead (curl, scripts, CI)

The bearer token is a Better Auth session token — the same session the web app uses.
Sign in and read it off the `set-auth-token` response header:

```bash
curl -sD - -o /dev/null -X POST http://localhost:4000/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"user@hatko.local","password":"hatko-user-demo"}' \
  | grep -i '^set-auth-token:'
```

```
set-auth-token: esW5tuRwVTzdffkZ2oItSJxTwEoCTgT6.uZRlsXc7lrheUYt70rvvZobX89cdWgIuSeVU4Tjy460=
```

Either demo account works — `search:run` is held by both roles. Tokens expire after
seven days, and signing out revokes one immediately.

Note that this is the user's own session in a header. It cannot be scoped to one client
and cannot be revoked without ending every other session too, which is exactly why the
OIDC path above exists and is the better choice for a real client.

---

## 4. Pin a bearer token into a client

Only needed if you are deliberately using the bearer path — the OIDC flow needs none of
this.

### Claude Code

```bash
claude mcp add --transport http hatko http://localhost:4100/mcp \
  --header "Authorization: Bearer <token>"
```

### Claude Desktop, Cursor, and other config-file clients

```json
{
  "mcpServers": {
    "hatko": {
      "type": "http",
      "url": "http://localhost:4100/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### Verify without a client

```bash
curl -s -X POST http://localhost:4100/mcp \
  -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 5. The tool

### `search_corpus`

Searches the corpus and returns the passages that best answer a question, with the
source document of each. Hybrid retrieval (vector + BM25, RRF-fused), then an LLM
rerank pass that grades absolute relevance.

| Argument   | Type                | Notes                                                    |
| ---------- | ------------------- | -------------------------------------------------------- |
| `query`    | string, 2–500 chars | Required. Natural-language questions retrieve best.      |
| `limit`    | integer, 1–20       | Optional, defaults to 8. Passages returned after rerank. |
| `category` | string              | Optional. Restricts to one corpus category.              |

Annotated `readOnlyHint: true` and `openWorldHint: false`, so a client can tell the
tool changes nothing before deciding whether to call it unattended.

The argument schema is derived from the same Zod contract the HTTP API validates
against, so the two surfaces cannot disagree about what a valid query is.

**Returns** each passage with its document title, source path, category, section
heading, and both the fused and judged relevance scores. A superseded document is
labelled `DEPRECATED` above its content, with what replaced it.

**When nothing answers the question**, the tool says so and instructs the caller not
to answer from its own knowledge. The near-miss passages are still returned, marked
as context only — an abstention the client cannot inspect is one it has to take on
faith, and a model told only "nothing found" tends to fill the silence itself.

A `category` that does not match any document silently returns nothing useful rather
than erroring, because category is an open string rather than an enum of the sample
corpus's folder names. Note that documents at the corpus root are `uncategorised`,
not a folder name — filtering to `guides` will not find `localization-guide.md`.

**On failure** the tool returns `isError: true` with a message chosen at the boundary,
never the raw exception. The SDK's default is to forward `error.message` verbatim,
which put `SQLITE_ERROR: no such column … /Users/…/hatko.db` into a tool result during
review; the HTTP API has refused to leak that since step 3 and this surface now
matches it. A provider outage is named so the caller retries instead of concluding the
corpus is empty, a configuration error is forwarded because it _is_ the fix, and
anything unrecognised is logged server-side and generalised to the caller.

An abstention is deliberately **not** an error — it is a successful result whose text
says the corpus does not cover the question. A client that saw `isError` there would
report the system being honest as the system being broken.

---

## 6. Why it is built this way

**Streamable HTTP, not stdio.** stdio would have been less code, but a stdio server
is spawned by the client as a local subprocess, and a subprocess cannot be
authenticated — whoever can run it already has the machine. The brief requires access
to be gated by role, so the tool needs a caller identity, and an identity needs
somewhere to travel. Over HTTP it travels in the `Authorization` header.

**Hatko is its own OIDC provider.** Not an external identity provider, because the
brief requires the system to run on a fresh machine from the README and a hosted IdP
would make a network account a prerequisite for `npm install`. Better Auth's `mcp` and
`oidcProvider` plugins supply the endpoints; this repository supplies the schema
(migration 007), the consent screen, and the policy that consent is mandatory.

**Two credentials, one authorization decision.** An OAuth access token identifies a
user but carries no session; a bearer session token carries one. Both resolve through
`requireMcpPermission`, which loads the user, then hands off to the same `authorize`
the HTTP API uses with the same `search:run` permission. The alternative — a role check
per credential — is two checks that drift, and the one that drifts is the one nobody
looks at.

**Consent is forced, not requested.** The mcp plugin asks for consent only when the
client sends `prompt=consent`, which measured out as: register a client, send a
signed-in user one link, receive a token for the whole corpus, with nobody asked
anything. PKCE and `state` do not cover this — they protect the client from
interception, not the user from authorizing a stranger. The API rewrites the query on
every authorization so the question cannot be skipped, and it rewrites rather than
advertising a different endpoint because the consent-free endpoint stays mounted and a
crafted link would simply use it.

**Bearer tokens remain, and their weakness is stated.** A session token in a header is
what makes `curl` and CI usable. But the credential _is_ the user's session, so it
cannot be scoped to one client and cannot be revoked without ending every other
session. That is the reason OIDC is the documented default rather than an alternative.

**One tool, not two.** The HTTP API also exposes `/answer`, which wraps retrieval in
an LLM that writes prose and cites it. An MCP client _is_ an LLM, and it holds the
user's actual question, the conversation around it, and its own instructions. Handing
it passages lets it synthesise with all of that; handing it our pre-written paragraph
throws that context away and asks it to trust a summary it cannot check. Retrieval is
the part the client cannot do for itself, so retrieval is what the tool exposes.

**Stateless.** No session id, so no server-side map to grow, evict, or leak a
transport into when a client disconnects. Every request carries its own token and is
authorized on its own. Responses are complete JSON bodies rather than held-open SSE
streams, because the tool never pushes a notification — and with a plain body,
`handleRequest` resolving is exactly when the per-request transport may be closed.

**Queries are recorded.** Each call is written to `search_queries` with
`source: 'mcp'` and the caller's user id, so the dashboard's search stats cover the
whole system rather than only the browser.

---

## 7. Limits

Where this stops scaling, in the order it would actually bite:

**One machine, because of SQLite.** The protocol layer is stateless, so nothing stops
several MCP processes running behind a load balancer — but they would all need the same
database file. SQLite is a deliberate trade for a system that must install with
`npm install` and no service to run; the migration path is Postgres + pgvector, and it
is a storage swap rather than a redesign because retrieval is confined to
`packages/core/src/retrieval`.

**Latency is two model round trips, not our code.** A call spends roughly 200 ms
embedding the query and 1–2 s in the rerank pass. The per-request `McpServer` and
transport allocation is noise against that — and it is not optional anyway: the SDK
throws `Stateless transport cannot be reused across requests`. Retrieval itself scans
all 142 chunks exhaustively in about 1 ms, which beats an approximate index at this
size; revisit around two orders of magnitude more.

**Rate limiting is per account, in memory, per process.** A token no longer drives
unbounded rerank calls: `search_corpus` draws from the same allowance as the HTTP API's
`/search` and `/answer` — `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_SECONDS`,
keyed by user id, defaulting to 30 a minute. The limit is checked on the tool call rather
than on the `/mcp` request, so `initialize` and `tools/list` stay free; a refusal comes
back as a tool error naming the wait, not as an HTTP 429, because a JSON-RPC client reads
the result rather than the status line. Where it stops: the counter lives in the process,
so two MCP processes would each grant the full allowance and a restart forgets everything.
That is correct for the one-process-per-service topology `docs/deployment.md` describes,
and the fix if it ever changes is a shared store behind the same interface.

**No query cache.** Two identical questions pay for both model calls twice. The
cheapest win available if traffic ever repeats itself.

**An approved client cannot be revoked individually.** There is no "connected
applications" surface, and signing out does not help: the MCP server validates an access
token by looking it up in `oauthAccessToken`, so it never consults sessions. An approved
client keeps working until its token expires — an hour, or up to seven days if it
refreshes. The immediate cut-off is deactivating the account, which both surfaces honour
at once. Tying tokens to the session instead would have been easy and wrong: a credential
that dies with the user's session is exactly the bearer path's weakness, and losing that
independence would remove the reason to prefer OIDC. The right fix is a per-client revoke
list, and it is not built.

**Analytics writes serialise.** `recordSearchQuery` writes one row per call, and SQLite
takes a single writer. It swallows its own failures by design, so contention costs a
metric rather than a search.

---

## 8. Troubleshooting

| Symptom                        | Cause                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Sign in to continue.` | Missing, malformed, expired or revoked credential — an access token over an hour old, or a signed-out session. JSON-RPC code `-32002`. |
| Consent says "not recognised"  | The `client_id` is unregistered or disabled, so there is nothing to approve. Reconnect the client.                                     |
| Client keeps re-authorizing    | `MCP_URL` is not the address the client dials, so the token's audience does not match.                                                 |
| `403 Invalid Host header`      | The DNS-rebinding guard. Locally, reach the server as `localhost` or `127.0.0.1`; behind a proxy, add the public hostname to `MCP_ALLOWED_HOSTS`. |
| `406 Not Acceptable`           | Client did not send `Accept: application/json, text/event-stream`.                                                                     |
| `EADDRINUSE :::4100`           | Another MCP server is already on the port. `lsof -ti :4100` to find it.                                                                |
| Every query abstains           | The index is empty. Run `npm run ingest`.                                                                                              |
| `Too many requests…`           | The per-account allowance is spent. Wait the stated seconds, or raise `RATE_LIMIT_MAX`. Arrives as a tool error, not a 429 — see §7.    |
| `OPENAI_API_KEY is not set`    | Queries are embedded and reranked at call time. Set the key in `.env`, or from the admin dashboard.                                    |

The server rejects a request with **no** `Host` header at all. Real HTTP/1.1 clients
always send one; this only comes up when synthesising requests in-process.
