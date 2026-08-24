# Hatko — working agreement

Read this before touching anything. It exists because this repository is a graded
submission with a fixed rubric and a hard timebox, and the most likely way to lose
points is not a bug — it is building something nobody asked for while a required
thing stays unfinished.

---

## 1. What this is

A semantic search + RAG system over an internal document corpus, submitted as a
private GitHub repository. Two surfaces (chat page, admin dashboard), search also
exposed as an MCP tool, everything behind role-based auth. Timebox: roughly two
days of work. **A smaller system that works end-to-end beats a larger one that
half-works** — that is the brief's own wording, not a preference.

Brand and UI spec: [docs/brand.md](docs/brand.md), [docs/design.md](docs/design.md).

---

## 2. How this is scored

Five axes, **equally weighted**:

| Axis                             | Means                                                          |
| -------------------------------- | -------------------------------------------------------------- |
| Retrieval and RAG quality        | Right passages, grounded answers, honest abstention            |
| Monorepo and system architecture | Clear workspaces, shared types across the boundary             |
| Code quality                     | Readable, consistent, real error handling, reusable components |
| Security                         | Auth + authz enforced server-side, by role                     |
| Clarity of communication         | README, commit history, AI usage log                           |

**The controlling implication: brilliance on one axis cannot buy a shortfall on
another.** A superb retriever with a thin README scores 60%. Two of these five
axes are documentation and commits — treat them as deliverables with the same
weight as code, not as cleanup.

Responsive UI and error handling are stated as expected throughout, not as bonus.

An interview walkthrough follows, covering the code and the AI usage log, with
live changes. Every decision must be explainable in a sentence. If you cannot say
why, it is the wrong decision.

---

## 3. Locked scope

Decided with the user. Do not expand without asking.

**In:**

- Monorepo, shared Zod-derived types
- Ingestion: heading-based chunking, content-hash idempotency, observable runs
- SQLite + sqlite-vec + FTS5 storage
- Hybrid retrieval (vector + BM25, RRF-fused) → LLM rerank
- Grounded answers with citations, and an honest abstain path
- Chat page, admin dashboard
- MCP search tool
- Better Auth, `user` / `admin` roles
- Eval script over the sample questions
- **Admin-managed OpenAI API key**, entered in the web UI and stored encrypted.
  The environment variable stays supported and documented: `RULES.md` requires
  keys to be suppliable that way, the CLI needs it before anyone can sign in, and
  a fresh machine has to be able to ingest before the UI exists. Database value
  wins when both are present; the UI names the active source.

**Added to scope on 17 Aug 2026, by the user, after step 7 review.** These four were
on the "out" list below and were moved deliberately, not drifted into. The reason to
record that: each one was previously argued _against_ in this file, so anyone reading
the history needs to know the decision changed rather than that the rule was ignored.

- **OIDC on the MCP server.** Better Auth's own `mcp` + `oidcProvider` plugins, so
  Hatko _is_ the authorization server. An external IdP is not an option: the brief
  requires the system to run on a fresh machine, and a hosted dependency would break
  that. Bearer sessions stay supported for `curl` and CI — both paths land on the same
  `requirePermission`, so there is still one authorization decision, not two.
- **Autonomous ingestion.** The hash-diff engine already detected new, changed and
  removed documents; what was missing was a trigger. A stdlib `fs.watch` with
  debounce, off by default, plus the existing CLI and dashboard triggers.
- **Live deployment** to `hatko.tugrap.dev`. Production config and a full deploy guide
  are in scope; the operator runs the deploy.
- **Admin user-management UI** — list, invite, change role, deactivate. This was
  **step 8**, and it pushed the README/AI-usage/history step to **step 9** — which the
  18 Aug additions below then pushed to **step 14**. The number has moved twice; the
  table in §9 is the authority, not this paragraph.

**Added to scope on 18 Aug 2026, by the user, after the bonus-feature audit.** Five
steps, inserted ahead of the README step. Two were on the bonus list, one was a gap the
code documents about itself, and two are the user's own additions — which `bonus.md`
explicitly invites: "extending the scope, or adding something that makes the system
genuinely better is encouraged; tell us what you added and why."

