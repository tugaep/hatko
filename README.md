# hatko

Semantic search and grounded answers over an internal document corpus. Ask a question,
hatko retrieves the passages that answer it and writes an answer citing them. When the
corpus has no answer, it says so instead of inventing one.

Three surfaces sit on top of one retrieval pipeline: a chat page, an admin dashboard, and
an MCP tool for editors and agents. All of them are behind role-based auth enforced on the
server.

## Stack

| Layer     | Choice                                                                    |
| --------- | ------------------------------------------------------------------------- |
| Runtime   | Node 24+, TypeScript run directly by type stripping, so there is no build |
| Storage   | `node:sqlite` with sqlite-vec for vectors and FTS5 for BM25               |
| Retrieval | Hybrid vector plus BM25, fused with RRF, then an LLM rerank pass          |
| API       | Node HTTP server, Zod schemas shared with the frontend                    |
| Web       | Next 16, React 19, Tailwind 4                                             |
| MCP       | Streamable HTTP, bearer sessions and OIDC                                 |
| Auth      | Better Auth, roles `user` and `admin`                                     |

Workspaces: `packages/shared` (Zod schemas and the types both sides infer from them),
`packages/core` (ingestion, retrieval, answers, auth), `apps/api`, `apps/web`, `apps/mcp`.

## Install and run

Node 24 or newer. Nothing else needs installing: no database server, no native build.

```bash
npm install
cp .env.example .env
```

Open `.env` and set two values. `OPENAI_API_KEY` is the provider key, which can also be
entered later in the dashboard instead. `BETTER_AUTH_SECRET` must be at least 32
characters, and the servers refuse to start without it:

```bash
openssl rand -base64 32
```

Then migrate the database, create the demo accounts, and index the sample corpus:

```bash
npm run setup
```

`setup` is migrate, seed and ingest. Ingestion embeds every document, so it needs a
provider — if you left `OPENAI_API_KEY` blank it will stop there, and the rest of this
still worked. Finish from the dashboard instead, below.

Run the three servers in separate terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

```bash
npm run dev:mcp
```

The app is at http://localhost:3000. The API is on 4000 and the MCP server on 4100.

## First run

**Sign in as the admin before anything else.** Nothing is configured on a fresh
installation, and every route that could configure it is behind `admin` — so the first
action on a new instance is always an administrator signing in. A regular user landing
first sees an honest empty state and no way to fix it, which is correct: they should not
be able to.

The dashboard then shows a **setup checklist** with the three prerequisites, in the order
they depend on each other. It disappears once they are met.

| #   | Step                | Why it is in this position                                              |
| --- | ------------------- | ----------------------------------------------------------------------- |
| 1   | Provider credential | Everything below costs a provider call. A local model server needs none |
| 2   | Model reachable     | Confirms the credential and the address actually answer                 |
| 3   | Corpus indexed      | 142 documents, one embedding call each — needs 1 and 2 to be true       |

Each step links to the panel that completes it. After step 3 the chat page works.

The **API key** goes in the dashboard rather than `.env` if you prefer: it is stored
encrypted with a key derived from `BETTER_AUTH_SECRET`, the panel names which source is
active, and the database value wins when both are set. Either way it is never returned by
any route.

The **model** is a dropdown of what your provider actually advertises, not a fixed choice
— answer model and rerank model separately. `gpt-4o-mini` is marked _measured_, because it
is the one the reported figures and the abstain threshold were calibrated against;
changing the rerank model shows a warning saying exactly that. Admins get the same answer
-model dropdown in the chat header, so two models can be compared without leaving the page
the answers are on. It changes the setting for everyone, and says so.

## Demo credentials

Both accounts are created by `npm run setup`, from the `SEED_*` values in `.env`.

| Role  | Email           | Password            | Can reach              |
| ----- | --------------- | ------------------- | ---------------------- |
| Admin | efe@tugrap.dev  | PlayableFactory7766 | Chat and the dashboard |
| User  | user@tugrap.dev | PlayableFactory6677 | Chat only              |

Sign in as the regular user to see the role gating. The dashboard link is absent from the
nav, and asking for `/dashboard` directly redirects to chat with the reason stated on the
page. The API answers the same request with a 403, which is where the decision is actually
made. Hiding the link is only a courtesy.

There is no public sign-up. An admin creates accounts from the dashboard.

## Checks

```bash
npm run typecheck && npm test
```

Retrieval quality is measured against the sample questions rather than judged by eye:

```bash
npm run eval
```

## Further documentation

- [docs/mcp.md](docs/mcp.md) — connecting an MCP client, both bearer and OIDC
- [docs/deployment.md](docs/deployment.md) — production configuration and the deploy guide
- [docs/self-hosted.md](docs/self-hosted.md) — running without a paid provider
- [docs/design.md](docs/design.md) and [docs/brand.md](docs/brand.md) — the UI specification
- [AI_USAGE.md](AI_USAGE.md) — what AI wrote, what it got wrong, and how that was caught

Built by Tuğrap Efe Dikpınar. [tugrap.dev](https://tugrap.dev) ·
[github.com/tugaep](https://github.com/tugaep)
