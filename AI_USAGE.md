# AI usage

Built with Claude Code (Opus). This records how the work was actually divided,
and — more usefully — the places the AI was confidently wrong and what caught it.

Kept as the work happened rather than reconstructed at the end. A log written
afterwards records what you remember, which is mostly the parts that went well.

---

## How the work was divided

**I decided, the AI implemented.** Every architectural decision in
[CLAUDE.md §5](CLAUDE.md) was mine, made against options the AI laid out with
trade-offs: storage engine, whether to use an ORM, auth library, which bonus items
to attempt, whether to deploy. Where the AI recommended and I disagreed, I said so
and it built what I asked.

**I set the guardrails.** [CLAUDE.md](CLAUDE.md) exists because the failure mode
of AI-assisted work on a graded brief is not bad code, it is _plausible_ code that
drifts from the requirements. It records the grading axes, the locked scope
including the bonuses I declined, and a must-have checklist audited before every
commit. I asked for it explicitly, after noticing scope creep in the first step.

**The AI wrote most of the code and all of the tests**, under review. I read every
diff. Several were sent back — see below.

**Design direction was mine.** I specified a dark-green palette and a flat vector
packaging aesthetic; the AI developed it into
[docs/brand.md](docs/brand.md) and [docs/design.md](docs/design.md) and computed
the contrast ratios rather than asserting them, which caught two failing colour
pairs before any component was written.

**Measurement settled disagreements.** Twice the AI argued for a design and the
numbers contradicted it. Both times the numbers won; both are documented below.

---

## Where the AI was wrong

These are in rough order of how much damage they would have done.

### 1. Wrote passwords to the database in plaintext

The seed script is idempotent, so re-running it resets an existing account's
password. The AI implemented that with Better Auth's
`internalAdapter.updatePassword(id, password)` — which is the _storage_ step, not
the credential step: it writes the value it is given. Handed the raw password, it
replaced the scrypt hash created at sign-up with plaintext.

Nothing failed. Sign-in kept working, because verification compared a hash against
a value that happened to be sitting where a hash belongs. The only symptom was the
row itself.

**Caught by:** I asked for proof rather than accepting "seeding works", so the
verification step queried the `account` table for rows containing the literal
password. One did. On a security-graded case this is the single worst defect the
project has had, and it would have shipped invisibly.

**What changed beyond the fix:** the AI's first test for this did not actually
cover it — it created accounts through sign-up only, which hashes correctly, so the
broken path was never exercised. The upsert logic was pulled out of the CLI into
`auth/accounts.ts` specifically so a test could drive the update path, and there
are now assertions that no plaintext appears in either the `account` table or the
database file, for both the create and the update route.

### 2. Claimed hybrid retrieval was better, then measured it as worse

The AI argued at length that hybrid vector + BM25 retrieval would beat either arm
alone, with a plausible story: 78 near-identical delivery reports defeat pure
vector search, so the lexical arm rescues it. It wrote the module docstring
asserting that RRF's `k=60` was "the value from the original paper and is not
corpus-specific."

The first live measurement said otherwise:

```
arm       recall@1  recall@3   MRR
keyword     89%      100%     0.944
vector      67%       89%     0.759
hybrid      78%       89%     0.833   ← worse than one arm alone
```

RRF sums `1/(k+rank)` across arms, so a passage ranked 20th by _both_ arms
(1/80 + 1/80 = 0.025) beat one ranked 1st by a _single_ arm (1/61 = 0.016).
`localization-guide.md` sat at keyword rank 1 and fell outside hybrid's top 30
entirely. `k=60` is calibrated for TREC runs fusing ~1000 candidates; 30 of 142
chunks is a fifth of the collection.

**Caught by:** the eval script, which I insisted be built and run _before_ the
chat UI so tuning would be driven by recall numbers rather than by impressions
from a chat box. Sweeping both constants fixed it — candidate depth mattered more
than `k` — and hybrid now ties keyword at recall@1 100%, MRR 1.000.

**What I made it write down:** that hybrid _ties_ rather than beats, and why we
keep it anyway (insurance for vocabulary the corpus does not use, against an
unseen private eval set). The first draft of that comment quietly implied hybrid
had won.

