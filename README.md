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

## Demo credentials

Both accounts are created by `npm run setup`, from the `SEED_*` values in `.env`.

| Role  | Email            | Password            | Can reach              |
| ----- | ---------------- | ------------------- | ---------------------- |
| Admin | efe@tugrap.dev   | PlayableFactory7766 | Chat and the dashboard |
| User  | user@hatko.local | hatko-user-demo     | Chat only              |

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