- **Rate limiting** (step 9). Named as a gap in `docs/mcp.md` §7 and
  `docs/deployment.md` §10: a valid token can drive unbounded rerank calls, which is
  real money, and `/answer` is the same. Security is a graded axis and this is the one
  hole the audit left standing. In-memory fixed-window counter keyed by user id, no
  dependency, returning the 429 `apiErrorSchema` already declares.
- **Streaming answers** (step 10). Moved off the out-list below, deliberately. The last
  search-experience item on `bonus.md`. Citation validation and the abstain decision
  still run against the _complete_ text — streaming changes how an answer arrives, never
  what is allowed to be claimed in it.
- **Self-hosted models** (step 11). Removes the paid external dependency, which makes
  "runs on a fresh machine" stronger rather than weaker. Two constraints, both real, and
  both recorded here so nobody rediscovers them mid-step: (1) `EMBEDDING_DIMENSIONS=1536`
  is compiled into the vec0 column width in migration 001, and every small local
  embedding model is 384 or 768 — so local embeddings need a migration and a full
  re-ingest, and one vector column cannot serve two providers at different widths;
  (2) the abstain threshold is calibrated against `gpt-4o-mini`'s grades (answerable
  1.00, unanswerable ≤0.33, threshold 0.67), and a 0.5B model will not hold that by
  assumption. So local generation is only claimed once the eval script measures it, and
  the OpenAI path stays the default.
- **3D embedding view** (step 12). A dashboard tab projecting the stored vectors to three
  dimensions. Not decoration: the argument this whole retriever rests on is that 78
  near-identical documents collapse into one indistinguishable cluster, and this
  is that claim made visible instead of asserted. PCA by power iteration over whichever
  of the Gram or covariance matrix is smaller, and a canvas projection with
  drag-to-rotate — both stdlib, because t-SNE and three.js are each a dependency for
  what fifty lines of arithmetic covers.
- **Run the deploy** (step 13). Step 8b wrote the guide and its own verification
  checklist but nobody has run it on a server, which `AI_USAGE.md` says plainly. The
  bonus asks for a shareable link, so the guide has to become a deployment. Last before
  the README, because it deploys whatever exists by then.

**Out — deliberately, do not build:**

- Per-client OAuth revocation. A "connected applications" panel that deletes one
  client's tokens. Surfaced by the 18 Aug audit and recorded as a stated limit in
  `docs/mcp.md` §7 instead. Deactivating the account is the immediate cut-off that does
  exist; tying tokens to the session is the wrong fix and §7 says why.
- Anything else not named above.

If a task seems to need something from the "out" list, stop and ask. Do not
quietly widen scope, and do not quietly narrow it either.

---

## 4. Non-negotiables

Every one of these is required. None may be dropped to make room.

- [ ] Monorepo, clear workspaces, shared types across the frontend/backend boundary
- [ ] Ingestion: chunk → embed → store, repeatable and observable (what was indexed, when, did it succeed)
- [ ] Semantic search + grounded answers citing sources
- [ ] **Says so when the corpus lacks the answer, and invents no citation**
- [ ] Chat page: ask, see passages, see grounded answer with citations
- [ ] Dashboard: indexed documents, ingestion status, index health, basic search stats
- [ ] MCP server exposing search, with connection instructions
- [ ] Sign-in; pages, actions and APIs enforced by role; dashboard and management blocked for regular users
- [ ] TypeScript throughout; Tailwind; responsive on phone/tablet/desktop
- [ ] Error handling throughout
- [ ] README: description, stack, install, run, **demo credentials**, API docs, deployment notes, feature list
- [ ] `AI_USAGE.md`: what AI did, what was hand-written, where it was wrong, how it was caught
- [ ] `.env.example` and seeding instructions
- [ ] Clean git history with meaningful commit messages

---