### 3. Wrote a deprecation detector that would have flagged the wrong document

`sdk-notes-v2.md` is deprecated; `sdk-notes-v3.md` is current and says _"It
supersedes v2."_ A regex matching "supersede" anywhere flags **v3** — inverting
exactly the distinction sample question 2 exists to test, and silently: retrieval
still works, the wrong document just wears the badge.

**Caught by:** writing the test against the real corpus text before the
implementation was accepted. Only the passive direction now matches, asserted in
both directions.

### 4. Built a category enum from the sample corpus's folder names

`documentCategorySchema` was written as `z.enum(['guides', 'changelogs', ...])`.
Both `TASK.md` and `RULES.md` require that pointing ingestion at the _real_ corpus
be straightforward — and this would have failed validation on every document in a
corpus organised differently.

**Caught by:** the must-have audit before committing step 1. This is the concrete
reason that checklist exists, and it is now drift rule #1.

### 5. Tried to fix a requirement with prompt engineering, three times

`sample_questions.md` requires that a good answer to question 2 says v2 is
deprecated. The AI's answer was correct but never mentioned it. It rewrote the
system prompt three times — strengthening the instruction, making it
unconditional, promoting it to rule #1 in a numbered list — and the model kept
declining, answering correctly from v3 while omitting the deprecation.

The AI had itself written, in that same file's docstring: _"A prompt can be
ignored by the model; a check on its output cannot."_ Deprecation is known for
certain at ingest time. It did not need to be requested from a model at all.

**Caught by:** manually running the sample questions through the CLI instead of
trusting the eval, which measured retrieval rank and reported success while the
actual requirement failed. `deprecationNotices` is now computed from ingest
metadata and returned as a typed field; the prompt rule stays only as a redundant
second path.

**What this changed:** the eval measures retrieval, not answers. That gap is real
and still open — noted in "known gaps" below.

### 6. Wrote a test that leaked my live API key into the terminal

A settings test asserted "no key is configured". `config.ts` loads `.env` from
disk regardless of shell environment, so once I added a real key the test found
it, failed, and printed the key in full in the assertion diff.

**Caught by:** running the suite after adding the key. The AI flagged it
immediately and unprompted, and told me to rotate the key — which I did. The
environment fallback is now an explicit parameter, so the test cannot read
ambient state.

### 7. Built ahead of the agreed scope

Step 1 shipped a streaming-answer schema and a `users:manage` permission. Both
belong to bonus items I had explicitly declined. Small — about ten lines — but
they imply features that will not exist.

**Caught by:** the same must-have audit. Now drift rule #2: _a schema for an
unselected bonus is drift even when it costs ten lines._

### 8. Estimated 450 chunks; the real number is 142

Carried as an assumption from the first corpus analysis into schema comments and
the working agreement, then repeated back to me as if measured. The chunker
produces exactly one chunk per document, because every file is smaller than the
chunk target.

**Caught by:** actually measuring it before writing the commit message. The
figures are corrected everywhere they appeared. The outcome turned out to be
_correct_ — `sample_questions.md` names expected answers as whole documents — but
it was right by luck, not by design, until it was measured.

### 9. Its own tooling polluted the provided dataset

The claude-mem plugin wrote `CLAUDE.md` context stubs into `sample_dataset/` and
`sample_dataset/corpus/`, and they were committed with the initial scaffold. The
corpus copy would have been ingested as a 44-byte document, corrupting document
counts in a dataset I am not supposed to modify.

**Caught by:** a file listing during step 2 that showed 143 markdown files where
the corpus has 142. Removed, and the path is now gitignored.

**This fix was incomplete, and the review below caught the recurrence.** Gitignoring
the path stops the file being _committed_; it does nothing to stop it being
_ingested_. The plugin recreated `sample_dataset/corpus/CLAUDE.md` twice during the
step 1–5 review, and both times ingestion indexed it as a document. See defect 8.

---

## Smaller corrections

- **Circular import.** `migrate.ts` held a CLI entrypoint that dynamically
  imported `client.ts`, which statically imports `migrate.ts`. It hung on the
  top-level await instead of failing. Split into a separate entrypoint file.
