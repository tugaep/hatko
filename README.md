# hatko

Semantic search and grounded answers over an internal document corpus. Ask a question in plain
language; hatko retrieves the passages that answer it and writes an answer citing them by number.
When the corpus does not cover the question, it says so and cites nothing. That abstention is a
designed outcome, not an error path.

Three surfaces sit on one retrieval pipeline: a chat page for people, an admin dashboard for
operating the system, and an MCP tool so the same retriever can be called by an external client or
agent. All three are behind sign-in, and every access decision is made on the server from the
session's role.

**Live demo:** <https://hatko.tugrap.dev>. Sign in with the [demo credentials](#demo-credentials).

```bash
curl -s https://hatko.tugrap.dev/health
# {"status":"ok","indexedChunks":142}
```

### Main features

- Ingestion is repeatable and observable. A content-hash diff means unchanged files are never
  re-embedded, every run leaves a record with counts and an outcome, and every document carries a
  status.
- Retrieval is hybrid: dense vectors and BM25, fused with RRF, then an LLM rerank pass that grades
  absolute relevance. That grade is what makes honest abstention possible.
- Answers cite their sources, and the citations are verified. Markers get checked against the
  passages actually supplied, and an answer that cites nothing is withheld.
- The chat page streams the answer, lists the passages it cited underneath it, and then
  prints those passages in full so any claim can be checked against its source.
- The dashboard covers index health, search analytics, documents, ingestion runs, model
  configuration, MCP status, user management, and a 3D view of the embedding space.
- An MCP server exposes `search_corpus`, authenticated by OIDC or a bearer session token.
- Auth has two roles, `user` and `admin`, and the check is route middleware on the server.
- Measured: recall@1 100%, MRR 1.000, 12 of 12 answer checks on the sample set. 286 tests.

---

## Technology stack

| Layer      | Technology                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Language   | TypeScript throughout, run directly by Node's type stripping, so there is no build step                                   |
| Runtime    | Node 24+ (`node:sqlite`, `node:test`, `node:crypto`, `process.loadEnvFile`)                                               |
| Storage    | SQLite via `node:sqlite`, with **sqlite-vec** for vectors and **FTS5** for BM25                                           |
| Retrieval  | Hybrid vector and keyword search, RRF fusion, LLM rerank                                                                  |
| Models     | OpenAI `text-embedding-3-small` and `gpt-4o-mini`, or any OpenAI-shaped local server (Ollama, vLLM, LM Studio, llama.cpp) |
| API        | **Hono** 4 on `@hono/node-server`                                                                                         |
| Web        | **Next 16** (App Router), **React 19**, **Tailwind CSS 4**                                                                |
| MCP        | `@modelcontextprotocol/sdk`, Streamable HTTP transport                                                                    |
| Auth       | **Better Auth** 1.6 with its `mcp` and `oidcProvider` plugins; Kysely as its query builder                                |
| Validation | **Zod 4**, one schema per shape, with types inferred from it and shared across the boundary                               |
| Tests      | `node --test` (286 tests), Prettier for formatting                                                                        |

There is no ORM, no vector-database service, no container runtime and no native toolchain, so
`npm install` is the whole setup.

### Repository layout

npm workspaces, five of them. Types cross the frontend and backend boundary through
`@hatko/shared` and nowhere else.

```
packages/shared    Zod schemas and inferred types: the contract every workspace imports
packages/core      ingest · retrieval · answer · db · auth · eval · providers · rate-limit
apps/api           Hono HTTP API: search, answers, admin, auth, OAuth discovery
apps/web           Next 16: sign-in, chat, dashboard, OAuth consent screen
apps/mcp           MCP server, its own process and port
sample_dataset/    the provided corpus (142 markdown files) and sample questions
docs/              mcp.md · deployment.md · self-hosted.md · design.md · brand.md
```

---

## Installation instructions

Prerequisite: Node 24 or newer (`node --version`). You will not need a database server, Docker, or
any build toolchain.

**1. Clone and install.**

```bash
git clone <this repository> hatko && cd hatko
npm install
```

**2. Create `.env` from the example.**

```bash
cp .env.example .env
```

[`.env.example`](.env.example) documents every variable inline. Two of them need attention and
everything else has a working default.

| Variable             | What to do                                                                        |
| -------------------- | --------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Required, minimum 32 characters. The servers refuse to start without it.          |
| `OPENAI_API_KEY`     | Needed to embed and answer. You can leave it blank and enter it in the dashboard. |