## 5. Decisions already made — do not relitigate

Each has a reason. Changing one means changing the reason first.

**Storage: `node:sqlite` (stdlib) + sqlite-vec + FTS5.** Not Postgres/pgvector.
No service to run, no native build, so a fresh machine needs only `npm install`.
FTS5 gives real BM25, which Postgres `ts_rank` does not.

**No ORM.** Drizzle has no `node:sqlite` driver, and the two queries that matter
(vec0 KNN, FTS5 fusion) are raw SQL regardless. Row types come from the Zod
schemas in `packages/shared`, so the database and the API share one definition.

**No build step.** Node runs the TypeScript directly via type stripping.
`erasableSyntaxOnly` is on, so no `enum`, no `namespace`, no parameter
properties. Use `import type` for type-only imports.

**No ANN index.** A full hybrid query over 7539 chunks measures about 13 ms,
scanned exhaustively. An approximate index would trade recall away for latency
nobody is waiting on. The one place this stopped scaling is the category filter,
which asked for a candidate pool the size of the collection and hit sqlite-vec's
4096 cap; it is capped there now and `search.ts` records which guarantee that
weakened.

**npm workspaces, not pnpm.** Corepack is gone in Node 26; npm ships with Node.

**Three stores share one integer key space** — `chunks.id` is the rowid in
`chunks_vec` and `chunks_fts`. That is what makes hybrid retrieval one statement.
Do not break this alignment.

**Category is an open string**, never an enum of the sample corpus's folder
names. The brief requires that pointing ingestion at the real corpus be
straightforward.

**RRF k=10 and 10 candidates per arm, both chosen by sweep — do not restore the
textbook k=60.** With k=60 and a 30-candidate pool, hybrid scored _worse_ than
keyword alone (recall@1 78% vs 89%): summing 1/(k+rank) rewards ranking mediocrely
in both arms over ranking first in one, which dropped `localization-guide.md` from
keyword rank 1 to outside the hybrid top 30. k=60 assumes ~1000 candidates; 30 of
142 chunks is a fifth of that corpus. Candidate depth should scale with the corpus
as a fraction rather than a constant; it survives at 7539 chunks because the
sweep's failure mode is a pool that is too _large_, and growth moves away from it.
Pinned by a test in `packages/core/src/retrieval/search.test.ts`.

**The reranker grades absolute relevance 0–3, not a ranking**, because abstention
depends on it. Fused scores cannot support a threshold: RRF is rank-derived, so
the top result scores the same constant whether it answers the question or is the
least bad of several thousand. Measured on the current corpus: fused scores overlap
between answerable and unanswerable questions (0.0833–0.1818 against 0.0833–0.1333),
while graded relevance separates cleanly — 1.00 against at most 0.33, threshold 0.67.

---

## 6. Corpus facts that shape retrieval

The corpus is not in the repository — `npm run corpus:fetch` builds it, because it
is Wikipedia text under a share-alike licence. What it produces: 1083 documents,
7539 chunks, 68 categories, ~1.28M words. The difficulty is real rather than
planted, which is the point of choosing one dense subject:

- **Hundreds of near-identical biographies.** 117 in one category alone, and
  several hundred across the corpus, each mentioning Circassia, war, Russia,
  exile and the Ottoman Empire in almost the same words. Measured: asked who led
  the Circassian Confederation, the vector arm alone reaches 67% recall@3 and
  fusion with the lexical arm reaches 100%. The crowding is what the second arm
  exists for.
- **Questions phrased in words the corpus does not use.** "A language with an
  unusually large number of speech sounds" against documents that say
  "consonants". The lexical arm cannot bridge that at all; the vector arm can.
  Each arm misses a _different_ set of questions, which is why fusing them beats
  either — 67% each, 100% together.
- **No document declares itself obsolete.** Encyclopaedia articles do not, so the
  deprecation trap that justifies the rerank pass is carried by the fixture corpus
  in `packages/core/src/testing/` instead. Detection, the answer prompt and the UI
  notice are unchanged; only the evidence for them moved.