- **Prettier changed the meaning of a sentence.** A line-wrapped `+` between
  filenames was reparsed as a markdown list bullet. The formatter reported success
  while altering the content. Caught on read-back.
- **Two SQL constraints the AI got wrong first time**, both found by running the
  query rather than by review: `bm25()` is an FTS5 auxiliary function and cannot
  be called inside a window function's `ORDER BY`; and `node:sqlite` binds plain
  JavaScript numbers as doubles, so `vec0` rowids must be `BigInt`.
- **A test that could not fail.** The first plaintext-password test exercised only
  the code path that already worked. A test aimed at a bug has to run the code that
  had the bug — obvious in hindsight, and it took a second look to notice.
- **A test asserted the wrong premise twice.** Once assuming the porter stemmer
  conflates `built`/`building` (it does not — irregular verbs are not stemmed),
  once assuming "glyph" was unique to one document (it appears in 14). Both were
  bad assertions, not bad code; both were rewritten to test the real property.

---

## What AI was genuinely good at

Being fair about this matters as much as the failures.

- **Adversarial test design.** Left to myself I would have tested that retrieval
  works. It wrote tests for what fails _silently_: a delete reaching three
  physical stores where only one is covered by the foreign-key cascade; an
  abstention distinguishing "judged irrelevant" from "never judged" so a provider
  outage cannot become a confident claim about the corpus.
- **FTS5 query construction.** It identified unprompted that a plain question is
  usually _invalid_ FTS5 — bare `AND`/`OR` are operators, an unbalanced quote is a
  syntax error — and tested the generated expressions against a real FTS5 table
  rather than asserting on strings.
- **Volume with consistency.** 85 tests, uniform error handling, and comments
  that explain _why_ rather than restating the code.

---

## Known gaps

Stated plainly rather than left to be discovered.

- ~~**The eval measures retrieval, not answer content.**~~ Closed in `e479f6c`.
  `--answers` now asserts required phrases, abstention on unanswerable questions,
  and that every citation resolves to a retrieved document. 12/12 pass.
- **The vector arm's contribution is unproven on unseen queries.** It ties
  keyword-only on this eval set, where questions share vocabulary with their
  answers. Its value is a hypothesis about the private set.
- **No rate limiting on the paid endpoints.** Search and answer both call the
  model provider, and an authenticated user can call them as fast as they like.
  Not required by the brief, and not built.
- **The rerank grade threshold is calibrated on 12 questions.** Separation is
  clean today (answerable 1.00, unanswerable ≤0.33, threshold 0.67) but that is a
  small sample.

---

## Audit of steps 1–5 (17 Aug 2026)

Before starting step 6 I had Claude audit everything already built, with an
explicit brief: find instability, find anything that only works on the sample
corpus, and find mock implementations written to satisfy the evaluation rather than
the requirement. It is AI reviewing its own prior output, which is worth
discounting — so the rule was that no finding counts unless it is reproduced by
something actually run.

What was run: `npm run typecheck` and `npm test` (115 pass); the eval across all
three arms, with and without rerank, plus `--answers` against the live provider; a
fresh-machine bootstrap (`db:migrate`, `seed`, `ingest`) into an empty database;
the API booted and driven over HTTP with `curl` as anonymous, `user` and `admin`;
and five throwaway probe scripts covering ingestion, retrieval, the answer path,
auth and the shared SQLite connection.

### What held up

Recording this first, because most of it did.

- **The documented retrieval numbers reproduce exactly.** With the rerank pass:
  keyword 100% recall@1 / MRR 1.000, vector 89% / 0.889, hybrid 100% / 1.000. The
  relevance separation the abstain threshold depends on also reproduces —
  answerable questions 1.00, unanswerable 0.00–0.33, threshold 0.67 between them.
  Numbers claimed in a docstring that turn out to be real is not the default.
- **12/12 answer checks pass live**, including all three abstentions.
- **No mock implementations in production code.** Every corpus-specific string in
  `packages/` and `apps/` outside tests is a comment explaining a decision; there
  is no special-casing of the sample questions, no hardcoded answer, no `TODO`. The
  stub embedders, graders and generators are injected through typed options used
  only by tests and the eval, which is dependency injection, not a mock in the
  shipping path.