```bash
openssl rand -base64 32
```

The values you are most likely to touch:

```ini
OPENAI_API_KEY=sk-…                        # or set it later in the dashboard
OPENAI_BASE_URL=https://api.openai.com/v1  # point at http://localhost:11434/v1 for Ollama
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536                  # compiled into the vector column width
ANSWER_MODEL=gpt-4o-mini
RERANK_MODEL=gpt-4o-mini
DATABASE_PATH=./data/hatko.db
CORPUS_PATH=./sample_dataset/corpus        # point this at the real corpus to switch
API_PORT=4000
MCP_PORT=4100
NEXT_PUBLIC_API_URL=http://localhost:4000
BETTER_AUTH_SECRET=…                       # openssl rand -base64 32
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW_SECONDS=60
SEED_ADMIN_EMAIL=efe@tugrap.dev
SEED_ADMIN_PASSWORD=PlayableFactory7766
SEED_USER_EMAIL=user@tugrap.dev
SEED_USER_PASSWORD=PlayableFactory6677
```

**3. Migrate the database, seed the accounts, index the corpus.**

```bash
npm run setup
```

That is `db:migrate`, then `seed`, then `ingest`, and it prints what it did:

```
migrated  001_init … 009_forbid_chunk_content_update
created   efe@tugrap.dev         admin
created   user@tugrap.dev        user
indexed   142 documents · 142 passages · 0 failed · 3.1s
```

### Seeding, separately

```bash
npm run seed      # create or reset the two demo accounts from the SEED_* values in .env
npm run db:migrate
npm run db:reset  # drop and recreate, which you need if you change EMBEDDING_DIMENSIONS
```

`seed` is idempotent. Re-running it resets an existing account's password and role instead of
failing, so you can just repeat a half-finished setup. Passwords are hashed by Better Auth through
the same path the admin "add user" form uses.