- **Documents are long and split properly.** Mean 7675 bytes, longest 215 KB.
  Measured: 7539 chunks from 1083 documents, mean 1082 characters, 277 documents
  small enough to stay whole and one splitting into 150. The earlier corpus of 142
  short files produced exactly one chunk each, and the same code was correct then —
  which is the argument for having both the split and the merge.
- **The porter stemmer does not conflate irregular verbs** — `built` and
  `building` never meet. Asserted in `packages/core/src/db/schema.test.ts` so it
  stays visible. The vector arm covers this class of gap.
- **Some questions are unanswerable on purpose.** Abstention is a feature with a
  designed UI state, not an error path.

`sample_dataset/sample_questions.md` is a specification, not a set of examples —
the private eval set is stated to be "in the same style".

---

## 7. Drift rules

These are the failure modes that have already happened or nearly happened here.

1. **Audit against §4 before every commit.** This caught a real bug: a category
   enum built from the sample corpus's folder names, which would have failed
   validation on every file of a differently-organised corpus.
2. **Do not build ahead of the current step.** A schema for an unselected bonus is
   drift even when it costs ten lines. Two such were cut in step 1.
3. **The requested scope is the deliverable.** Do not silently narrow it, widen
   it, or transform it. Blocked on part of it? Finish everything else and say
   exactly what was left out and why.
4. **New dependency requires a justification in the commit message.** Reach for
   stdlib first — `node:sqlite`, `node:test`, `process.loadEnvFile`, `node:crypto`
   already replaced four dependencies here.
5. **No speculative abstraction.** No interface with one implementation, no
   factory for one product, no config for a value that never changes.
6. **When two readings of a task differ materially, ask.** Otherwise make the call
   a careful colleague would and state the assumption.

---

## 8. Workflow rules

1. **Verify before claiming.** Run it. "Should work" is not a result. Every claim
   in a response or a commit message must trace to output actually seen.
2. **Report faithfully.** Tests failing means say so with the output. Step skipped
   means say so. Never describe planned work in the past tense.
3. **Non-trivial logic leaves one runnable check** — the smallest thing that fails
   if the logic breaks. `node --test`, no frameworks, no fixtures. Trivial
   one-liners need no test.
4. **Test what fails silently**, not what fails loudly. The step-1 tests target a
   delete reaching three physical stores where only one is covered by the foreign
   key cascade — a regression there corrupts retrieval quietly.
5. **`npm run typecheck && npm test` before every commit.** Both clean, or the
   commit explains why not.
6. **Commit per coherent step**, with a message saying _why_, not _what_. The diff
   already says what. Commit history is a graded axis.
7. **Record AI usage as you go** in [AI_USAGE.md](AI_USAGE.md) — especially where
   it was wrong and how that was caught. Reconstructing it at the end produces a
   worthless document, and this is 1/5 of the grade. Append to it in the same
   commit as the work it describes.
8. **Errors get handled at the boundary they occur.** Actionable message, correct
   status, no leaking internals to the client. Config errors say how to fix them.
9. **Never commit secrets.** `.env` is ignored; `.env.example` carries the shape.

---

## 9. Build order and status

Each step ends somewhere demonstrable.