- **Session forgery fails.** Flipping the token's last character, stripping the
  signature, replacing the signature, and an empty token all return 401.
- **Authorization is decided server-side, per request.** The role is read live from
  the database, so downgrading an admin mid-session takes effect on the next call.
  `role` in a sign-up body is ignored (`input: false`), and a hand-edited unknown
  role is refused by a CHECK constraint before the code's fail-closed fallback is
  even reached.
- **The shared single SQLite connection is safe.** This was the review's main
  stability worry: Better Auth writes through the same connection ingestion holds
  transactions on, and node:sqlite cannot nest them. Tracing `BEGIN`/`COMMIT`
  during sign-in and sign-up showed Better Auth issues no transactions at all, and
  two deliberately concurrent ingests left documents, chunks and vectors
  consistent — the write phases are synchronous, so they cannot interleave
  mid-transaction. Safe, and now known to be safe rather than assumed.
- **Citation validation holds** against 12 hostile answer shapes, including a
  prompt-injection document planted in the corpus that instructed the model to cite
  `[99]`. The marker was stripped; no fabricated citation reached the response.
- **The abstention decision table is correct on all eight paths**, including the two
  that matter most: a model that cites nothing abstains, and a grader outage does
  _not_ abstain.
- Encryption round-trips 4000-character and emoji keys, rejects tampering loudly,
  and leaves no plaintext in the database file. Every hostile FTS5 input is either
  safely quoted or correctly null — the corpus survived a `DROP TABLE` attempt.
  Ingestion idempotency, pruning across all three stores, and empty- and
  unreadable-file handling all behave as documented.

### Defects found

Ordered by how much damage they would do. None were known before the audit.
**Defects 1–6 are fixed** (see "Fixes" below); 7–13 are recorded and open.

**1. Anyone can create an account and read the entire internal corpus.**
`POST /api/auth/sign-up/email` is open. Verified over HTTP: a stranger registered
and immediately searched the corpus successfully. Roles are enforced correctly —
the gap is the authentication boundary, not authorization. For an internal document
system with two documented demo accounts, nothing needs self-service sign-up.

**2. The placeholder secret shipped in `.env.example` is accepted as the session
signing key.** `settings.ts` refuses `PLACEHOLDER_SECRET` explicitly; `authSecret()`
in `auth/index.ts` only checks length, and the placeholder is 39 characters.
Verified: copying `.env.example` to `.env` unchanged yields working sign-in with
sessions signed by a secret published in the repository. Two guards against the
same mistake, and the one protecting sessions is the one that does not fire.

**3. A malformed request body returns 500, not 400.** `/api/search` and
`/api/answer` call `searchRequestSchema.parse(await c.req.json())`; `c.req.json()`
throws a `SyntaxError`, which is not a `ZodError`, so it reaches the generic
handler, logs a stack trace and returns `internal`. Verified over HTTP for both
routes. `/api/admin/ingestion/run` already guards this with `.catch(() => ({}))`,
so the fix pattern exists in the codebase and was simply not applied here. A client
error reported as a server fault on a graded error-handling axis.

**4. `npm run ingest -- --force` and `npm run eval -- --rerank --answers` silently
do nothing.** The root scripts lack the trailing `--` that `ask` has, so npm
swallows the flags and emits only a warning. Verified: `npm run ingest -- --help`
prints _npm's_ help, not the CLI's. Every documented flag on the top-graded axis is
inert from the repository root — the eval numbers in this file can only be
reproduced by invoking the workspace script directly, which nobody would guess.

**5. Ingestion indexes every `.md` under `CORPUS_PATH` with no exclusion list.**
Demonstrated twice during the audit: a 43-byte tool-generated
`sample_dataset/corpus/CLAUDE.md` was ingested as a retrievable document titled
"CLAUDE", and the corpus counted 143 instead of 142. Gitignoring it was the wrong
layer. Any real documentation tree containing a `README.md` or a `CONTRIBUTING.md`
hits this, and "pointing ingestion at the real corpus is straightforward" is a
stated requirement.

