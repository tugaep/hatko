# MCP server

Hatko exposes its retriever as an MCP tool, so the same search the chat page runs can
be called by an external MCP client.

- **Endpoint:** `http://localhost:4100/mcp`
- **Transport:** Streamable HTTP
- **Auth:** `Authorization: Bearer <session token>`
- **Tool:** `search_corpus`

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
  auth       Authorization: Bearer <session token> — see README
```

The API must also be running (`npm run start:api`) if you want to mint a token, since
sign-in lives there.

---

## 2. Get a token

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

---

## 3. Connect a client

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

## 4. The tool

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

---

## 5. Why it is built this way

**Streamable HTTP, not stdio.** stdio would have been less code, but a stdio server
is spawned by the client as a local subprocess, and a subprocess cannot be
authenticated — whoever can run it already has the machine. The brief requires access
to be gated by role, so the tool needs a caller identity, and an identity needs
somewhere to travel. Over HTTP it travels in the `Authorization` header.

**Bearer tokens are real sessions, not a shared secret.** A static token in an env
var would have been simpler, but it carries no user, so MCP traffic would be
unattributable and the role check would have nothing to check. Because the token is a
Better Auth session, the MCP server calls the same `requirePermission(headers,
'search:run')` the HTTP API's middleware calls, against the same sessions, with the
same roles, expiry and revocation. Signing out cuts off the MCP client too. The
bearer plugin HMAC-verifies the token before it becomes a session, so an arbitrary
string is rejected rather than trusted.

**No OIDC.** That is the stated bonus and it is deliberately not built. An OIDC
provider is a substantial subsystem, and the honest trade was to spend the time making
one authorization path correct across three surfaces rather than building a second,
weaker one.

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

## 6. Troubleshooting

| Symptom                        | Cause                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `401` / `Sign in to continue.` | Missing, malformed, expired or revoked token. Mint a new one (step 2).                              |
| `403 Invalid Host header`      | The DNS-rebinding guard. Reach the server as `localhost` or `127.0.0.1`.                            |
| `406 Not Acceptable`           | Client did not send `Accept: application/json, text/event-stream`.                                  |
| Every query abstains           | The index is empty. Run `npm run ingest`.                                                           |
| `OPENAI_API_KEY is not set`    | Queries are embedded and reranked at call time. Set the key in `.env`, or from the admin dashboard. |

The server rejects a request with **no** `Host` header at all. Real HTTP/1.1 clients
always send one; this only comes up when synthesising requests in-process.