Ingestion is the only step that needs a model provider. If you left `OPENAI_API_KEY` blank it stops
there with an actionable message, and everything before it still happened. Finish from the
dashboard instead, as described under [First run](#first-run).

Pointing ingestion at a different corpus is one variable: set `CORPUS_PATH` and run
`npm run ingest`. Categories come from the corpus's own top-level folder names and are stored as an
open string, never as an enum of the sample data's folders.

---

## Running the application

Three processes, three terminals:

```bash
npm run dev:api     # http://localhost:4000, the backend API
```

```bash
npm run dev:web     # http://localhost:3000, the frontend
```

```bash
npm run dev:mcp     # http://localhost:4100/mcp, the MCP server (optional)
```

Open <http://localhost:3000>. You only need the MCP server if you are connecting a client.

Production equivalents: `npm run start:api`, `npm run build:web && npm run start:web`, and
`npm run start:mcp`.

These also work from a terminal, with no web app running:

```bash
npm run ask -- "Why are sound assets built in a separate pass?" --sources
npm run ingest -- --force        # re-embed everything, ignoring content hashes
npm run ingest:watch             # stay running and re-index when the corpus changes
npm run eval -- --rerank --answers
npm run typecheck && npm test
```

### First run

Sign in as the admin first. Nothing is configured on a fresh instance, and every route that could
configure it requires `admin`. The dashboard then shows a setup checklist with three prerequisites
in dependency order (provider credential, model reachable, corpus indexed), each linking to the
panel that completes it. The checklist disappears once all three are met, and the chat page works.

The API key can live in `.env` or be entered in the dashboard, where it is stored encrypted with a
key derived from `BETTER_AUTH_SECRET`. The database value wins when both are set, the panel names
the active source, and no route ever returns the value.

---

## Demo credentials

`npm run setup` creates both accounts from the `SEED_*` values in `.env`. They work locally and on
the live demo.

| Role  | Email             | Password              | Can reach                      |
| ----- | ----------------- | --------------------- | ------------------------------ |
| Admin | `efe@tugrap.dev`  | `PlayableFactory7766` | Chat, and the whole admin area |
| User  | `user@tugrap.dev` | `PlayableFactory6677` | Chat only                      |

Sign in as the regular user to see the authorization working. The dashboard link is absent from the
nav, requesting `/dashboard` directly redirects to chat with the reason stated on the page, and the
API answers the same request with `403`. Only that last one is a control. Hiding a link is a
courtesy.

There is no public sign-up: `POST /api/auth/sign-up/*` is refused with `403`. An admin creates
accounts from the dashboard.

---

## API documentation

Base URL is `http://localhost:4000` locally and `https://hatko.tugrap.dev` deployed. Everything is
JSON. Authentication is the session cookie in a browser, or `Authorization: Bearer <session token>`
for scripts.

### Public

| Method | Endpoint                                  | Description                                                          |
| ------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/health`                                 | Unauthenticated. `{"status":"ok","indexedChunks":142}`               |
| `GET`  | `/api/session`                            | Current user, or `{"user":null}`, which is not a 401 when signed out |
| `POST` | `/api/auth/sign-in/email`                 | Sign in. Sets the session cookie and returns a token                 |
| `POST` | `/api/auth/sign-out`                      | Sign out                                                             |
| `POST` | `/api/auth/sign-up/*`                     | Always `403`, because sign-up is closed                              |
| `GET`  | `/.well-known/oauth-protected-resource`   | OAuth discovery (RFC 9728), which MCP clients read first             |
| `GET`  | `/.well-known/oauth-authorization-server` | OAuth discovery (RFC 8414)                                           |

### Search and answers, for any signed-in role, rate limited

| Method | Endpoint      | Permission        | Description                                                                          |
| ------ | ------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `POST` | `/api/search` | `search:run`      | Retrieve passages. `query` 2 to 500 characters, `limit` 1 to 20, optional `category` |
| `POST` | `/api/answer` | `answer:generate` | Grounded answer with citations. Streams when you send `Accept: text/event-stream`    |

Sign in and keep the cookie:

```bash
curl -s -c jar.txt -X POST http://localhost:4000/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"efe@tugrap.dev","password":"PlayableFactory7766"}'
```

Search:

```bash
curl -s -b jar.txt -X POST http://localhost:4000/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"Why are sound assets built in a separate pass?","limit":3}'
```

```json
{
  "query": "Why are sound assets built in a separate pass?",
  "results": [
    {
      "chunkId": 144,
      "documentId": 2,
      "documentTitle": "Build Pipeline",
      "sourcePath": "build-pipeline.md",
      "category": "uncategorised",
      "heading": null,
      "content": "# Build Pipeline\n\nLumen builds run through the internal CLI…",
      "ordinal": 0,
      "score": 0.1678,
      "vectorScore": 0.703,
      "keywordScore": 1.0,
      "rerankScore": 1.0,
      "isDeprecated": false,
      "supersededBy": null
    }
  ],
  "latencyMs": 2934
}
```

Those numbers come from a real run, and they show the pipeline's own argument.
`guides/asset-naming.md` had the highest fused score for this question, 0.1742, and was graded
0.33. `build-pipeline.md` scored 0.1678 and was graded 1.00. That is why candidates are graded
before the caller's `limit` is applied rather than after.

`score` is the fused rank score and the primary ordering. `vectorScore` is null when a passage was
found by keyword alone and `keywordScore` is null in the converse case. `rerankScore` is the judged
relevance. All three are part of the contract on purpose, because the product promise is to show
its work.

Answer:

```bash
curl -s -b jar.txt -X POST http://localhost:4000/api/answer \
  -H 'content-type: application/json' \
  -d '{"query":"How do I initialize the current Lumen SDK, and what happened to lumen.track?"}'
```

```json
{
  "query": "How do I initialize the current Lumen SDK, and what happened to lumen.track?",
  "answer": "To initialize the current Lumen SDK, call LumenSDK.init(config) before any game code runs, and it returns a promise that resolves when the network wrapper is ready [1]. The old lumen.track calls from v2 are not recognized and fail silently, as they have been removed in favor of the new event system [1], [2].",
  "citations": [
    {
      "index": 1,
      "chunkId": 283,
      "documentId": 141,
      "documentTitle": "Lumen SDK v3 (current)",
      "sourcePath": "sdk-notes-v3.md",
      "isDeprecated": false
    },
    {
      "index": 2,
      "chunkId": 268,
      "documentId": 126,
      "documentTitle": "Production Sync, 2026-03-23",
      "sourcePath": "meeting-notes/2026-03-23-production-sync.md",
      "isDeprecated": false
    }
  ],
  "deprecationNotices": [
    {
      "documentTitle": "Lumen SDK v2 (DEPRECATED)",
      "sourcePath": "sdk-notes-v2.md",
      "supersededBy": "Lumen SDK v3"
    }
  ],
  "abstained": false,
  "sources": ["… the six graded passages …"],
  "latencyMs": 2858
}
```

That is verbatim output for sample question 2, and it is the case the rerank pass exists for. BM25
ranked the deprecated `sdk-notes-v2.md` top of the keyword arm at a normalised 1.000, the grader
scored it 0.00, and the deprecation notice comes from ingest-time metadata rather than from the
model volunteering it.

An abstention is a 200 carrying `abstained: true`, an empty `answer`, no citations, and the nearest
passages so the reader can judge the miss:

```json
{
  "query": "What is the company vacation policy?",
  "answer": "",
  "abstained": true,
  "citations": [],
  "deprecationNotices": [],
  "sources": ["… the three nearest passages, all graded 0.00 …"],
  "latencyMs": 1435
}
```

Streamed, same endpoint:

```bash
curl -N -b jar.txt -X POST http://localhost:4000/api/answer \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"query":"How do I initialize the current Lumen SDK, and what happened to lumen.track?"}'
```

```
data: {"type":"passages","sources":[…]}
data: {"type":"delta","text":"To initialize"}
data: {"type":"delta","text":" the current Lumen SDK,"}
data: {"type":"answer","response":{…}}
```

One `passages` event, then any number of `delta` events, then exactly one terminal `answer` or
`error`. The terminal `answer` is the authoritative one. Delta text has not been through citation
validation, so a client has to label it as in progress and replace it wholesale.

### Admin routes, which answer 403 for a regular user

| Method         | Endpoint                      | Permission          | Description                                                        |
| -------------- | ----------------------------- | ------------------- | ------------------------------------------------------------------ |
| `GET`          | `/api/admin/stats`            | `dashboard:view`    | Index health, category breakdown, search analytics                 |
| `GET`          | `/api/admin/documents`        | `documents:manage`  | Paged and sortable, filtered by `status`, `category` or `q`        |
| `GET`          | `/api/admin/documents/:id`    | `documents:manage`  | One document with its indexed passages                             |
| `GET`          | `/api/admin/ingestion/runs`   | `documents:manage`  | Last 20 runs with counts, duration and outcome                     |
| `POST`         | `/api/admin/ingestion/run`    | `ingestion:trigger` | Trigger ingestion. `{"force":true}` re-embeds everything           |
| `GET`          | `/api/admin/embedding-map`    | `documents:manage`  | The corpus projected to 3D by PCA                                  |
| `GET`          | `/api/admin/settings/api-key` | `documents:manage`  | Status and active source only, never the value                     |
| `PUT`/`DELETE` | `/api/admin/settings/api-key` | `documents:manage`  | Store encrypted, or clear it and fall back to `.env`               |
| `GET`          | `/api/admin/settings/models`  | `documents:manage`  | Active models plus what the provider advertises                    |
| `PUT`/`DELETE` | `/api/admin/settings/models`  | `documents:manage`  | Set or clear base URL, answer model and rerank model               |
| `GET`          | `/api/admin/mcp`              | `documents:manage`  | MCP endpoint, discovery URLs, enforced host allowlist, live status |
| `GET`          | `/api/admin/users`            | `users:manage`      | List accounts, paged and searchable                                |
| `POST`         | `/api/admin/users`            | `users:manage`      | Add an account. `409` if the email already exists                  |
| `PUT`          | `/api/admin/users/:id`        | `users:manage`      | Change role, deactivate, restore                                   |

```bash
curl -s -b jar.txt -X POST http://localhost:4000/api/admin/ingestion/run \
  -H 'content-type: application/json' -d '{"force":false}'
```

```json
{
  "run": {
    "id": 8,
    "trigger": "api",
    "status": "succeeded",
    "docsTotal": 142,
    "docsIndexed": 0,
    "docsUpdated": 0,
    "docsSkipped": 142,
    "docsDeleted": 0,
    "docsFailed": 0,
    "error": null,
    "startedAt": "2026-08-18T03:05:58Z",
    "finishedAt": "2026-08-18T03:05:58Z",
    "durationMs": 4
  }
}
```

Nothing had changed, so all 142 documents were skipped on their content hash and the run cost 4 ms
and no embedding calls. Ingestion is awaited rather than backgrounded: a full re-index of this
corpus takes about three seconds, so a response carrying the real counts beats a job id the client
has to poll.

### Errors

One envelope everywhere, with a message written for whoever reads it and no internals in it:

```json
{ "error": { "code": "bad_request", "message": "The request body must be valid JSON." } }
```

| Code              | Status | When                                                                        |
| ----------------- | -----: | --------------------------------------------------------------------------- |
| `bad_request`     |    400 | Schema validation failed, or the body was not JSON                          |
| `unauthorized`    |    401 | No session, or an expired or revoked credential                             |
| `forbidden`       |    403 | Signed in with the wrong role, plus closed sign-up and deactivated accounts |
| `not_found`       |    404 | No such document, client or route                                           |
| `conflict`        |    409 | That email already has an account                                           |
| `rate_limited`    |    429 | Allowance spent. Carries `Retry-After`                                      |
| `upstream_failed` |    502 | The model provider failed or rejected the key                               |
| `internal`        |    500 | Anything unrecognised, logged on the server and generalised to the client   |

### MCP

Endpoint `http://localhost:4100/mcp`, Streamable HTTP transport, tool
`search_corpus(query, limit?, category?)`. Two ways in, both landing on the same role check on the
server:

```bash
claude mcp add --transport http hatko http://localhost:4100/mcp
```

That is the OIDC path, and it needs no configuration. The client gets a `401` with
`WWW-Authenticate`, reads discovery, registers itself, sends you to a consent screen, and receives
its own scoped token. For `curl` and CI, present a session token as a bearer instead:

```bash
curl -s -X POST http://localhost:4100/mcp \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_corpus","arguments":{"query":"What blocks a QA sign-off?"}}}'
```

Full instructions, including Claude Desktop and Cursor configuration, are in
[docs/mcp.md](docs/mcp.md).

---

## Features list

### Required

| Requirement                                              | Where                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Monorepo with shared types across the boundary           | `packages/shared`: Zod schemas and `z.infer` types, imported by all four others       |
| Ingestion that chunks, embeds and stores, repeatably     | `packages/core/src/ingest`, with a content-hash diff and batched embedding            |
| Ingestion observable                                     | `ingestion_runs` rows and per-document status, both on the dashboard                  |
| Semantic search over a vector store                      | `chunks_vec` (sqlite-vec) fused with FTS5                                             |
| Grounded answers citing source documents                 | `packages/core/src/answer`, with markers validated against supplied passages          |
| Says so when the corpus lacks the answer                 | A judged-grade threshold, with its own UI state                                       |
| Chat page: question, passages, cited answer              | `apps/web/app/(app)/chat`                                                             |
| Dashboard: corpus, ingestion, index health, search stats | `apps/web/app/(app)/dashboard`, six sections                                          |
| MCP server for search, documented                        | `apps/mcp` and [docs/mcp.md](docs/mcp.md)                                             |
| Authentication and role-based authorization              | Better Auth, one permissions map, route middleware                                    |
| TypeScript, Tailwind, responsive on phone to desktop     | No JavaScript files anywhere, Tailwind 4                                              |
| Error handling throughout                                | A typed envelope, handled at the boundary where the failure happens                   |
| README, AI usage log, `.env.example`, seeding            | This file, [AI_USAGE.md](AI_USAGE.md), [`.env.example`](.env.example), `npm run seed` |

### Bonus features, all six attempted

| Bonus                    | What was built                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP auth via OIDC        | Better Auth's `mcp` and `oidcProvider` plugins, so hatko is itself the authorization server. No hosted IdP, because the system has to run on a fresh machine. Discovery, dynamic client registration, PKCE, and a consent screen forced on every authorization. Bearer sessions stay available for scripts. |
| Self-updating pipeline   | `npm run ingest:watch`, built on stdlib `fs.watch` with a 500 ms debounce. It coalesces bursts, never re-enters a run, and never drops a change that arrives mid-run. New, changed and removed files are all detected incrementally.                                                                        |
| Live deployment          | <https://hatko.tugrap.dev>, behind the same sign-in, three processes behind Caddy                                                                                                                                                                                                                           |
| Retrieval quality        | Hybrid vector and BM25 search, RRF tuned by sweep, LLM rerank with absolute grading                                                                                                                                                                                                                         |
| Evaluation               | `npm run eval` reports recall@k, MRR, a per-arm comparison and answer-content checks                                                                                                                                                                                                                        |
| Search-experience polish | Streamed answers, citation markers that jump to and promote the passage they point at, a cited-passage list under every answer, term highlighting inside the passages, a score legend, keyboard shortcuts                                                                                                   |
| User management          | An admin surface to list, search, add, change role, deactivate and restore, with two lockouts refused on the server: you cannot change your own account, and the last active admin cannot be demoted or disabled.                                                                                           |

### Added beyond the brief

| Addition                        | Why                                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin-managed encrypted API key | An operator can rotate the credential without shell access. It is encrypted at rest with a key derived from `BETTER_AUTH_SECRET`, no route reads it back, and the environment variable stays supported.                                                                       |
| Rate limiting                   | Otherwise a valid token can drive unbounded rerank calls, which is real money. One allowance keyed by user id, shared by `/search`, `/answer` and the MCP tool, defaulting to 30 a minute.                                                                                    |
| Self-hosted model support       | Removes the paid dependency. One measured configuration (`qwen2.5:7b` with `nomic-embed-text`, 12 of 12), plus two documented rejections.                                                                                                                                     |
| 3D embedding view               | The retriever's central claim is that 78 near-identical delivery reports collapse into one cluster, and this makes that visible. PCA by power iteration onto a canvas, drag to rotate, click a point to read its passage. Both parts are stdlib, so no three.js and no t-SNE. |
| First-run setup checklist       | A fresh instance needs three things in a particular order. The dashboard says which, and links to each.                                                                                                                                                                       |
| Admin model selection           | Answer and rerank models, intersected with what the provider actually advertises, with the measured model marked and a warning when the rerank model changes, because that is the model abstention depends on.                                                                |
| MCP status tab                  | The MCP server is a separate process. Whether it was running, and which hostnames it accepts, previously lived only in a log readable over SSH, which is exactly where a misconfiguration hid through a whole deployment.                                                     |
| Deactivated accounts            | An immediate cut-off that both surfaces honour at once, with sign-in saying why instead of looping silently.                                                                                                                                                                  |

---

## Design decisions

The four the brief asks about, in a sentence or two each. Longer reasoning lives in code comments
next to the decision, and in [CLAUDE.md](CLAUDE.md).

**Chunking: cut on headings, then merge upward.** Split on markdown headings, merge adjacent
sections up to about 1200 characters, and hard-split only a section that exceeds 2000 on its own.
The documents are already structured, with roughly 294 level-2 headings, so cutting where the
author cut never splits an idea. Merging matters because these files are tiny, averaging 800 bytes,
and a heading-only split would shatter the 78 near-identical delivery reports into interchangeable
"## Sign-off" fragments that no ranking could tell apart. The result is 142 documents and 142
chunks, one per document, and that is the unit the sample questions name as an expected answer.

**Vector store: SQLite with sqlite-vec and FTS5, no ORM, no ANN index.** There is no service to run
and no native build, so a fresh machine needs only `npm install`, and FTS5 gives real BM25 where
Postgres `ts_rank` does not. `chunks.id` is the rowid in both the vector table and the FTS table,
so hybrid retrieval fits in a single SQL statement. 142 chunks scan exhaustively in about
1 ms, so an approximate index would trade away recall for latency nobody needs.

**Retrieval: hybrid, fused with RRF at tuned constants.** Purely semantic search answers "why are
sound assets built in a separate pass" with a wall of near-identical delivery reports, while
"separate pass" is a literal phrase in exactly one document, so the lexical arm rescues it. The
converse also holds: BM25 cannot match a question phrased in different words, and the stemmer does
not bridge `built` and `building`. RRF fuses ranks rather than scores, because BM25 and cosine
distance are not commensurable. Its textbook `k=60` with 30 candidates measured worse here than the
keyword arm alone, 78% recall@1 against 89%, because summing `1/(k+rank)` rewards ranking
mediocrely in both arms over ranking first in one. So `k=10` and 10 candidates per arm, both chosen
by sweeping against the eval set and pinned by a test.

**Reranking, and why abstention depends on it.** The rerank pass grades absolute relevance from 0
to 3 per passage instead of producing a ranking. RRF scores carry no information about match
quality, since the top result scores the same constant whether it answers the question or is merely
the least bad of 142. So there is no threshold to set on a retrieval score, and whether the corpus
covers a question has to be judged by reading the passages. Measured: answerable questions grade
1.00, unanswerable ones at most 0.33, and the threshold sits at 0.67 between them. Grading also
fixes the one ordering failure no tuning can. BM25 ranks the deprecated `sdk-notes-v2` above `v3`,
because v2 mentions `lumen.track` more prominently than the document that replaced it.

Three properties live in code, not in the prompt, because a prompt can be ignored and a check on
the output cannot. Citation markers are validated against the passages
actually supplied. An answer that cites nothing becomes an abstention. And abstention is decided
from the judged grade. Deprecation notices come from ingest-time metadata, so nothing depends on
the model volunteering them.

### Measured results

`npm run eval -- --rerank --answers` over the 142-document sample corpus, 18 Aug 2026:

| Arm     | recall@1 | recall@3 |   MRR |
| ------- | -------: | -------: | ----: |
| keyword |     100% |     100% | 1.000 |
| vector  |      89% |      89% | 0.889 |
| hybrid  |     100% |     100% | 1.000 |

Answer checks: 12 of 12. Every answerable question was answered with a valid citation, every
unanswerable one abstained, and no citation was invented. Hybrid matching keyword-only here is
worth stating plainly: the sample questions share vocabulary with their answers, which is BM25's
best case. The vector arm is insurance for questions phrased in words the corpus does not use, and
carrying it costs nothing in accuracy.

The same run also prints score separation per arm, and every arm's fused scores overlap between
answerable and unanswerable questions. That is the measurement behind the claim that a threshold
has to sit on the judged grade rather than on retrieval score.

A self-hosted setup (Ollama `qwen2.5:7b` with `nomic-embed-text`) reaches the same figures at 4.4 s
against 2.7 s. Two smaller models were measured and rejected: `qwen2.5:3b` scored 7 of 12 because
it omits citation markers, and `llama3.2:3b` scored 4 of 12 because it graded every unanswerable
question fully relevant, which destroys abstention. See [docs/self-hosted.md](docs/self-hosted.md).

---

## Security

- Two roles and one permissions map in `packages/shared`, so the API's guards and the UI's nav
  filter cannot disagree, though only the server's check is a control. `search:run` and
  `answer:generate` belong to both roles. `dashboard:view`, `documents:manage`,
  `ingestion:trigger` and `users:manage` are admin only.
- Checked as middleware before the handler runs. No route does the work first and checks afterward.
- The role never comes from the client. It is resolved from the session record, and Better Auth's
  `input: false` on the role field makes a self-registered `"role":"admin"` impossible. An
  unrecognised role fails closed to `user`.
- One authorization decision for two credentials. An OAuth access token and a bearer session both
  resolve to the same role check.
- No public sign-up, and consent is forced on every OAuth authorization. By default the MCP plugin
  issues a code without asking anyone anything, which together with open dynamic client
  registration would let one crafted link hand a stranger's client a token for the whole corpus.
- Secrets are gitignored, encrypted at rest when stored in the database, and never returned by any
  route. No password field exists anywhere in the API contract.
- Errors never leak internals on either surface. The MCP boundary was added after a raw
  `SQLITE_ERROR` carrying an absolute path was measured reaching a client.
- The MCP server also carries a DNS-rebinding guard, every paid path carries a rate limit, cookies
  are `Secure` under `NODE_ENV=production`, and passages reach the answer model labelled as
  reference material, never as instructions.

---

## Deployment guide

Live at <https://hatko.tugrap.dev>, behind the same sign-in as a local install. Verified from
outside on the current build: TLS, `/health` reporting 142 passages, both discovery documents,
the `401` challenge that starts a client's OAuth flow, and every authenticated page and API
refusing an anonymous request. Verified on the host itself: the retrieval and answer path
citing `sdk-notes-v3.md` and grading the deprecated v2 at 0.00, an abstention on a question the
corpus does not cover, an incremental ingest skipping all 142 unchanged documents, and an index
whose 142 chunks and 142 vectors agree.

Three Node processes and one reverse proxy on a single VPS. No database server, no container
runtime, no backend build step.

| Path             | Process      | Port |
| ---------------- | ------------ | ---- |
| `/mcp`           | `@hatko/mcp` | 4100 |
| `/api/*`         | `@hatko/api` | 4000 |
| `/.well-known/*` | `@hatko/api` | 4000 |
| `/health`        | `@hatko/api` | 4000 |
| everything else  | `@hatko/web` | 3000 |

One origin, not subdomains, and that was a deliberate call. Split across `app.` and `api.`, the session cookie
has to be widened to the parent domain and every request becomes cross-origin, so CORS, `SameSite`
and cookie `Domain` all become things that have to be right. On one origin none of those questions
come up.

```bash
npm install
# NEXT_PUBLIC_API_URL is inlined into the browser bundle at build time, so the build
# has to run after .env exists and with that value in its environment.
NEXT_PUBLIC_API_URL="$(grep '^NEXT_PUBLIC_API_URL=' .env | cut -d= -f2-)" npm run build:web
sudo systemctl enable --now hatko-api hatko-web hatko-mcp
```

```caddyfile
hatko.tugrap.dev {
    handle /mcp*          { reverse_proxy 127.0.0.1:4100 }
    handle /api/*         { reverse_proxy 127.0.0.1:4000 }
    handle /.well-known/* { reverse_proxy 127.0.0.1:4000 }
    handle /health        { reverse_proxy 127.0.0.1:4000 }
    handle                { reverse_proxy 127.0.0.1:3000 }
}
```

Caddy, because it obtains and renews the certificate without a second tool. Four production
settings are easy to get wrong, and each is documented with its symptom. `NODE_ENV=production`
makes cookies `Secure`, so the app stops working over plain HTTP, which is intended. `MCP_URL` has
to be the address clients actually dial, or their tokens' audience will not match.
`MCP_ALLOWED_HOSTS` has to name the public hostname, because behind a proxy the rebinding guard
sees it and refuses everything it does not recognise. And `NEXT_PUBLIC_API_URL` has to be set
_before_ the build rather than at runtime, because Next inlines it: get that wrong and the server
answers `/health` perfectly while every visitor's browser reports it cannot reach the API. That
one is written from experience, not from the documentation.

[docs/deployment.md](docs/deployment.md) has the full guide: unit files, the optional watcher
service, the nginx equivalent and the header it needs, a verification checklist, operations, and how
to take the deployment down after review.

---

## Checks

```bash
npm run typecheck && npm test     # tsc --noEmit, then 286 tests under node --test in about 10s
npm run eval                      # retrieval quality per arm
npm run format:check
```

The tests deliberately target what fails silently: a delete reaching three physical stores where
only one is covered by the foreign-key cascade, the stemmer not conflating `built` with `building`,
the tuned RRF constants, a mid-run corpus change that must not be dropped by the debouncer, the
reported MCP host allowlist being exactly the enforced one, and a multi-byte character split across
two SSE chunks surviving reassembly.

---

## Known limits

- One machine, because of SQLite. The protocol layers are stateless, so the ceiling is the database
  file. The migration path is Postgres with pgvector, a storage swap rather than a redesign, since
  retrieval is confined to `packages/core/src/retrieval`.
- The rate limit is in memory, per process. Two API processes would grant each account the
  allowance twice, and a restart forgets what anyone had spent.
- An approved OAuth client cannot be revoked individually. The immediate cut-off that does exist is
  deactivating the account, which both surfaces honour at once.
- There is no query cache, so two identical questions pay for both model calls twice.
- There is no email, so an admin sets an initial password and passes it on out of band.
- One validated self-hosted configuration. Anything else is unmeasured, and the rejected models
  show the failure is not gradual.
- Light theme only. Components consume semantic tokens, so dark mode is a token swap, but it is not
  built.

---

## Further documentation

| File                                                             | Contents                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [docs/mcp.md](docs/mcp.md)                                       | Connecting a client over OIDC or bearer, the tool contract, limits, troubleshooting |
| [docs/deployment.md](docs/deployment.md)                         | The full deploy guide, verification, operations, taking it down                     |
| [docs/self-hosted.md](docs/self-hosted.md)                       | Running without a paid provider: what was measured and what was rejected            |
| [docs/design.md](docs/design.md), [docs/brand.md](docs/brand.md) | The UI specification and the brand                                                  |
| [AI_USAGE.md](AI_USAGE.md)                                       | What AI did, what it got wrong, and how that was caught                             |
| [CLAUDE.md](CLAUDE.md)                                           | The working agreement: locked scope, decisions and their reasons                    |
| [`.env.example`](.env.example)                                   | Every variable, annotated with what breaks when it is wrong                         |

Built by Tuğrap Efe Dikpınar. [tugrap.dev](https://tugrap.dev) ·
[github.com/tugaep](https://github.com/tugaep)