**6. A document that fails during the write phase leaves no trace if it is new.**
`markDocumentFailed` is only reached when the pre-run snapshot has the path, and the
`upsertDocument` inside the failing transaction is rolled back with it. Verified: a
run reported `docsFailed=2` while only one document appeared as failed anywhere in
the database. The read phase has the same gap. Ingestion is required to be
observable, and this is the case where it silently is not.

**7. `getApiKeyStatus` reports a healthy key for a value that cannot be decrypted.**
It never attempts decryption, so after a `BETTER_AUTH_SECRET` rotation the admin
screen shows `configured: true, source: 'database'` while every provider call
throws. `resolveApiKey` was carefully written to fail loudly here; the status
endpoint beside it still says everything is fine. The test named _"reports rotation,
not unset"_ only asserts that `resolveApiKey` throws — no code reports a rotation
state, and `SecretStatus` has no way to express one.

**8. The 7-day and 14-day analytics windows compare mismatched date formats.**
`created_at` is stored as `2026-08-17T08:00:00Z`; the comparison is against
`datetime('now','-7 days')`, which returns `2026-08-10 08:00:00` — space separator,
no `Z`. Since `'T' > ' '`, rows up to a day older than the cutoff are included.
Verified: a row 7 days 6 hours old is counted by the shipped query and correctly
excluded by the `strftime('%Y-%m-%dT%H:%M:%SZ', ...)` form.

**9. `durationMs` is quantised to whole seconds and reports 0 for any run under a
second.** Both `started_at` and `finished_at` use second-resolution `strftime`. The
live database has a real run recorded at 0 ms, and the CLI prints "0.0s" for an
ingest that did measurable work. It is a dashboard field.

**10. Category-filtered search runs in the RRF regime this project documents as
pathological.** `poolSize = max(candidates * 4, 100)` draws 100 of 142 chunks per
arm, where the tuning notes record that a 30-of-142 pool dropped recall@1 from 89%
to 78% for exactly the reason described — mediocre-in-both beating first-in-one.
The filter returns correct documents; its ranking is untuned and has no eval
coverage.

**11. Admin document search treats `%` and `_` as wildcards.** `q=%` returns all 142
documents, `q=_` likewise. Parameterised, so not injectable — the comment claiming
so is right — but the user's literal text is not matched literally. Needs an
`ESCAPE` clause.

**12. `maxChars` is not a ceiling, and an oversized section emits a junk chunk.** A
single 10,000-character sentence yields one 10,000-character chunk, which is the
deliberate "never split mid-sentence" trade-off; less deliberately, the split also
emits the bare heading line as a separate 3-character chunk that then gets embedded
and indexed. Never fires on this corpus, where nothing is oversized — which is
precisely why it went unnoticed.

**13. p95 latency under-reports at small N.** `CAST(total * 0.95 AS INTEGER) - 1`
gives offset 0 for two rows, returning the _minimum_ as the 95th percentile.
Correct from roughly 20 rows up.

### Redundancy and coupling

- **`search_queries_user_idx2` duplicates `search_queries_user_idx`** — byte-for-byte
  the same index on `(user_id)`, both present in the live schema. Migration 003 adds
  it to document that a foreign key was deliberately omitted. A SQL comment says
  that; an index carries it as dead weight.
- **Eval fixtures are exported from the core public barrel.** `EVAL_QUESTIONS`,
  `ANSWERABLE` and `UNANSWERABLE` are part of `@sorrel/core`'s API, so the API app
  ships the evaluation set.
- **A configuration error is classified by regex on its message.** `errors.ts`
  matches `/API key/i` and maps it to 400 `bad_request` — a server misconfiguration
  reported as the client's fault, via string matching where `ProviderError` shows
  the typed pattern already understood in this file.
- **Importing `@sorrel/core` at all requires `BETTER_AUTH_SECRET` and opens the
  database.** The barrel re-exports `auth/index.ts`, which calls `betterAuth({...})`
  at module scope. A consumer that only wants `hybridSearch` inherits both. Step 7's
  MCP server is exactly that consumer.

### Fixes for defects 1–6