| #   | Step                                                   | Status                                               |
| --- | ------------------------------------------------------ | ---------------------------------------------------- |
| 1   | Workspace, shared schemas, SQLite schema, migrations   | **done** — `549c0b9`                                 |
| 2   | Ingestion CLI → corpus indexed, runs recorded          | **done**                                             |
| 3   | Hybrid retrieval + rerank + eval script                | **done** — recall@1 100%, MRR 1.000                  |
| 4   | RAG answers, citations, abstain path                   | **done**                                             |
| 5   | Better Auth, roles, server-side gating                 | **done**                                             |
| 6   | Chat page, then dashboard                              | **done** — Next 16, light theme only, reviewed       |
| 7   | MCP server                                             | **done** — HTTP + bearer, verified live              |
| 7b  | Autonomous ingestion trigger — completes a bonus       | **done** — fs.watch, verified on a scratch corpus    |
| 7c  | OIDC on the MCP server — completes a bonus             | **done** — consent forced, full flow verified        |
| 8   | Admin user management: list, add, role, deactivate     | **done** — lockout guards, revocation verified       |
| 8b  | Production config + deploy guide, hatko.tugrap.dev     | **done** — guide written; deploy is step 13          |
| 8c  | Audit of the four bonus features                       | **done** — `7350417`, 3 false claims corrected       |
| 9   | Rate limiting on search, answer and the MCP tool       | **done** — one allowance, 429 verified live          |
| 10  | Streaming answers — completes a bonus                  | **done** — SSE, verified live end to end             |
| 11  | Self-hosted models, OpenAI path stays default          | **done** — qwen2.5:7b 12/12, admin-selectable        |     |
| 12  | 3D embedding view on the dashboard                     | **done** — PCA, canvas, verified against the corpus  |
| 13  | Run the deploy against hatko.tugrap.dev                | **done** — verified end to end; instance now offline |
| 14  | README, AI usage log, history cleanup                  | **done** — README written, log kept per step         |
| 15  | First-run onboarding + model selection                 | **done** — checklist, dropdowns, verified in browser |
| 16  | Admin area split into sections, one page per subject   | **done** — routes, not tab state                     |
| 17  | Three offered models, and a cube that fits its frame   | **done** — availability intersected with presets     |
| 18  | One fewer panel, and a plot that says it can be turned | **done**                                             |
| 19  | Two section titles that restated their own contents    | **done** — `panels.tsx` deleted with them            |
| 20  | MCP tab, host list derived from what is enforced       | **done** — one allowlist function, pinned by a test  |
| 21  | Clicking a point opens the passage behind it           | **done** — native dialog, verified on the deployment |
| 22  | Evidence rail, stop control, Geist replaces Inter      | **done** — `61da4fa`, measured widths and contrast   |
| 23  | README rewritten for the evaluation, then humanized    | **done** — every figure re-measured before quoting   |

Step 3 lands **before** step 4 on purpose: retrieval is the top-graded axis, and
tuning should be driven by measured recall@k, not by impressions from a chat box.

Steps 7b, 7c, 8 and 8b were added on 17 Aug 2026 — see the note in §3. 7b and 7c
finish two bonuses that were already half-built, which is why they come before the new
feature: an incomplete thing already in the repository costs more to leave than a
missing thing nobody has started.

Steps 9 to 13 were added on 18 Aug 2026 — again see §3. The order is by risk, not by
appeal. Rate limiting is first because it is small, self-contained and closes the last
security gap. Self-hosted models come before the 3D view despite being less fun, because
they are the only step that can move a measured retrieval number, and a change to the
top-graded axis wants the most remaining time to be wrong in. The deploy is last, because
it ships whatever exists when it runs.

---

## 10. Conventions

**Code.** Zod schema first, type inferred from it — never a hand-written
interface duplicating a schema. Components consume semantic design tokens
(`bg-bg-raised`), never the raw scale (`bg-green-800`); that is what makes dark
mode a token swap instead of a per-component audit. Comments explain _why_, and
are worth writing only where the reason is not evident from the code.

**Commits.** Imperative subject under ~72 chars, blank line, body explaining the
reasoning and any trade-off accepted. No `Co-Authored-By` trailers — AI usage is
documented in `AI_USAGE.md`, which is where the graders look for it.

**Design.** [docs/design.md](docs/design.md) §11 is an anti-pattern list, and it
is enforceable. The two that get violated most: a shadow anywhere outside
overlays, and the abstain state styled as an error. The abstain state is the
product's most important behaviour — if it reads as a malfunction, the design has
undermined the engineering.

**Copy.** Plain and precise. State the fact before the feeling, numbers over
adjectives, no exclamation marks, no emoji in product UI. "No documents cover
this." — not "Sorry, I couldn't find anything!"
