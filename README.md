# hatko

**Semantic search and grounded answers over a private document corpus.**

hatko answers questions in plain language from an indexed corpus and cites the exact
passages each claim rests on. When the corpus does not contain the answer, it says so and
cites nothing. That refusal is a designed outcome rather than a failure path, and it is
enforced in code instead of being requested in a prompt.

Three surfaces share one retrieval pipeline: a chat interface for readers, an
administrative dashboard for running the system, and an MCP server that exposes the same
retriever to outside clients. All three sit behind authentication, and every access
decision is made on the server from the session's role.

**Live deployment:** [hatko.tugrap.dev](https://hatko.tugrap.dev)

The demo runs on 1083 articles from the [English Wikipedia](https://en.wikipedia.org),
retrieved through the [MediaWiki Action API](https://www.mediawiki.org/wiki/API:Main_page)
on 24 August 2026 and converted to markdown by
[`scripts/wiki-corpus.mjs`](scripts/wiki-corpus.mjs). Every article is Circassian in
subject, walked from eleven categories rooted at
[Category:Circassians](https://en.wikipedia.org/wiki/Category:Circassians). That text is
Wikipedia's, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and
each document keeps its article title as its heading so you can trace it back to the page
and its authors. It is not committed to this repository:
[sample_dataset/ATTRIBUTION.md](sample_dataset/ATTRIBUTION.md) says why, and
`npm run corpus:fetch` rebuilds it.

Pick a subject you have documents for and point `CORPUS_PATH` at them. Nothing in the
system knows or cares that this particular corpus is about Circassians.

---

## At a glance

|                  |                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------- |
| **Retrieval**    | Hybrid dense-vector and BM25 search, RRF fusion, LLM rerank on absolute relevance   |
| **Measured**     | 100% recall@3 and MRR 0.759 hybrid, against 67% recall@3 for either arm alone       |
| **Answers**      | 12 of 12 evaluation checks pass, including three questions the corpus cannot answer |
| **Corpus**       | 1,083 documents, 7,539 passages, 68 categories                                      |
| **Stack**        | TypeScript, Node 24, SQLite with sqlite-vec and FTS5, Hono, Next 16, Better Auth    |
| **Tests**        | 287, on `node --test`, no framework                                                 |
| **Dependencies** | No ORM, no vector-database service, no container runtime, no build step             |

```bash
curl -s https://hatko.tugrap.dev/health
# {"status":"ok","indexedChunks":7539}
```

---

## Contents

- [Capabilities](#capabilities)
- [Technology stack](#technology-stack) · [Repository layout](#repository-layout)
- [Installation](#installation-instructions)
- [Running the application](#running-the-application)
- [Accounts](#accounts)
- [API documentation](#api-documentation)
- [Feature list](#feature-list)
- [Design decisions](#design-decisions) · [Measured results](#measured-results)
- [Security](#security)
- [Deployment](#deployment-guide)
- [Checks](#checks) · [Known limits](#known-limits)
- [Further documentation](#further-documentation)
- [Licence](#licence) · [Author](#author)

---

## Capabilities

Ingestion is repeatable and it leaves a record. A content-hash diff means unchanged files
are never re-embedded. Every run is written down with its counts and its outcome, and every
document carries an indexing status you can look up.

Retrieval runs two arms. Dense vectors and BM25 go through Reciprocal Rank Fusion, and then
an LLM rerank pass grades how relevant each passage actually is. That grade is what makes
refusal possible at all, because a fused rank score has no absolute meaning to threshold
against.

Citations get checked rather than trusted. Every marker in a generated answer is matched
against the passages that were really supplied. Invalid markers are stripped, and if
stripping them leaves an answer with no citations at all, the answer is withheld.

The chat page shows its working. Answers stream in, the cited passages are listed under
them, and each passage is printed in full so you can check any claim at its source.

The dashboard is where you run the thing: index health, search analytics, documents,
ingestion runs, model configuration, MCP status, user accounts, and a rotatable
three-dimensional projection of the embedding space.

The MCP server exposes one tool, `search_corpus`. It accepts either OIDC or a bearer session
token, and both land on the same authorization check the web API uses.

Authorization happens on the server. Two roles, `user` and `admin`, checked as route
middleware before any handler runs.

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
| Tests      | `node --test` (287 tests), Prettier for formatting                                                                        |

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
sample_dataset/    sample questions, and where `corpus:fetch` puts the corpus
docs/              mcp.md · deployment.md · self-hosted.md · design.md · brand.md
```

---

## Installation instructions

Prerequisite: Node 24 or newer (`node --version`). No database server, container runtime, or build
toolchain is required.

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

| Variable             | Requirement                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Required, minimum 32 characters. The servers refuse to start without it.     |
| `OPENAI_API_KEY`     | Needed to embed and answer. May be left blank and supplied in the dashboard. |

```bash
openssl rand -base64 32
```

The variables most often adjusted:

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
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=<generate one; seeding refuses to run without it>
SEED_USER_EMAIL=user@example.com
SEED_USER_PASSWORD=<generate one>
```

**3. Fetch the corpus, migrate the database, seed the accounts, index.**

```bash
npm run setup
```

That is `corpus:fetch`, then `db:migrate`, then `seed`, then `ingest`. The fetch is the
slow part: roughly twenty minutes for 1083 Wikipedia articles, one request each, and no
API key needed. The corpus is not committed;
[sample_dataset/ATTRIBUTION.md](sample_dataset/ATTRIBUTION.md) explains why and what it
retrieves. Already have documents of your own? Point `CORPUS_PATH` at them and run the
three steps after the fetch instead.

```
1083 files -> ./sample_dataset/corpus
migrated  001_init … 009_forbid_chunk_content_update
created   admin@example.com      admin
created   user@example.com       user
indexed   1083 documents · 7539 passages · 0 failed · 56.7s
```

### Seeding, separately

```bash
npm run seed      # create or reset the two demo accounts from the SEED_* values in .env
npm run db:migrate
npm run db:reset  # drop and recreate; required after changing EMBEDDING_DIMENSIONS
```

`seed` is idempotent. Re-running it resets an existing account's password and role instead of
failing, so a half-finished setup can simply be repeated. Passwords are hashed by Better Auth through
the same path the admin "add user" form uses.

Ingestion is the only step requiring a model provider. With `OPENAI_API_KEY` blank, setup stops
there with an actionable message and everything preceding it is already complete; the run can be
finished from the dashboard, as described under [First run](#first-run).

Pointing ingestion at a different corpus takes one variable: set `CORPUS_PATH` and run
`npm run ingest`. Categories are derived from the corpus's own top-level directory names and stored
as an open string, never as an enumeration of any particular corpus's folders.

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

Open <http://localhost:3000>. The MCP server is required only when connecting an external client.

Production equivalents: `npm run start:api`, `npm run build:web && npm run start:web`, and
`npm run start:mcp`.

The following run from a terminal with no web application present:

```bash
npm run ask -- "What is on the Circassian flag, and when is flag day?" --sources
npm run ingest -- --force        # re-embed everything, ignoring content hashes
npm run ingest:watch             # stay running and re-index when the corpus changes
npm run eval -- --rerank --answers
npm run typecheck && npm test
```

### First run

Sign in as the administrator first. Nothing is configured on a fresh instance, and every route
capable of configuring it requires the `admin` role. The dashboard then shows a setup checklist with three prerequisites
in dependency order (provider credential, model reachable, corpus indexed), each linking to the
panel that completes it. The checklist disappears once all three are met, and the chat page works.

The API key can live in `.env` or be entered in the dashboard, where it is stored encrypted with a
key derived from `BETTER_AUTH_SECRET`. The database value wins when both are set, the panel names
the active source, and no route ever returns the value.

---

## Accounts

`npm run setup` creates two accounts from the `SEED_*` values in `.env`. There are no default
credentials and none published here. If any of the four is unset, seeding stops and names the
variable. A password committed to a public repository becomes the password on every deployment that
forgets to change it, which this file demonstrated for a while by carrying a working administrator
credential for the live instance.

Generate the passwords rather than choosing them:

```bash
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=$(openssl rand -base64 18)
SEED_USER_EMAIL=user@example.com
SEED_USER_PASSWORD=$(openssl rand -base64 18)
```

| Role  | Reads from     | Can reach                      |
| ----- | -------------- | ------------------------------ |
| Admin | `SEED_ADMIN_*` | Chat, and the whole admin area |
| User  | `SEED_USER_*`  | Chat only                      |

Signing in as the regular user demonstrates the authorization boundary. The dashboard link is
absent from the navigation, requesting `/dashboard` directly redirects to chat with the reason
stated on the page, and the API answers the same request with `403`. Only the last of those is a
control; hiding a link is a courtesy.

There is no public sign-up: `POST /api/auth/sign-up/*` is refused with `403`. An admin creates
accounts from the dashboard.

---

## API documentation

Base URL is `http://localhost:4000` locally and `https://hatko.tugrap.dev` in production. All
requests and responses are JSON. Authentication is the session cookie in a browser, or
`Authorization: Bearer <session token>` for scripts.

### Public

| Method | Endpoint                                  | Description                                                          |
| ------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/health`                                 | Unauthenticated. `{"status":"ok","indexedChunks":7539}`              |
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
  -d '{"email":"'"$SEED_ADMIN_EMAIL"'","password":"'"$SEED_ADMIN_PASSWORD"'"}'
```

Search:

```bash
curl -s -b jar.txt -X POST http://localhost:4000/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"Who led the Circassian Confederation in the final years of the war with Russia?","limit":3}'
```

```json
{
  "query": "Who led the Circassian Confederation in the final years of the war with Russia?",
  "results": [
    {
      "chunkId": 2523,
      "documentId": 378,
      "documentTitle": "Russo–Circassian War",
      "sourcePath": "circassian-genocide/russo-circassian-war.md",
      "category": "circassian-genocide",
      "heading": "Final Circassian unification",
      "content": "#### Final Circassian unification\nLater in 1839, the Circassians declared Bighurqal (Anapa) as their new capital and Hawduqo Mansur as the leader of the Circassian Confederation…",
      "ordinal": 32,
      "score": 0.1435,
      "vectorScore": 0.8811,
      "keywordScore": 0.7642,
      "rerankScore": 1,
      "isDeprecated": false,
      "supersededBy": null
    }
  ],
  "latencyMs": 2372
}
```

A real run, and it shows why the arms are fused rather than picked between. This passage scores
0.8811 on the vector side and 0.7642 on the keyword side. Both arms found it, and that is what
lifts it above the several hundred biographies that mention Circassia, war and Russia in almost
the same words. `heading` is populated because the corpus is long articles now, so a passage is a
section rather than a whole document, and `ordinal` 32 says how far into the article it sits.

`score` is the fused rank score and the primary ordering. `vectorScore` is null when a passage was
found by keyword alone and `keywordScore` is null in the converse case. `rerankScore` is the judged
relevance. All three are part of the contract on purpose, because the product promise is to show
its work.

Answer:

```bash
curl -s -b jar.txt -X POST http://localhost:4000/api/answer \
  -H 'content-type: application/json' \
  -d '{"query":"What is on the Circassian flag, and when is flag day?"}'
```

```json
{
  "query": "What is on the Circassian flag, and when is flag day?",
  "answer": "The Circassian flag consists of a green field charged with twelve gold stars, nine forming an arc resembling a bow and three horizontal, along with three crossed arrows in the center. Flag day is celebrated on April 25 each year by Circassians [1].",
  "abstained": false,
  "citations": [
    {
      "index": 1,
      "chunkId": 2860,
      "documentId": 416,
      "documentTitle": "Seferbiy Zaneqo",
      "sourcePath": "circassian-nationalism/seferbiy-zaneqo.md",
      "isDeprecated": false
    }
  ],
  "deprecationNotices": [],
  "sources": ["… the six graded passages …"],
  "latencyMs": 2461
}
```

Verbatim output, including a detail deliberately left in place: the cited passage is a biography,
not the article titled "Circassian flag". Three passages from the flag article were retrieved and
two of them graded 0.33; the biography quotes the flag's description in full and graded 1.00. The
answer is right and the citation really does support it, which is the guarantee. The promise is
that you can check every claim against the passage shown. It is not a promise that the passage
comes from the document with the most obvious title.

An abstention is a 200 carrying `abstained: true`, no citations, and the nearest passages so the
reader can judge the miss for themselves:

```bash
curl -s -b jar.txt -X POST http://localhost:4000/api/answer \
  -H 'content-type: application/json' \
  -d '{"query":"How many stars are on the Chechen flag?"}'
```

```json
{
  "query": "How many stars are on the Chechen flag?",
  "answer": "No documents cover this.",
  "abstained": true,
  "citations": [],
  "deprecationNotices": [],
  "sources": ["… 6 passages, every one graded 0.00 …"],
  "latencyMs": 1897
}
```

That is the hard case rather than an easy one. The question is lexically almost identical to the
one above, and retrieval confidently returns `circassian-culture/circassian-flag.md` for it. The
corpus has a flag article. It is just not that flag. Fused scores cannot tell the two questions apart;
the grader can, and scores all six passages 0.00. Abstention is a judgement about relevance, not a
threshold on a retrieval score.

Streamed, same endpoint:

```bash
curl -N -b jar.txt -X POST http://localhost:4000/api/answer \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"query":"What is on the Circassian flag, and when is flag day?"}'
```

```
data: {"type":"passages","sources":[…]}
data: {"type":"delta","text":"The Circassian flag"}
data: {"type":"delta","text":" consists of a green field"}
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
    "id": 10,
    "trigger": "api",
    "status": "succeeded",
    "docsTotal": 1083,
    "docsIndexed": 0,
    "docsUpdated": 0,
    "docsSkipped": 1083,
    "docsDeleted": 0,
    "docsFailed": 0,
    "error": null,
    "startedAt": "2026-08-24T18:31:12Z",
    "finishedAt": "2026-08-24T18:31:12Z",
    "durationMs": 108
  }
}
```

Nothing had changed, so all 1083 documents were skipped on their content hash: 108 ms and no
embedding calls at all. The first run over the same corpus embeds 7539 passages and takes 56.7 s,
which is the whole point of hashing. The expensive path runs once.

Ingestion is awaited rather than backgrounded. That is comfortable at a hundred milliseconds for a
no-op and defensible at a minute for a full re-index, but it is a real ceiling: a corpus large
enough to make the first ingest span minutes wants a job id and polling instead.

### Errors

A single envelope shape throughout, carrying a message written for the caller and no internal detail:

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
`search_corpus(query, limit?, category?)`. Two authentication paths, both resolving to the same
server-side role check:

```bash
claude mcp add --transport http hatko http://localhost:4100/mcp
```

That is the OIDC path and requires no configuration. The client receives a `401` with
`WWW-Authenticate`, reads discovery, registers itself dynamically, directs the operator to a
consent screen, and receives its own scoped token. For `curl` and CI, present a session token as a
bearer credential instead:

```bash
curl -s -X POST http://localhost:4100/mcp \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_corpus","arguments":{"query":"Who led the Circassian Confederation?"}}}'
```

Full instructions, including Claude Desktop and Cursor configuration, are in
[docs/mcp.md](docs/mcp.md).

---

## Feature list

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
| Live deployment          | [hatko.tugrap.dev](https://hatko.tugrap.dev). Three Node processes and Caddy on one host, with TLS, systemd units, and a verification checklist in [docs/deployment.md](docs/deployment.md).                                                                                                                |
| Retrieval quality        | Hybrid vector and BM25 search, RRF tuned by sweep, LLM rerank with absolute grading                                                                                                                                                                                                                         |
| Evaluation               | `npm run eval` reports recall@k, MRR, a per-arm comparison and answer-content checks                                                                                                                                                                                                                        |
| Search-experience polish | Streamed answers, citation markers that jump to and promote the passage they point at, a cited-passage list under every answer, term highlighting inside the passages, a score legend, keyboard shortcuts                                                                                                   |
| User management          | An admin surface to list, search, add, change role, deactivate and restore, with two lockouts refused on the server: you cannot change your own account, and the last active admin cannot be demoted or disabled.                                                                                           |

### Added beyond the brief

| Addition                        | Why                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin-managed encrypted API key | An operator can rotate the credential without shell access. It is encrypted at rest with a key derived from `BETTER_AUTH_SECRET`, no route reads it back, and the environment variable stays supported.                                                                                                   |
| Rate limiting                   | Otherwise a valid token can drive unbounded rerank calls, which is real money. One allowance keyed by user id, shared by `/search`, `/answer` and the MCP tool, defaulting to 30 a minute.                                                                                                                |
| Self-hosted model support       | Removes the paid dependency. One configuration measured 12 of 12 (`qwen2.5:7b` with `nomic-embed-text`), on the previous corpus and not re-measured since. [docs/self-hosted.md](docs/self-hosted.md) says so, along with two rejected models.                                                            |
| 3D embedding view               | The retriever's central claim is that near-identical documents collapse into one indistinguishable cluster, and this makes that visible instead of asserted. PCA by power iteration onto a canvas, drag to rotate, click a point to read its passage. Both parts are stdlib, so no three.js and no t-SNE. |
| First-run setup checklist       | A fresh instance needs three things in a particular order. The dashboard says which, and links to each.                                                                                                                                                                                                   |
| Admin model selection           | Answer and rerank models, intersected with what the provider actually advertises, with the measured model marked and a warning when the rerank model changes, because that is the model abstention depends on.                                                                                            |
| MCP status tab                  | The MCP server is a separate process. Whether it was running, and which hostnames it accepts, previously lived only in a log readable over SSH, which is exactly where a misconfiguration hid through a whole deployment.                                                                                 |
| Deactivated accounts            | An immediate cut-off that both surfaces honour at once, with sign-in saying why instead of looping silently.                                                                                                                                                                                              |

---

## Design decisions

The four the brief asks about, in a sentence or two each. Longer reasoning lives in code comments
next to the decision it explains.

**Chunking: cut on headings, then merge upward.** Split on markdown headings, merge adjacent
sections up to about 1200 characters, and hard-split only a section that exceeds 2000 on its own.
The documents are already structured, so cutting where the author cut never splits an idea.
Merging matters because a heading-only split leaves a fragment wherever someone wrote a two-line
section, and a fragment has too little text for a meaningful embedding. On this corpus the result
is 1083 documents and 7539 chunks, averaging 1082 characters: 277 documents are short enough to
stay whole, and the longest splits into 150. Both halves earn their place. The same code produced
exactly one chunk per document on an earlier corpus of 142 short files, which is the argument for
the merge step rather than a fact about either corpus.

**Vector store: SQLite with sqlite-vec and FTS5, no ORM, no ANN index.** There is no service to run
and no native build, so a fresh machine needs only `npm install`, and FTS5 gives real BM25 where
Postgres `ts_rank` does not. `chunks.id` is the rowid in both the vector table and the FTS table,
so hybrid retrieval fits in a single SQL statement. A full hybrid query over 7539 chunks measures
about 13 ms, so an approximate index would trade away recall for latency no user is waiting on. The
one place the exhaustive habit stopped scaling is the category filter, which asked for a candidate
pool the size of the whole collection and hit sqlite-vec's 4096 cap; it is capped there now, at
200 ms, and the code says exactly which guarantee that weakened.

**Retrieval: hybrid, fused with RRF at tuned constants.** The corpus is one dense subject, so
near-identical documents are the normal case: asked who led the Circassian Confederation, semantic
search alone returns a wall of biographies that each mention Circassia, war, Russia and exile, and
the lexical arm rescues it because the office is named in only a couple of them. The converse holds
too. BM25 cannot match "a language with an unusually large number of speech sounds" against a
document that says "consonants", and the stemmer never gets `built` to meet `building`. Measured,
each arm alone reaches 67% recall@3 and together they reach 100%. RRF fuses ranks rather than
scores, because BM25 and cosine distance are not commensurable. Its textbook `k=60` with 30
candidates measured worse than the keyword arm alone on the corpus it was swept against, because
summing `1/(k+rank)` rewards ranking mediocrely in both arms over ranking first in one. So `k=10`
and 10 candidates per arm, chosen by sweep and pinned by a test.

**Reranking, and why abstention depends on it.** The rerank pass grades absolute relevance from 0
to 3 per passage instead of producing a ranking. RRF scores carry no information about match
quality, since the top result scores the same constant whether it answers the question or is merely
the least bad of several thousand. The eval prints the proof: fused scores for answerable questions
span 0.0833 to 0.1818 and for unanswerable ones 0.0833 to 0.1333. Those overlap, so there is no
cut between them. Graded relevance does separate: answerable questions grade 1.00 and unanswerable
ones at most 0.33, and the threshold sits at 0.67 in between.

Grading also fixes an ordering failure no tuning can. Hybrid reaches 100% recall@3 but only 56%
recall@1, so on nearly half the questions the right passage is retrieved without being ranked
first, and something has to reorder six passages that fusion could not separate. The sharpest
version is a superseded document outranking its replacement because it happens to use the shared
vocabulary more heavily: the difference is not in the words but in one document saying "deprecated,
see the newer version", which only a reader can act on.

Three properties live in code, not in the prompt, because a prompt can be ignored and a check on
the output cannot. Citation markers are validated against the passages
actually supplied. An answer that cites nothing becomes an abstention. And abstention is decided
from the judged grade. Deprecation notices come from ingest-time metadata, so nothing depends on
the model volunteering them.

### Measured results

`npm run eval -- --rerank --answers`, 24 Aug 2026, over 7539 chunks with 9 answerable questions
and 3 the corpus cannot answer:

| Arm     | recall@1 | recall@3 | recall@5 |   MRR |
| ------- | -------: | -------: | -------: | ----: |
| keyword |      44% |      67% |      78% | 0.596 |
| vector  |      56% |      67% |      67% | 0.611 |
| hybrid  |  **56%** | **100%** | **100%** | 0.759 |

Fusion is worth its complexity here in a way a single number hides. At rank 1 hybrid ties the
vector arm, so if recall@1 were the only figure quoted you would conclude the keyword arm is dead
weight. At rank 3 the two arms reach 67% each and fused they reach 100%, because they miss
_different_ questions. That is the entire premise, and it is why the answer path retrieves six
passages: six is where the fusion pays.

Answer checks: 12 of 12. Every answerable question was answered with a valid citation, every
unanswerable one abstained, and no citation was invented.

Recall@1 of 56% is a real number and not a flattering one. It is also the number the rest of the
pipeline is built around: 100% at rank 3 feeding a reranker that grades absolute relevance is what
turns "the answer is somewhere in these six" into a correct, cited answer twelve times out of
twelve. A system that quoted recall@1 and stopped there would be measuring the wrong stage.

One ground-truth correction, disclosed because moving goalposts after seeing results is how an
an evaluation loses its meaning: the Ubykh question originally listed one expected document and retrieval
returned a different one, `ubykh-language/ubykh-phonology.md`, which opens by stating the language
has the largest consonant inventory of any documented language without clicks. That answers the
question more directly than the document listed. Both are accepted now, because the ground truth
was wrong rather than the ranking, and the reasoning sits next to the question itself.

A self-hosted setup (Ollama `qwen2.5:7b` with `nomic-embed-text`) scored 12 of 12 at 4.4 s against
2.7 s, and two smaller models were measured and rejected: `qwen2.5:3b` at 7 of 12 because it omits
citation markers, and `llama3.2:3b` at 4 of 12 because it graded every unanswerable question fully
relevant, which destroys abstention. Those figures were measured on the previous corpus and have
not been re-run against this one. See [docs/self-hosted.md](docs/self-hosted.md).

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

Deployed at [hatko.tugrap.dev](https://hatko.tugrap.dev), behind the same sign-in as a local
install. [docs/deployment.md](docs/deployment.md) is the full guide and carries its own
verification checklist.

Verified from outside: TLS, both OAuth discovery documents, the `401` challenge that begins a
client's authorization flow, and every authenticated page and API endpoint refusing an anonymous
request. Verified on the host: the retrieval and answer path, an abstention on a question the
corpus does not cover, an incremental ingest skipping unchanged documents, and an index whose
chunk and vector counts agree.

That verification run was performed against the previous corpus. The architecture and the
checklist are unchanged; the figures in it belong to a smaller index.

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
npm run typecheck && npm test     # tsc --noEmit, then 287 tests under node --test
npm run eval                      # retrieval quality per arm
npm run format:check
```

The suite is 287 tests with the corpus present and 264 without it, the remaining 23 skipping with
an instruction rather than failing, since the corpus is fetched rather than committed.

Tests deliberately target what fails silently: a delete reaching three physical stores where
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
| [`.env.example`](.env.example)                                   | Every variable, annotated with what breaks when it is wrong                         |
| [sample_dataset/ATTRIBUTION.md](sample_dataset/ATTRIBUTION.md)   | Where the corpus came from and the licence it carries                               |

---

## Licence

The code is [MIT](LICENSE).

That covers everything in the repository, because the corpus is not in it. `npm run
corpus:fetch` downloads Wikipedia articles, and that text is
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), a share-alike licence
whose obligations would otherwise land on everyone who cloned this, over text none of us
wrote. Shipping the fetcher rather than the data keeps the two licences separate:
`scripts/wiki-corpus.mjs` is MIT, and what it downloads stays Wikipedia's.
[sample_dataset/ATTRIBUTION.md](sample_dataset/ATTRIBUTION.md) has the detail.

---

## Author

**Tuğrap Efe Dikpınar**

|           |                                                                   |
| --------- | ----------------------------------------------------------------- |
| Portfolio | [tugrap.dev](https://tugrap.dev)                                  |
| Email     | [tugrapefedikpinar@gmail.com](mailto:tugrapefedikpinar@gmail.com) |
| GitHub    | [github.com/tugaep](https://github.com/tugaep)                    |

Questions about the retrieval design, the evaluation methodology, or the deployment are
welcome by email. Issues and pull requests are welcome on the repository.