Fixed because they are cheap, two are security, and two bear on stated
requirements. The remaining seven are recorded above and triaged against the
timebox, not silently dropped.

**1. Sign-up closed.** A route registered ahead of the Better Auth mount rejects
`/api/auth/sign-up/*` with 403. Not Better Auth's `disableSignUp`, because that flag
also disables `auth.api.signUpEmail` — the call the seed script makes, and the one
account-creation path whose password hashing is pinned by a test after failure #1 in
this file. Closing the public door should not mean rebuilding the tested way in.

**2. One gate for the application secret.** `requireAppSecret()` in `config.ts` is
now the single check, called by both Better Auth's `secret` and the settings
encryption key. Net less code than the two divergent guards it replaces. The secret
is a parameter defaulting to `config.appSecret`, mirroring `resolveApiKey`, so the
test drives it instead of depending on the developer's `.env`.

**3. Malformed bodies answered as 400.** A `jsonBody(c)` helper in `errors.ts`
converts the `SyntaxError` into `bad_request`. Applied to the three routes that
require a body; `POST /admin/ingestion/run` keeps its default-on-empty behaviour,
which is a deliberately different rule rather than the same bug.

**4. Root scripts forward their flags.** Added the trailing `--` that `ask` already
had to `ingest` and `eval`. `npm run eval -- --rerank --answers` now works, which
means the numbers quoted in this file are reproducible by the documented command.

**5. Ingestion excludes tooling that shares the corpus directory.** `scanCorpus`
skips any hidden path segment plus `node_modules` and `CLAUDE.md`, and returns the
excluded paths so the run names them — an exclusion nobody can see is
indistinguishable from a document that failed to index, which is how the original
went unnoticed. `node_modules` is the entry that matters: pointing `CORPUS_PATH` at
a repository is supported, and the documentation tree inside one has thousands of
dependency READMEs.

Deliberately **not** excluding `README.md`. In a real documentation tree a README is
often genuine content, and silently dropping it would be a worse bug than the one
being fixed. Everything on the list is unambiguously tooling. No setting for it
either: the seam is the function's parameter, and a `CORPUS_IGNORE` variable for a
requirement nobody has stated yet is a guess dressed as flexibility.
`listCorpusFiles` was deleted rather than kept as a wrapper once nothing called it.

**6. A failure on a document new this run is now recorded.** One `recordFailure`
helper upserts the row and marks it failed, called from all three failure paths.
Two things made this invisible: the read path only recorded failures for documents
already on record, and the write path's `upsertDocument` was rolled back by the very
transaction whose failure it was meant to record — so it now runs after the
rollback, on a clean connection. A document already on record still keeps its stored
title, category and hash, because overwriting them with placeholders would discard
what the last good ingest learned. The placeholder's content hash is empty, which
can never equal a real one, so a failed document is always retried rather than
mistaken for current.

Verified over HTTP against the running server, not just in-process: sign-up returns
403 and creates no row, sign-in still works, both body routes return 400 with no
stack trace logged, and search and answer still return grounded cited results. The
placeholder secret now aborts start-up with instructions for generating a real one.

Defects 5 and 6 were verified against the pre-fix commit in a scratch worktree
rather than by assertion, since a regression test that would also have passed before
the fix is worth nothing. With strays present the old tree indexed 144 documents
including `CLAUDE.md` and a dependency README, and reported two failures with one
visible; the new tree indexes 142, names the exclusion, and reports two failures with
two visible.

Six tests added, 121 pass. The two route tests exercise the API through
`app.request` with real bodies — the gap that let defects 3 and 4 through was that
every existing test called the code directly rather than the way a person would.

### What this says about the review discipline

Nine of the thirteen defects are things that cannot happen on the sample corpus:
oversized sections, corpora containing a `README.md`, sub-second timing precision,
analytics tables with enough rows for a percentile to mean anything. The tests are
strong — 115 of them, aimed at silent failure rather than coverage — and they pass,
because they test the corpus the system has. Defects 3 and 4 are different and worse:
a 500 on malformed input and two documented commands that do nothing are both on the
happy path of a reviewer's first ten minutes, and no test covers either because
every test calls the code directly rather than the way a person would.
