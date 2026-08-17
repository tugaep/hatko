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

**Out — deliberately, do not build:**

- OIDC on the MCP server (plain bearer auth instead; say so plainly in the README rather than dressing it up)
- File watcher / self-updating ingestion (hash-diff idempotency yes; a watcher no)
- Live deployment (README section only)
- Admin user-management UI
- Streaming answers, result highlighting — only if the final hours are quiet

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

**No ANN index.** 142 chunks scan exhaustively in about 1 ms. An approximate
index would trade recall away for latency we do not need. Revisit two orders of
magnitude larger.

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
142 chunks is a fifth of the corpus. Candidate depth should scale with the corpus,
as a fraction rather than a constant. Pinned by a test in
`packages/core/src/retrieval/search.test.ts`.

**The reranker grades absolute relevance 0–3, not a ranking**, because abstention
depends on it. Fused scores cannot support a threshold: RRF is rank-derived, so
the top result scores the same constant whether it answers the question or is the
least bad of 142. Measured, answerable questions score 1.00 and unanswerable ones
at most 0.33, with the threshold at 0.67 between them.

---

## 6. Corpus facts that shape retrieval

The sample corpus is 142 files, ~17.7k words, ~24k tokens. The difficulty is
planted, not incidental:

- **78 near-identical delivery reports.** Measured: for "is hard-coding UI copy a
  QA blocker" the vector arm returns four delivery reports in its top five and
  misses the answer entirely, while the keyword arm puts it at rank 1. The lexical
  arm is what cuts through the crowding.
- **`sdk-notes-v2.md` is deprecated and semantically near-identical to `v3`.**
  Measured: BM25 ranks v2 _above_ v3 for sample question 2, because v2 mentions
  `lumen.track` more prominently than the document that replaced it. The rerank
  pass is what corrects it — no lexical or vector tuning can. Deprecation is detected at ingest, stored on
  the document, passed to the answer prompt, and surfaced in the UI. A correct
  answer to sample question 2 says v2 is deprecated.
- **Answers span documents.** `build-pipeline.md`, `incident-postmortem-2026-03.md`
  and `lumen-build-4.2.md` are three views of one incident.
- **Docs are tiny** — max 1030 bytes, mean 800. Measured: the chunker produces
  exactly one chunk per document, 142 for 142. That is deliberate, not a bug.
  `sample_questions.md` names expected answers as whole documents, so a
  document-sized passage is exactly the unit being evaluated, and splitting the 78
  delivery reports into interchangeable "## Sign-off" fragments would make the
  mush problem worse. The heading-split and merge logic is what keeps the same
  code correct on a corpus with longer files.
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

| #   | Step                                                 | Status                                         |
| --- | ---------------------------------------------------- | ---------------------------------------------- |
| 1   | Workspace, shared schemas, SQLite schema, migrations | **done** — `549c0b9`                           |
| 2   | Ingestion CLI → corpus indexed, runs recorded        | **done**                                       |
| 3   | Hybrid retrieval + rerank + eval script              | **done** — recall@1 100%, MRR 1.000            |
| 4   | RAG answers, citations, abstain path                 | **done**                                       |
| 5   | Better Auth, roles, server-side gating               | **done**                                       |
| 6   | Chat page, then dashboard                            | **done** — Next 16, light theme only, reviewed |
| 7   | MCP server                                           | **done** — HTTP + bearer, verified live        |
| 8   | README, AI usage log, history cleanup                |                                                |

Step 3 lands **before** step 4 on purpose: retrieval is the top-graded axis, and
tuning should be driven by measured recall@k, not by impressions from a chat box.

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
