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
**All thirteen are fixed** (see "Fixes" below).

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
  `ANSWERABLE` and `UNANSWERABLE` are part of `@hatko/core`'s API, so the API app
  ships the evaluation set.
- **A configuration error is classified by regex on its message.** `errors.ts`
  matches `/API key/i` and maps it to 400 `bad_request` — a server misconfiguration
  reported as the client's fault, via string matching where `ProviderError` shows
  the typed pattern already understood in this file.
- **Importing `@hatko/core` at all requires `BETTER_AUTH_SECRET` and opens the
  database.** The barrel re-exports `auth/index.ts`, which calls `betterAuth({...})`
  at module scope. A consumer that only wants `hybridSearch` inherits both. Step 7's
  MCP server is exactly that consumer.

### Fixes for defects 1–13

Two are security, the rest bear on stated requirements, and all were cheap enough
that triaging them out would have cost more argument than code.

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

**7. `getApiKeyStatus` decrypts before claiming a key is usable.** A stored value
that will not decrypt now reports `source: 'unreadable', configured: false` — a
state the type could not previously express, which is why the status disagreed with
`resolveApiKey` beside it. It is distinct from `unset` because the remedy differs
(re-enter the key, or restore the old secret) and distinct from `database` because
nothing usable is configured. The hint survives, so an operator can still tell which
key is stuck there, along with when and by whom it was set. The existing test was
named _"reports rotation, not unset"_ and asserted nothing of the kind; it now
asserts the state its name promised.

**8. The rolling analytics windows compare like with like.** One `cutoff()` helper
emits `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', …)`, the same format the timestamps are
written in, used by both the 7-day count and the 14-day chart so they cannot drift
apart again. The interval is a literal from the two call sites, never user input.

**9. Ingestion measures its own duration.** Migration 004 adds `duration_ms`, filled
from `performance.now()` in the pipeline. Storing a measurement beats widening the
timestamp format for two reasons: SQLite cannot alter a column DEFAULT without
rebuilding the table, and the difference between two stored wall-clock strings is the
wrong source for an elapsed time at any precision, because it moves if the system
clock does. Rows predating the migration keep a NULL and fall back to the old
subtraction, so historical runs report the coarse figure they were recorded with
rather than losing it.

The existing assertion here was `durationMs >= 0`, which 0 satisfies — a test that
could not fail, on the exact value that was wrong. It now requires a cold ingest of
142 documents to report more than zero.

**10. The category filter draws a complete pool — and the obvious fix for it was
measured, and thrown away.** This one deserves the space, because the first attempt
repeated failure #2 above almost exactly.

The filter runs after fusion, so the pool has to be drawn wide and the surplus
discarded. The reasoning that followed was tidy: the ranks feeding RRF come from a
pool spanning every category, filtering leaves gaps in them, so renumber the
survivors densely and a filtered search behaves like an unfiltered one over that
category. It was also wrong, and there is no eval question with a category filter, so
one had to be written — nine answerable questions, each restricted to the category its
expected document lives in:

```
                                         recall@1  recall@3   MRR
before                                      44%      100%    0.648
dense renumbering (the tidy argument)       22%       67%    0.431   ← much worse
share-scaled pool, global ranks             44%      100%    0.648
complete pool, global ranks                 44%      100%    0.667   ← shipped
```

Renumbering destroys the thing RRF runs on. Its discrimination lives in the _size_ of
the rank gaps — a passage at keyword rank 1 against one at rank 40 is `1/11` against
`1/50` — and compressing 142 positions into 10 leaves every candidate within a factor
of two of every other, so near-ties decide the ordering instead of relevance. The
argument was sound about the gaps in the ranks and wrong about the remedy.

What shipped is smaller: when a category is given, draw every chunk. Ranks stay
global. That buys no measurable accuracy — MRR moves 0.648 to 0.667 on nine questions,
which is one document moving one place — but it closes a real hole. The old
`max(candidates * 4, 100)` dropped any in-category passage ranking below 100th across
the corpus, and the regression test for it returns **0 results** against the old code
for a category that plainly contains a match. On a small category in a large corpus
that is the normal case, not the edge. The ceiling is a full scan, which at 142 chunks
is the trade already accepted in having no ANN index; the upgrade is a vec0 partition
key on category, which needs a migration and a re-insert of every vector.

**11. Document search escapes LIKE wildcards.** The user's text was bound, so it could
never alter the statement — the comment saying so was right, and stopped one step
short. LIKE reads `%` and `_` in the _value_, so searching for `_` returned every
document and `sdk_notes` matched `sdk-notes-v2.md` through the wildcard. Escaped, with
`ESCAPE '\'` declared.

**12. `maxChars` is a ceiling now, and a heading is not a passage.** Preferring
paragraph and sentence boundaries is a quality choice; when no such boundary exists the
old code gave up and emitted the section whole, so a single 10,000-character sentence
became a single 10,000-character chunk. That is not a rounding problem —
text-embedding-3-small accepts 8192 tokens, so an oversized chunk is a request that
fails and a document that never gets indexed. There is now a word-boundary fallback
below sentences, and a hard cut below that for a single unbroken token like a URL or a
base64 blob. Separately, a heading line is its own paragraph and was being flushed as a
standalone chunk — a 3-character passage reading `# T`, embedded and indexed as though
it were prose — so it is glued to the text it labels before packing.

Balanced piece sizes were tried too, to stop greedy packing leaving the remainder in a
short trailing chunk. Measured across four pathological inputs it produced more chunks
and _introduced_ a runt in the one case that previously had none, so it was dropped —
the same discipline as defect 10, on a much smaller question. The residual is recorded
in the code: a very long paragraph can still leave a short tail, and a heading followed
by one unbroken multi-kilobyte token still orphans the heading, because there is no
boundary at which anything could pack with it. Low-value passages rather than incorrect
ones, on input no prose corpus produces.

**13. p95 uses nearest rank.** The offset was `CAST(N * 0.95 AS INTEGER) - 1`, which
truncates instead of rounding up and pointed one row too low — at two samples it
reported the _minimum_ latency as the 95th percentile, wrong in the flattering
direction on the one figure whose job is to show when things are slow. Now
`ceil(0.95 * N) - 1`, computed in TypeScript because `total` is already known there and
SQLite's `ceil` depends on a build-time math extension.

Verified over HTTP against the running server, not just in-process: sign-up returns
403 and creates no row, sign-in still works, both body routes return 400 with no
stack trace logged, and search and answer still return grounded cited results. The
placeholder secret now aborts start-up with instructions for generating a real one.
Through the admin route, a rotated secret turns
`{"configured":true,"source":"database"}` into
`{"configured":false,"source":"unreadable"}`. On the live database, migration 004
applied cleanly and the next real ingest recorded 1919 ms where every previous run
recorded 0.

Defects 5 and 6 were verified against the pre-fix commit in a scratch worktree
rather than by assertion, since a regression test that would also have passed before
the fix is worth nothing. With strays present the old tree indexed 144 documents
including `CLAUDE.md` and a dependency README, and reported two failures with one
visible; the new tree indexes 142, names the exclusion, and reports two failures with
two visible.

Sixteen tests added, 131 pass, including the first coverage of the dashboard analytics
and of category-filtered retrieval, neither of which had any. The chunker edits leave
the sample corpus byte-identical — still 142 documents, 142 chunks, longest 1029
characters — because every path they touch is one this corpus never takes.

Three of these fixes landed on assertions that could not fail: `durationMs >= 0` on a
value that was always 0, a test whose name described a state the code never produced,
and — my own, written during this pass — a category-filter regression test that
passed against the broken code because the stubbed embedder orders the vector arm at
random and found the buried document by luck. That one is the most instructive,
because I wrote it _while_ thinking about this exact failure mode and still shipped
it. It is now pinned to the keyword arm, where BM25 over the fixtures is
deterministic, and it fails against the old code.

A passing test is evidence only if it would have failed. So every fix from 5 onward
was checked against the pre-fix behaviour rather than trusted: in a scratch worktree
for the ingestion pair and the retrieval pool, and by running the old and new SQL side
by side over identical rows for the window comparison, where the old form counted
three and the new one two.

One trap worth recording: the scratch worktree needs the repository's `node_modules`
symlinked in to resolve workspace packages, and that symlink points `@hatko/core`
back at the _fixed_ tree. A "before" run of anything importing `@hatko/core` by
package name therefore tests the new code while looking like it tests the old. It
caught me on the LIKE-escaping check, which passed in the worktree; the real
comparison imports the pre-fix modules by absolute path, and there `%` and `_` matched
every document.

### What this says about the review discipline

Nine of the thirteen defects were things that cannot happen on the sample corpus:
oversized sections, corpora containing a `README.md`, sub-second timing precision,
analytics tables with enough rows for a percentile to mean anything. The tests are
strong — 115 of them, aimed at silent failure rather than coverage — and they pass,
because they test the corpus the system has. Defects 3 and 4 are different and worse:
a 500 on malformed input and two documented commands that do nothing are both on the
happy path of a reviewer's first ten minutes, and no test covers either because
every test calls the code directly rather than the way a person would.

---

## Second audit of steps 1–5 (17 Aug 2026)

A second pass over the same five steps, run after the fixes above had landed, with
the same brief and the same rule: no finding counts unless something actually run
reproduces it. It exists because the first audit was AI reviewing its own output
and I did not want to take "all thirteen fixed" on trust.

What was run: `npm run typecheck` and `npm test` (131 pass, 0 fail); the eval across
all three arms with and without `--rerank`, and `--answers` against the live
provider; the API driven end to end through `app.request()` as anonymous, `user`
and `admin`; and six throwaway probe scripts covering the chunker, the FTS query
builder, hybrid retrieval, the ingestion pipeline, the analytics queries and
symlink handling.

Nothing from defects 1–13 regressed. Nine new defects, none overlapping the first
set. **None of these are fixed yet** — they are recorded here and triaged below.

### What held up, re-verified

- **The documented retrieval numbers still reproduce exactly.** With `--rerank`:
  keyword 100% recall@1 / MRR 1.000, vector 89% / 0.889, hybrid 100% / 1.000.
  Without it, 89% / 67% / 78%. The docstring in `search.ts` says "with the rerank
  pass" and means it — the table is not quietly reporting the best run.
- **12/12 answer checks pass live**, including all three abstentions.
- **The abstain threshold's margin reproduces**: answerable 1.00, unanswerable
  0.00–0.33, threshold 0.67.
- **Still no mock implementations in production code.** Every `stub`/`fake` in the
  tree is in a `.test.ts` file or injected through a typed option; nothing in
  `packages/` or `apps/` special-cases the sample questions.
- **Authorization survived every escalation I could construct**: a `role=admin`
  cookie appended to a user session, `role` in a sign-in body, a forged session
  token, and `__proto__` in a search body all fail closed. 401 and 403 stay
  distinct on every route. Sign-up is refused on `/sign-up/email`, `/sign-up`,
  `/sign-up/`, with a query string, and through `x/../sign-up/email`.
- **Boundary validation is complete on the HTTP surface.** Query too short, too
  long, non-numeric `limit`, `limit=999`, `offset=-1`, `null` and `[]` bodies,
  non-JSON bodies and `id` values of `0`, `-1`, `abc` and `1e999` all return 400
  with field-level detail. None reached the retriever.
- **LIKE escaping holds** — `%`, `_` and `\` each return 0 documents, not 142.
- **The chunk ceiling holds under pathological input**: a 5000-character unbroken
  token at `maxChars=100` produces 51 chunks and none over the ceiling.
- **The three stores stay in step** at 142/142/142, ingestion accounting balances
  (indexed + updated + skipped + failed = total), and a file deleted between scan
  and read is recorded as failed rather than lost.
- **p95 nearest-rank is now right**: ten samples of 10–90 and 1000 report p95 =
  1000, not the minimum.

### Defects found

**14. A directory name longer than 64 characters permanently bricks the system.**
The worst thing in this pass by a wide margin. `documentCategorySchema` is
`z.string().min(1).max(64)`; the category is the corpus's top-level directory name
and the write path is raw SQL that never applies the schema. So ingestion reports
success — verified, `indexed 2 failed 0` — and from that moment every read path
that parses a document row throws a `ZodError`: `listDocuments`,
`listDocumentsFiltered`, `getDocumentsBySourcePath`, `getDashboardStats`, and
`hybridSearch`, which parses through `searchResultSchema`. User-facing search
included. The next ingest run throws too, at `getDocumentsBySourcePath`, so it
cannot heal itself; recovery means hand-editing the database. And because
`errors.ts` maps `ZodError` to 400 `bad_request`, a user whose search just broke is
told _their request_ could not be validated. A 68-character folder name is
unremarkable in a real documentation tree, and "point `CORPUS_PATH` at the real
corpus" is a stated requirement. The asymmetry is the lesson: rows are validated on
the way out of the database and not on the way in, so the schema turns a bad write
into an unrecoverable read.

**15. `scanCorpus` follows symlinks, so the corpus boundary is not a boundary.**
Two verified consequences. A directory symlink pointing outside `CORPUS_PATH`
indexes the files behind it — a `linked -> ../private` symlink put `salaries.md`
into the index under category `linked`, and it appeared in neither the file list nor
the `ignored` list. A self-referential symlink yields the same document sixteen
times under sixteen distinct paths (`loop/loop/.../real.md`), which is sixteen
embeddings paid for and sixteen interchangeable results. This is the same class of
defect as #5 — a foreign file reaching the index — and the exclusion list added to
fix that one does not cover it.

**16. A fenced code block containing a `#` comment is split as if it were a
heading, and the chunk stops being verbatim.** `HEADING_RE` is applied line by line
with no fence tracking. Verified on a runbook containing ` ```sh ` and
`# install dependencies`: the fence is torn across two chunks, the first ending on
an unclosed ` ```sh `; the enclosing `## Setup` heading is lost, because the
comment registers as level 1 and `headingForGroup` returns null for any group
reaching the document top; and the rejoin inserts a blank line, so 150 source bytes
come back as 152. `RawChunk.content` is documented as a "verbatim slice of the
source document" and the schema comment says "what is displayed is what was
written" — both stop being true. The sample corpus contains zero code fences, which
is exactly why it went unnoticed, and an internal documentation corpus with
runbooks in it is the case the brief asks the system to handle.

**17. A byte-order mark defeats title and heading detection.** `﻿# Titled` does
not match `/^#\s+(.+?)\s*$/m`, so `titleOf` falls through to the humanised filename
— verified, `bom.md` was titled "Bom" rather than "Titled" — and `HEADING_RE` misses
the same line, so the document becomes one level-0 section and
`buildEmbeddingText` prefixes a filename-derived title instead of the real one. A
BOM is what Windows tooling and Confluence exports produce. One `.replace(/^﻿/, '')`
in `readDocument` closes it.

**18. Response contracts are declared and never enforced.** `searchResponseSchema`,
`answerResponseSchema` and `sessionResponseSchema` exist in `@hatko/shared` and no
route parses against them. Verified by mutation: renaming `results` to `resultz` in
the `/api/search` response passes `npm run typecheck` clean, because `c.json()`
accepts any object. The inbound direction is strict — every database row goes
through `documentSchema.parse` — so the enforcement is one-directional, and it is
the direction the browser does _not_ depend on. `getDashboardStats` is the
exception and does parse its output. "Shared types across the frontend/backend
boundary" is a graded criterion, and right now the shared types describe the
boundary rather than holding it.

**19. `npm run ask -- "question" --limit=abc` answers "No documents cover this."**
`Number(values.limit)` yields `NaN`, `slice(0, NaN)` yields zero passages, and
`answerQuestion` abstains. Verified. A malformed CLI flag produces a confident false
statement about the corpus, which is the single behaviour the working agreement
names as the product's most important. The HTTP path is safe — `searchRequestSchema`
coerces and bounds `limit`, and `answerRequestSchema` has no `limit` at all — so
this is CLI-only, and the fix is the argument check the eval CLI already does for
`--k`.

**20. Two concurrent ingestion runs each claim to have indexed everything.** Both
read the pre-run snapshot before either writes, so `isUpdate` is false in both and
five documents are reported as ten indexed. Verified: two overlapping runs, both
`succeeded idx=5 upd=0`. The data is fine — chunks, vectors and FTS rows all end at
5, confirming the first audit's finding that the synchronous write phases cannot
interleave mid-transaction — but the run log, whose entire job is observability,
is wrong. The admin dashboard's "Trigger ingestion" button has no guard against a
double click.

**21. An embedder returning too few vectors fails with an unactionable message.**
`slice[i]!` in the pipeline's write phase asserts away a value that can be
`undefined`; the document is then recorded as failed with `Cannot read properties of
undefined (reading 'length')`. Unreachable through the real client, which validates
batch counts and re-sorts by the response's explicit index — but the error is
recorded on the document and shown in the dashboard, and "actionable message" is a
stated rule.

**22. Two internal retrieval knobs are unvalidated and fail badly.**
`hybridSearch({ candidates: -5 })` throws sqlite-vec's raw message, which would
surface as a 500. `rrfK: -1` makes SQLite divide by zero at rank 1, which returns
NULL, which `COALESCE` turns into a score of 0 — so the best hit sorts last and the
ranking silently inverts. Neither is reachable from the API; both are exposed on the
options object the eval sweeps. A robustness note rather than a live bug, recorded
because a sweep that quietly produces garbage at one end of its range is how a
tuning constant gets chosen wrong.

### Redundancy, still open

The four items the first audit listed under "Redundancy and coupling" were recorded
and not acted on. All four are still present, and one now blocks the next step:

- **`search_queries_user_idx2` still duplicates `search_queries_user_idx`.**
  Confirmed against the live database — both indexes exist on `(user_id)`.
- **`errors.ts` still classifies a configuration error by `/API key/i`** on the
  message text.
- **`EVAL_QUESTIONS`, `ANSWERABLE` and `UNANSWERABLE` are still exported from the
  `@hatko/core` barrel**, so the API ships the evaluation set.
- **Importing `@hatko/core` still requires `BETTER_AUTH_SECRET` and opens the
  database.** Verified: `import('@hatko/core')` with the secret unset throws
  `BETTER_AUTH_SECRET is not set to a real value` before any export is reachable.
  Step 7's MCP server wants `hybridSearch` and nothing else, and cannot have it
  without inheriting Better Auth and a database handle.

Newly found dead code, all of it small:

- **`paginated()` in `packages/shared/src/common.ts:73` has no callers anywhere** —
  not in `packages`, not in `apps`, not in tests. A generic helper written for a
  response shape nothing returns.
- **`toBindable`, `returnsRows` and `CompiledQuery` are exported from
  `kysely-dialect.ts:152–153` and imported by nobody.** The first two are used
  inside the file; `CompiledQuery` is a pass-through re-export of a Kysely type.
- **`requireUser` and `listDocuments` have no production callers**, only tests.
  `listDocumentsFiltered` is what the API uses.

### What this pass says

The first audit's conclusion — that the tests are strong and test the corpus the
system has — holds, and this pass is more evidence for it than against. Six of the
nine new defects (14, 15, 16, 17, 21, 22) cannot occur on the sample corpus:
nothing in it has a long directory name, a symlink, a code fence, a BOM, or a
short embedder. Defect 14 is the one worth sitting with, because it is not a gap in
coverage but a gap in _shape_: a schema used on one side of an I/O boundary and not
the other converts a survivable bad input into an unrecoverable state, and the
tests cannot find it because they only ever write inputs the schema would accept.
Defects 18 and 19 are the same asymmetry in two other places — a contract that
validates one direction, and a limit that is bounded on the HTTP path and unbounded
on the CLI path beside it.

### Fixes for defects 14–22

All nine are fixed, along with the four redundancy items and the dead code. Twelve
tests added, 143 pass, and the new tests were run against the pre-fix source
first: eight fail there and pass here. The retrieval numbers are unchanged —
hybrid 100% recall@1, MRR 1.000, 12/12 answer checks — and the sample corpus still
produces 142 documents and 142 chunks with the longest at 1029 characters, checked
chunk-content-by-chunk-content against the already-indexed database rather than by
counting. A fresh-machine bootstrap into an empty database — migrate, seed, ingest
— indexes all 142 in 1.5 seconds with no failures. Every path these changes touch
is one this corpus never takes.

**14. The category is clamped where it is produced.** `CATEGORY_MAX_CHARS` moved
into `@hatko/shared`, the schema is built from it, and `categoryOf` truncates to
it — so the one place a category is derived cannot emit a value the read side
rejects. The test asserts the output against `documentCategorySchema` rather than
against the number 64, so the bound and the clamp cannot drift apart. Truncation
rather than rejection because a category is a facet label and not an identity;
identity is `source_path`, which is untouched.

**15. `scanCorpus` no longer follows symlinks.** The recursive `readdirSync` is
replaced by an explicit walk, because `{ recursive: true }` follows symlinks with
no way to opt out. Skipped links are reported in `ignored` — labelled
`(symlink)` — for the same reason the ignore list is reported at all. Two tests:
one for the link that escapes the corpus root, one for the loop that returned the
same file sixteen times.

**16. The chunker tracks code fences.** A `FENCE_RE` toggle in
`splitIntoSections`, matching CommonMark closely enough to be right rather than
merely short: the closing delimiter must be the same character and at least as
long as the opening one, so a ` ` ```` block may contain a ``` line as
content. Three tests, including one asserting the chunk is byte-for-byte the
source. Writing the first of these caught me out — I set `targetChars: 80` on an
87-character document, so it split at the ordinary merge boundary and the test
failed against the _fixed_ code. The assertion was measuring the wrong thing;
the split I was seeing was correct behaviour.

**17. The BOM is stripped at the decode**, in `readDocument`, and only from the
text. The content hash is still taken over the raw bytes, so adding or removing a
BOM is still a change to the file — asserted, because stripping before hashing
would have been the easy version of this fix and a quiet idempotency bug.

**18. Responses are parsed against the shared schemas on the way out.**
`/api/search`, `/api/answer`, `/api/session` and the admin document list now
`.parse()` their payloads. The list route uses `paginated(documentSchema)`, which
is what turned that orphaned helper from dead code into the thing it was written
for. Type-checking still cannot catch a renamed field — Zod does not help `tsc` —
but the rename that used to pass everything now fails two tests at runtime, which
is the demonstration that matters. Parsing also strips undeclared fields, so a
response cannot quietly grow one; there is a test for that too.

**19. `--limit` is validated in the ask CLI**, the way `--k` already was in the
eval CLI. `--limit=abc` now exits 1 with `--limit must be an integer between 1 and
20`, instead of answering "No documents cover this."

**20. A second concurrent ingestion is refused.** A module-scoped flag, and an
`IngestionInProgressError` that `errors.ts` maps to 409. That meant adding
`conflict` to the shared error-code enum — the alternative was reusing
`rate_limited`, which would have been two fewer lines and the wrong word for what
happened. The test asserts the refused run opens no `ingestion_runs` row it never
fills, and that the guard releases afterwards.

**21. The embedder count is checked and named.** `Embedder returned 0 vectors for
1 passages` rather than `Cannot read properties of undefined (reading 'length')`.
The existing failure-visibility test now also asserts the message is not the
property-access one, so the improvement is pinned rather than merely made.

**22. `candidates` and `rrfK` are validated** at the top of `hybridSearch`, with
the divide-by-zero consequence spelled out in the comment.

**The four redundancy items.** Migration 005 drops `search_queries_user_idx2`, and
the schema test now checks for duplicate indexes as a rule rather than by name, so
the next one is caught too. `ConfigurationError` replaces the `/API key/i` regex in
`errors.ts`, which put a message and its matcher in two different files and would
have forwarded any internal error mentioning an API key. The evaluation set is no
longer re-exported from the `@hatko/core` barrel. And `auth` became `getAuth()`,
built on first use — `import('@hatko/core')` no longer throws
`BETTER_AUTH_SECRET is not set to a real value` before any export is reachable,
which is what step 7's MCP server needed. The lazy version had to be written as a
factory with an inferred return type: annotating it `ReturnType<typeof betterAuth>`
widens the options generic back to `BetterAuthOptions` and loses `$context`, which
the seed script uses for password hashing.

**Dead code.** `paginated()` is now used rather than deleted. `toBindable`,
`returnsRows` and `CompiledQuery` are no longer exported from the Kysely dialect —
the first two are used inside the file, and the third was a pass-through re-export
of a library type. `requireUser` is gone: every protected route declares a
permission, so a "signed in, role irrelevant" check had no caller outside its own
test, and the branch it covered is exercised through `requirePermission`.
`signInRequestSchema` is gone too, found in the pre-commit sweep rather than the
audit: Better Auth owns the sign-in endpoint and validates its own body, so that
schema had no validator to be and no consumer in either workspace.

`listDocuments` went too, on a second pass: the four test call sites share one
local helper in the file that uses them, rather than a repository function the API
never calls. Also unexported, having no caller outside their own modules:
`getIndexHealth`, `getCategoryBreakdown` (both reached through
`getDashboardStats`) and `IGNORED_SEGMENTS`.

### A regression the fix for 15 introduced

Worth its own heading because it is the kind of thing a fix pass produces and a
fix pass is least likely to look for.

Rewriting the walk so it stops following symlinks also stopped it descending into
excluded directories — correct for indexing, and it made their contents vanish
from the `ignored` list rather than merely from the index. `node_modules` went from
"every vendored `README.md` listed" to nothing at all. That is precisely the
property the list exists to provide, and defect 5 in the first audit was that
property being missing.

Caught by re-running the probe script from the audit rather than trusting the new
tests, which passed: they asserted what the fix was _for_ and nothing about what it
might have cost. The walk now names an excluded directory once, with a trailing
slash — `node_modules/`, `.obsidian/` — which is visible without being thousands of
lines, and the case is pinned by a test asserting one entry each for two excluded
directories holding six files between them. The same sweep found symlinked
non-markdown files being announced when the ordinary files beside them are skipped
in silence; those are quiet again.

### What the second pass cost, and whether it was worth it

Six of the nine defects cannot occur on the sample corpus, and the seventh (18) is
invisible until a client exists to be broken by it. So the honest summary is that
this pass bought almost nothing for the demo and a good deal for the claim that
the system works on a corpus it has not seen — which is the claim the brief
actually makes. The two that would have shown up in a demo are 19, where a typo in
a CLI flag produces a confident falsehood about the corpus, and 20, where a
double-clicked button doubles the embedding bill.

Defect 14 is the one I would keep if I could keep only one, and not for its blast
radius. It is a schema applied to one side of an I/O boundary and not the other,
and the tests could not have found it because they only ever write inputs the
schema would accept. Defects 18 and 19 turn out to be the same shape — a contract
enforced inbound and not outbound, a limit bounded on the HTTP path and unbounded
on the CLI path beside it. Three instances of one mistake, found by looking for
asymmetries rather than by looking for bugs.

### The last sweep: four more, and one that changed a reported number

A final pass for anything still open, driven by a script that lists every exported
symbol with no consumer outside its own declaration rather than by memory.

**The eval measured a system slightly different from the one that ships.** It
retrieved and reranked ten candidates through a local `RETRIEVE_DEPTH = 10`, while
`answerQuestion` reranks six. A document at fused rank 7 could therefore be
promoted to first in the eval and never be seen in production — the reported
recall would be describing a retriever nobody runs. Both now come from one exported
`DEFAULT_ANSWER_PASSAGES`, and the eval header states the depth, because recall@k
means nothing without the size of the pool behind it.

I expected this to cost a point or two. It cost nothing: keyword 100% / MRR 1.000,
vector 89% / 0.889, hybrid 100% / 1.000, identical at six as at ten, and 12/12
answer checks still pass. The abstain margin actually widened — hybrid's
unanswerable relevance range tightened from 0.00–0.33 to 0.00–0.00. So the numbers
in this file were never flattered by the deeper pool, which is worth knowing for
certain rather than assuming.

**A caller-supplied `AbortSignal` disabled the request timeout.** `signal ??
AbortSignal.timeout(60_000)` means the 60-second bound applied only when nobody
passed a signal — and every request-scoped call passes one. So the one path a user
waits on was the one with no limit on how long a provider request could hang. Now
`AbortSignal.any([signal, AbortSignal.timeout(60_000)])`.

**A blank query returned eight arbitrary passages.** No keyword terms means the
vector-only fallback, which embedded the empty string and returned whatever sat
nearest the origin. `/api/search` is guarded by the schema's two-character
minimum, but `hybridSearch` is exported and step 7's MCP tool is a second caller
with its own boundary.

**The dashboard's top-queries label was non-deterministic.** Grouping is
case-insensitive, and a bare `query` beside a `GROUP BY` is legal in SQLite and
returns an arbitrary group member — so the casing shown could change between two
reads of unchanged data. `min(trim(query))` fixes it, and the trim is not
cosmetic: a space sorts ahead of every letter, so the untrimmed minimum would have
displayed the variant with the stray whitespace the grouping key already ignores.
I found that because my first assertion guessed `BUILD PIPELINE` and the test
returned `' build pipeline '`. The expectation was wrong and the code was right,
but the failure was pointing at something real underneath it.

### One thing deliberately not touched

`apps/web` appeared during this session and is entirely untracked — step 6, in
progress. The dead-export sweep flags ten helpers in it (`apiGet`, `formatBytes`,
`highlightSegments` and so on), and every one of them is scaffolding for a chat
page and dashboard being written right now. Deleting them would be deleting
someone's work mid-sentence, so none of it is in this commit.

I did check that nothing removed here breaks it: it imports only from
`@hatko/shared`, uses none of the symbols this pass deleted, and its own
`requireUser` is a Next.js session helper unrelated to the core one that went. Its
typecheck reports one error — `sign-in/page.tsx` imports a `sign-in-form.tsx` that
has not been written yet — which is unfinished work rather than damage. Worth
saying plainly because the root `tsconfig.json` excludes `apps/web`, so
`npm run typecheck` at the repository root would never have told anyone.

---

## Step 6: the web UI (17 Aug 2026)

Next.js 16 App Router, Tailwind v4 CSS-first, three surfaces — sign-in, chat, admin
dashboard. Product name changed to **Hatko**; palette, type scale and every token kept
exactly as `docs/design.md` specifies. Light theme only, so the `.dark` block in the
design doc is deliberately not implemented: a token set with no switch to reach it is
dead weight, and shipping it half-wired would be worse than not shipping it.

AI wrote effectively all of the markup and the Tailwind. What I did by hand was the
judgement about what the design system actually meant in each case, and the corrections
below.

### Where it was wrong

**The mark was a striped pill, not a leaf.** `brand.md` specifies the hatko leaf as
three solid shapes and a centre vein. The first attempt left 1-unit gaps between the
blades and the vein on a 24 grid — at the 20px the header renders it, that is 0.8px of
negative space, so the three shapes fused and the mark read as an oval with a dark band
through it. Caught by injecting the header's own SVG into the page at 160px and looking
at it, not by reading the paths. Fixed by widening the gaps to 1.5 units, narrowing the
blades so the silhouette is a shield rather than a circle, and tapering both blades to a
shared apex.

**The empty-state fern was a Christmas tree.** A vertical stem with symmetric side
leaflets is a conifer, whatever shape the leaflets are — and alternating two greens
across them made it worse by adding tinsel. Two attempts at a better frond failed the
same way. Replaced with a fiddlehead: an Archimedean spiral generated in code so the
curvature is uniform, which is unmistakable at 96px and happens to say "not yet
unfurled", which is exactly what the state is.

**Search-term highlighting was confetti.** The first version marked every query word
over two characters, so asking "which languages must every playable ship with" painted
`with`, `every`, `must` and `the` across every passage — burying the two words that
actually matched. Caught by looking at a real result on a tablet viewport. Fixed with a
stopword list, and while writing the test for it I found the opposite failure: querying
`languages` left the passage's `Language` unmarked, which reads as a bug. Terms now also
match across that one inflection, longest-alternative-first so `languages` is not split
into a marked `language` plus a stray `s`.

**The double ellipsis.** The API's key hint arrives already elided as `…a91f`; the panel
prefixed another one and rendered `….…iSAA`. Visible in the first dashboard screenshot.

**A React key collision in the answer skeleton.** Keyed on the Tailwind width class, and
two of the five lines are `w-full`. Found in the browser console, not by review — it is
exactly the class of mistake that never shows up in a screenshot.

**A duplicate element id waiting to happen.** Source cards were keyed `source-${chunkId}`,
so asking two questions that retrieve the same passage would give two cards the same id
and send both citations to whichever rendered first. Caught while writing the click
handler, before it could be observed. Ids are now namespaced by turn.

### Judgement calls, stated because they are deviations

**The score meter shows the rerank grade, not the fused score.** `design.md` says the
source card carries "retrieval score as a flat meter". Drawn literally that would be the
RRF score, which is rank-derived — the top result scores the same constant whether it
answers the question or is the least bad of 142 — so a bar of it would imply a
confidence it cannot carry. The meter shows the reranker's absolute 0–1 relevance, which
is what a meter means and what abstention is decided from; the vector, BM25 and fused
numbers sit beneath it as text.

**Dashboard filters are inline, not in a left rail.** `design.md` §9 asks for a left
rail on desktop. Two controls do not earn a rail.

**No streaming.** Listed as out of scope in `CLAUDE.md` §3 and still out. The answer
arrives whole, from one `/api/answer` call that returns the answer, the citations and the
passages together — which also means the sources on screen are provably the ones the
answer was generated from rather than a second retrieval that might differ.

### One shared type moved

`SecretStatus` was an interface in `packages/core/src/settings.ts` and the dashboard
needed to parse it. Rather than write a second definition in the web app, the schema now
lives in `packages/shared/src/settings.ts` and core re-exports the inferred type — so
the shape the API produces and the shape the browser parses are one declaration. The
admin route's local `apiKeyBodySchema` was the same duplication in the other direction
and is now the shared `setApiKeyRequestSchema`.

### Verified, not assumed

`npm run typecheck` and `npm test` clean (152 tests, six of them new, covering the
highlighter's escaping and reassembly — the one piece of logic here that can silently
drop document text). `next build` clean. Sign-in, a cited answer, an abstention, the
document table, the ingestion trigger and the provider-key panel all exercised in a real
browser at 375, 768 and 1280. Role gating checked by signing in as the seeded regular
user: no dashboard link, and `/dashboard` redirects to `/chat` server-side while the API
independently returns 403.

---

## Renamed to Hatko (17 Aug 2026)

The product was called Sorrel through steps 1–6 and is now **Hatko**. The rename is
mechanical everywhere except one place, and that place is the interesting one.

### The one thing a find-and-replace could not do

`docs/brand.md` opened by arguing _from_ the old name: "Sorrel is a wild green you
forage — you find it by knowing where to look." That sentence justified the palette
("a dark green brand named Sorrel is coherent") and the whole botanical field-guide
visual world. Substituting the new name into it produces a claim that is simply false:
Hatko is not a plant.

So the rationale was rewritten rather than substituted. The name section now says
plainly that Hatko is coined and means nothing — a brand document whose first section
is a false etymology cannot be trusted for the rest of its claims — and the field-guide
metaphor is re-derived from what the product does: a large collection where everything
must be findable, labelled and traceable is the problem a botanical plate solves,
drawn in 1850. The section also states what that decision costs, which the original
did not: the green palette no longer follows from the name, so it is a defensible
preference rather than a deduction, and it should be argued as one.

### Where the replacement went wrong, and how that was caught

The first attempt ran `perl -pi -e 's/@sorrel\//@hatko\//g'` across 51 files. In Perl,
`@sorrel` inside a regex is an array variable; it interpolated to nothing, so the
pattern collapsed to `s/\//@hatko\//g` — **replace every forward slash in the file**.
`docs/brand.md` became `docs@hatko/brand.md`, every `//` comment became `@hatko/@hatko/`,
and `@types/node` became `@types@hatko/node`.

Caught immediately because the tool that applied the edit echoed the rewritten files
back, and `"name": "@hatko@hatko/web"` is not a thing. The recovery was free only
because `apps/web` had been committed minutes earlier: `git checkout -- .` restored all
51 files, and the rename was redone in Python where a sigil has no meaning. The lesson
is not about Perl. It is that a 51-file mechanical rewrite should be one restorable
commit away from its starting point before it runs.

A second, quieter miss survived the redo: `\bSorrel\b` does not match in
`_Sorrel only answers…` because `_` is a word character, so one occurrence in
`docs/design.md` §8 stayed behind. Found by re-grepping for the old name afterwards
instead of trusting the replacement count — the grep is the check, not the script.

### Verified

Deleted `data/` entirely and re-bootstrapped rather than renaming the SQLite file, so
the fresh-machine path is the one actually tested: `npm install` → migrate (5
migrations) → seed (`admin@hatko.local`, `user@hatko.local` created) → ingest (142
documents embedded, 2.0s, 0 failed). `npm run typecheck` and `npm test` clean (152
tests), `next build` clean. Leaving the old `@sorrel.local` accounts behind in a
renamed database would have left two sets of demo credentials with published
passwords, which is why the database was rebuilt rather than moved.

---

## Acting on the two design reviews (17 Aug 2026)

Two review passes ran against the finished web UI: an Impeccable `critique` (dual-agent:
a design-director review, and a deterministic detector plus browser evidence, isolated
from each other until synthesis) and an anti-slop frontend audit. First scores: **22/40**
on Nielsen's ten, 1 P0, 4 P1, 3 P2, five of eight cognitive-load checks failing. The
detector found **zero** findings in source and four rule families at runtime, three of
which were false positives against this project's committed brand decisions.

Version matters for a deterministic scan, so: everything in this section ran against
**Impeccable 3.9.1**. It was re-run against 4.1.1 afterwards — see the end of the section.

Three findings arrived by independent routes, which is the part worth recording.

**Right-edge overflow on every phone.** The design review measured it: `/dashboard` laid
425px of content into a 375px window, `/chat` 437px, and `window.scrollTo(400,0)` left
`scrollX` at 0 — so the clipped region was not scrollable, it was destroyed. The detector
independently flagged three `text-overflow` hits on `.truncate.font-mono` elements. I
bisected it in the live page by hiding one subtree at a time: the culprit was the
`truncate`d source-path `<p>`, because the min-content of a `white-space: nowrap` run is
the whole run and grid tracks default to `min-width: auto`. Replacing `truncate` with
`overflow-wrap: anywhere` in the live page dropped `scrollWidth` from 425 to 375 before I
changed a line of source. After the fix, measured again at 375 with an answer rendered and
the sources open: 375/375, zero overflowing elements.

**The catalog-number motif had become wallpaper.** The design review counted ten of
thirteen dashboard catalog numbers identifying no record (`IDX-01`, `QRY-03`, `CFG-01`).
The taste audit reached the same place mechanically — 13 `<Eyebrow>` plus 8 uppercase
mono-labels against a ceiling of `ceil(sections/3)`. The detector reached it a third way,
with 24 `wide-tracking` hits on one page. All ten invented numbers are gone; `DOC-0141` and
`RUN-0001` stayed, because they name a row. I also added the rule to `brand.md` so the
motif has a stated limit: a catalog number belongs on a specimen, never on the drawer.

**The popover/header stacking bug.** The review measured the citation popover's title
occluded by 22px (popover z-20 under a z-30 header); the taste audit flagged the absence of
a z-index scale as a rule violation. Same defect from the rule side and the symptom side.
There is now a four-token scale in `globals.css`.

### Where I removed a specified feature rather than fix it

`design.md` §8 specifies a hover popover on each citation chip. It was built. It had three
measured defects, and fixing the third honestly meant JavaScript:

- `position: absolute` while merely `invisible` still contributes to scroll width, so it
  widened the document by 275 unreachable pixels for readers who never hovered.
- `block` and `line-clamp-4` both set `display`; `block` won, so the clamp was inert and it
  rendered a 657-character passage at 363px tall.
- Anchored `left-0` it overflowed the right edge. Centred with `left-1/2 -translate-x-1/2`
  it overflowed the **left** edge instead — measured `left: -182` in a 1280 viewport. There
  is no CSS-only anchor that fits at both edges with cross-browser support.

At that point I asked what the popover was _for_. It showed the document title, the path and
the first four lines of the passage. All three sit in a source card a few inches right,
permanently visible, with the whole passage and the retrieval scores — and clicking the chip
already scrolls there and promotes it. It was duplicating the rail. So it is deleted, the
reasoning is in the component, and the deviation from §8 is stated rather than hidden. The
chip's `aria-label` carries the same information for anyone who cannot see the rail, which
was the part that had to work.

### The accessibility findings were the worst ones

Not the visible bugs — the invisible ones.

**Focus was destroyed on every question.** The composer was disabled while the answer
generated, which threw focus to `<body>` and never returned it, so a keyboard user had to
traverse six source cards and every citation chip to ask a second question. Measured before:
`activeElement` = `BODY`. After: `question`, both during the request and after the answer
lands. The input is now `readOnly` while pending instead of `disabled`; overlapping submits
were already refused by a guard that existed.

**Nothing was announced.** The only `aria-live` region was rendered _with_ the answer, and a
region inserted together with its content is not announced by most assistive tech. So the
product's core interaction produced silence. The live region is now a persistent `<ol>` that
outlives every turn.

**A wrong password marked the email field invalid.** The server does not say which field was
wrong, and should not — that would leak which addresses have accounts. So the client cannot
know either, and it was putting `aria-invalid` on a correct value. The failure now belongs to
the attempt, reported once, with `role="alert"`.

**Nine dashboard panels had no heading at all** — they were `<p class="text-eyebrow">`,
leaving a three-entry outline on the page with the most content. That surfaced a real design
problem underneath: `Ingestion` and `Documents` were 24px Fraunces while `Index health` and
`Provider key` were 12px labels, the same rank at opposite volumes. The fix was not to pick
one size. Those four groups genuinely are sections and the cards in them genuinely are
subordinate, so the outline is now h1 → h2 section → h3 panel, and the two type sizes finally
mean two different ranks.

Also: `<main>` and heading order on sign-in (an `<h2>` preceded the page's `<h1>`); 44×44 hit
areas on all three evidence controls, verified with `elementFromPoint` walking outward from
each centre (44×45, 44×46, 107×45 against drawn boxes of 27×17, 15×17, 107×17); `Escape` on
the sources disclosure; and a disabled-button treatment that is legible rather than 40%
opacity on both label and fill.

### Copy and honesty fixes

`1 passages`, 142 times. `4.5S` and `240MS`, from `uppercase` applied to an SI unit in a brand
whose stated rule is numbers over adjectives. Four em-dashes in shipped copy and an en-dash
used as a range separator. Six lines carrying two or three `·` separators each, now labelled
`<dl>` columns — `vector 0.84 · bm25 0.99 · fused 0.174` read as one opaque token, three
labelled pairs read as three measurements. An `UNCATEGORISED` badge on 60 documents whose
value is "no value". Deprecation stated four times for one document, now twice.

Two behaviour changes came out of it rather than styling:

**A legend for the numbers the product is proud of.** Help and documentation scored 1/4:
`vector`, `bm25`, `fused`, "index is torn", "abstain rate" were all exposed and none
explained. Exposing internals without a legend is not transparency, it is trivia.

**Forcing ingestion now asks first.** A plain run is idempotent and skips unchanged files in
milliseconds, so it still fires on one click. Forcing re-embeds all 142 documents, spends
provider credits and cannot be undone, and it had no confirmation of any kind.

**The abstain state is no longer a dead end.** It was the best screen in the product and the
only one with no next action, while the dashboard already kept the corpus-gap list that closes
the loop. It now says the question was recorded. Stated rather than linked, because a regular
user cannot open that page.

### Not done at first, then done

The first pass through these reviews left three things open. All three are now closed, and
the reasons the deferrals were wrong are more interesting than the fixes.

**Sorting the documents table.** Deferred because it needed an API ordering parameter
rather than a frontend change, which was true and not a good enough reason. Doing it
surfaced the part that made it worth a test file of its own: `ORDER BY` cannot be
parameterised in SQL, so the column has to be interpolated into the statement text. That
makes the boundary between "key the client sent" and "column the query names" the only
thing between a dropdown and arbitrary SQL. The design is that the client never names a
column at all — it sends a key from a closed enum in @hatko/shared, and the repository owns
a `Record<DocumentSort, string>` that translates it. The `Record` type is the enforcement:
adding a key to the enum without adding a column fails the type check, so the two cannot
drift into a gap where an unmapped key falls through.

Writing the tests found two ordering bugs that would both have failed silently:

- **Paging dropped and duplicated rows across ties.** 78 delivery reports all have
  `chunk_count = 1`. Sorting by passage count with no tiebreaker lets SQLite return them in
  a different order for page 1 and page 2, so rows vanish and others appear twice. Ties now
  break on `source_path`. The test pages through in two halves and asserts the union is the
  whole corpus with nothing repeated.
- **Failed documents sorted to the top.** `indexed_at` is null for a document that failed,
  and SQLite sorts nulls first ascending — so "never indexed" was being treated as "indexed
  at the beginning of time" and put above everything the reader asked to see. Nulls now sort
  last in both directions.

**The document list rendered twice at every width.** Deferred on the grounds that 25
`display: none` label frames cost nothing measurable and are absent from the accessibility
tree. Both claims were true; the argument was still wrong, because the real cost was never
performance — it was that every row's content existed in two places and had to be edited in
two. There is now one markup tree. A `table-cards` utility turns each `<tr>` into a bordered
card below `md`, and each `<td>` grows its own label from `data-label` — the same text the
`<th>` carries at wider widths. The header row is visually hidden rather than
`display: none`, so the table stays a table to a screen reader at every width. Verified: one
`<table>`, zero duplicate lists, 25 rows where there were 50, `display: block` rows with
their own borders at 375, and no horizontal overflow.

Two things fell out of the rewrite. A failed document's error message was only ever rendered
on the mobile card, so the desktop view of a broken corpus looked healthy; it is now in the
row. And the table had been sorted by path since day one while every header reported
`aria-sort="none"` — the Document column now sorts by path, so the UI states its own
ordering instead of leaving it implicit.

**Ten eyebrow labels on the dashboard.** Deferred as a false positive, since every one named
its own data. Half true. Six panel headings genuinely need the treatment; the four stat-tile
labels were the reflex, and having them in the identical 12px uppercase tracked style
flattened a real distinction — a panel heading names a section, a tile label names a number.
The tile labels are now sentence-case captions. Four fewer, and the hierarchy reads.

### Not done, and stated rather than buried

**Fraunces stays, and this one is not a deferral.** It is one of two display serifs the
anti-slop rules ban by name, and the only thing defending it is that `brand.md` names it —
plus a standing instruction to keep the fonts unchanged. Worth knowing that the most
recognisable AI type tell in the project sits in the wordmark, defensible in one sentence
and only one. It is confined to display sizes in writing, since a display serif doing a
label's job is the specific way this system would look cheap.

### Verified after the fixes

`npm run typecheck`, `npm test` (152 pass), `next build` all clean. Detector re-run under
the version available at the time, **Impeccable 3.9.1**: zero findings. Re-measured in a
real browser at 375, 768 and 1280: no horizontal overflow on any page in any state, all
three touch targets ≥44px, focus retained across a submit, the live region persistent, one
of six sources marked cited, sources inline-expanded at 768 as §9 requires, and the heading
outline ordered on all three surfaces.

### Re-verified against Impeccable 4.1.1

The reviews above ran against Impeccable 3.9.1, which was the installed version at the
time. It is worth being precise about why, because I first recorded this wrongly.

`npx impeccable update` could not update it: the skill was installed as a Claude Code
_plugin_ from the `pbakaus/impeccable` marketplace, so the npm CLI reported "no impeccable
skill folders found" and then offered to install an older 3.6.0 as a package. I recorded
that as "cannot be updated", which was the wrong conclusion from a correct observation —
it could not be updated _by that command_. The operator installed 4.1.1 directly as a
user-level skill at `~/.claude/skills/impeccable`, which is the route the npm CLI was
looking for and not finding.

Re-running the 4.1.1 detector over `apps/web` surfaced exactly one finding that 3.9.1 had
no rule for, and it is a false positive:

**`codex-grid-background` at `app/globals.css:393`** — "hairline linear-gradient layers
tiled by a fixed pixel cell". That line is the `notch` utility, brand motif 2, which draws
the hairline back onto a card's clipped corner because `clip-path` cuts the border along
the diagonal and leaves the notch with no visible edge. Measured in the live page rather
than argued from the source: exactly **one** element on the whole dashboard carries any
background image at all, its `background-repeat` is `no-repeat` so it cannot tile, its
`background-size` is `15px 15px` on a 183×118 card, and its position is `100% 0`. That is
one corner mark covering about 1% of one card, not a decorative grid field. The rule keys
on `linear-gradient` plus a fixed-pixel `background-size` and does not consult
`background-repeat`.

Every other rule came back clean across `apps` and `packages`, so the findings acted on
above stand under the newer ruleset.

4.1.1 also ships a `doctor` command, which raised one advisory: "`docs/DESIGN.md` has no
colors section". It has one — `## 1. Color` is the longest section in the file, carrying
three raw scales, the semantic token layer, two hard rules and a table of computed contrast
ratios. The heuristic looks for an unnumbered heading and this file numbers its sections,
because `CLAUDE.md` and several commit messages cite it as "design.md §1", "§8", "§11".
Renaming headings so a scanner recognises them would break those references to satisfy a
tool, so the numbering stays.

Both 4.1.1 findings are therefore tool-heuristic mismatches rather than defects, which is
worth stating plainly: a clean scan is evidence, and a scan you have argued your way out of
twice deserves more scepticism than this paragraph can give it. The measurements behind the
first one are in the page and reproducible; the second is a filename-and-heading convention
anyone can check in ten seconds.

One piece of housekeeping left for the operator, not changed here because it is in their
global configuration rather than this repository: the 3.9.1 plugin is still enabled in
`~/.claude/settings.json` (`"impeccable@impeccable": true`) and its cache is still on disk
alongside the 4.1.1 skill. Only 4.1.1 is currently exposed, so nothing is broken, but two
installs of one skill is the kind of thing that resurfaces later as a version that will not
die.

## Step 7: the MCP server (17 Aug 2026)

A fourth workspace, `apps/mcp`: Streamable HTTP on port 4100, one tool
(`search_corpus`), bearer auth. Connection instructions and the reasoning behind each
choice are in [docs/mcp.md](docs/mcp.md).

AI wrote the transport wiring, the passage formatting and the test file. What I did by
hand was the four decisions that actually shape it — transport, credential, tool count,
and statefulness — and the corrections below.

### The decisions, and what they cost

**Streamable HTTP rather than stdio.** stdio is less code and the obvious lazy choice,
and it was the wrong one: a stdio server is spawned by the client as a local
subprocess, so there is no caller to authenticate. The brief gates access by role, and a
role needs an identity, and an identity needs a header to travel in. Taking the more
expensive transport is what made the security requirement satisfiable at all.

**The bearer token is a Better Auth session, not a shared secret.** A static
`MCP_TOKEN` in `.env` was the first instinct and would have been about six lines. It
carries no user, which means MCP queries land in the analytics table with a null user id
and the role check has nothing to check — a second, weaker authorization scheme sitting
beside the real one. Adding `bearer()` to the existing auth config was _one_ line and
let the MCP server call the same `requirePermission(headers, 'search:run')` the HTTP
API's middleware calls. The laziest option and the strongest option turned out to be the
same option, which is not usually how that goes.

The step-5 commit had already made `getAuth()` lazy specifically so this consumer could
import `@hatko/core` without a session secret. That paid off here exactly as written.

**One tool, not two.** The API also exposes `/answer`. An MCP client is itself an LLM
holding the user's real question and its own instructions, so handing it passages lets
it synthesise with all of that context, while handing it our pre-written paragraph
throws that away and asks it to trust a summary it cannot check.

**Stateless, with `enableJsonResponse`.** Not for simplicity's sake but because the hard
part of a per-request transport is knowing when it may be closed. With a complete JSON
body instead of a held-open SSE stream, `handleRequest` resolving _is_ that moment, so
the server does not accumulate one connected `McpServer` per call it has ever served.

### Where it was wrong

**The DNS-rebinding guard was a footgun before it was a control.** I pinned
`allowedHosts` to `localhost:4100` and `127.0.0.1:4100`, which is what the MCP spec's
example looks like. The new test then failed 403 on every authenticated case, because
`app.request()` sends no `Host` header at all and the SDK rejects a missing one. Chasing
that surfaced the real problem: the list was also wrong for anyone who reached the server
as bare `localhost`, over IPv6, or on a different port — a security control that blocks
legitimate callers is a control that gets switched off, which is worse than a wider one
that stays on. Now built from every loopback spelling with and without the configured
port, and both halves are asserted: `evil.example.com` is refused, and all three loopback
forms are accepted. The missing-`Host` behaviour is real but unreachable over a socket,
so the test helper sends a `Host` like an actual client and says why.

**A bad test nearly deleted a true comment.** I had written that signing out revokes the
MCP client's access, and the first check appeared to disprove it — the MCP call still
succeeded after sign-out. The sign-out had returned `415 Unsupported Media Type` because
I sent no `content-type`, so no session was ever revoked. Retried correctly: sign-out
returns 200 and the next MCP `initialize` returns 401. The claim was right and the
verification was wrong, which is the more dangerous direction — one more step and I would
have "corrected" accurate documentation to match a broken probe.

**A typecheck that reported success while failing.** I ran
`npm run typecheck 2>&1 | tail -12 && echo "TYPECHECK OK"` and got the errors _and_ the
OK, because in a pipeline the exit status is `tail`'s, not `tsc`'s. Four real type errors
in the new test file were sitting in that output. Re-ran writing to a file and echoing
`$?`, which is how the exit code gets checked in this repo from now on: `&&` after a pipe
proves nothing.

**A category filter that looked broken and was not.** Filtering to `guides` returned an
abstention for a localization query, with `asset-naming.md` at 0.012 as the top hit. The
tempting read was a bug in the category clause. `localization-guide.md` lives at the
corpus root, so its category is `uncategorised`, not `guides` — the filter was exactly
right and my test input was wrong. It is the failure mode the tool's own description
warns about ("a wrong guess here silently hides the answer"), reproduced by the person
who wrote the warning, so `docs/mcp.md` now states the root-document rule explicitly.

### How it was verified

Not by asserting the protocol works. `claude mcp add --transport http` against a running
server reported `✔ Connected`, then two `claude -p` runs through that client: the sample
question about the minimum language set came back with the seven languages, the English
fallback and `localization-guide.md` cited, and the unanswerable question about parental
leave in Portugal came back as "the corpus doesn't cover it" with no invented answer.
Abstention surviving the trip through a _foreign_ LLM was the one behaviour I most wanted
evidence for, since nothing in our prompt controls what that client does with the result.
The probe registration was removed afterwards.

Nine tests in `apps/mcp/src/app.test.ts` cover the two things that fail silently here: a
gate that stops checking still initializes, lists and answers — it just answers anyone —
and a published input schema derived with `.unwrap()` keeps type-checking after it stops
carrying the shared bounds. Both are asserted through the real router. Full suite 167
passing, typecheck clean.

### Reviewing step 7 (17 Aug 2026)

A deliberate second pass over the MCP server looking for redundancy, dishonesty and
things that would not scale. It found six items, three of which were real defects
rather than tidying.

**The tool result leaked internals.** The worst of them. The SDK catches a throwing
tool callback and answers with `error.message` verbatim — verified by registering a
tool that throws and reading what a client receives:

```
{"content":[{"type":"text","text":"SQLITE_ERROR: no such column: secret_key in /Users/tugaep/private/hatko.db"}],"isError":true}
```

A schema fragment and an absolute filesystem path, handed to whoever called the tool.
`apps/api/src/errors.ts` has refused to do exactly this since step 3, and I had built a
second surface onto the same database with no equivalent boundary — the kind of gap that
only appears when you check what the framework does _instead_ of what you wrote. Fixed
with `toToolErrorText`, mirroring the API's classification: provider failures named,
configuration errors forwarded because they are the fix, everything else logged
server-side and generalised. Verified twice — three unit tests on the classifier, and
live against a deliberately invalid `OPENAI_API_KEY`, where the client got "The model
provider could not be reached" and the operator's log got the OpenAI response.

**An error code that meant something else.** I had written `-32001` with the comment
"the SDK's convention for unauthorized". Checking the SDK's `ErrorCode` enum:
`-32001` is `RequestTimeout`, and `-32000` is `ConnectionClosed`. The comment was
wrong twice — there is no such convention, and that number already means a timeout in
this very library. Now `-32002`, documented as an implementation-defined code from the
reserved band, with the HTTP 401 noted as the signal clients actually act on. A comment
that confidently cites a convention is worth more scepticism than one that admits a
guess, and this one had survived a commit message too.

**No `onError`, so a fault answered non-JSON.** The API app registers one; the MCP app
did not. A database failure during the session lookup would have escaped the handler
into Hono's default plain-text "Internal Server Error", which a JSON-RPC client cannot
parse — so a broken server would have been reported as a broken protocol. Added, and
the per-request error path collapsed into it: the old code closed the server in two
places and duplicated the envelope and the logging in the second. Now one `finally`.

**Sample folder names in the shipped tool description.** It read `e.g. "guides" or
"postmortems"`. Those are facts about the sample data, not about the tool, and this
project already rejected a category enum built from those same folder names in step 1
for the same reason. Pointing ingestion at a real corpus has to stay straightforward,
and a description every client reads is the soft version of that mistake. Rewritten to
describe where categories come from without naming any.

**Two dead fields and a pointless wrapper.** `runSearchTool` returned `{text,
abstained, results}` and no caller ever read the last two — an MCP tool result is text,
and an abstention is not something the transport needs to know. It now returns a
string. `authorize()` was a one-line single-use wrapper around `requirePermission`;
inlined, comment kept.

**What the review cleared.** No mocks, stubs or placeholders in the shipped paths —
the only test double is the deterministic embedder in the test file, matching the API
suite's existing pattern. And one thing I had recorded as a design preference turned
out to be a requirement: reusing a stateless transport throws `Stateless transport
cannot be reused across requests`, so the per-request construction I had justified on
concurrency grounds is simply how the SDK works. The comment now says so.

Also corrected a _measurement_ habit while here: an earlier "no processes running"
conclusion came from `ps aux | grep -c "[s]rc/server.ts"` returning 0 while a server
was demonstrably answering curl, and a server log that stayed empty because Node
buffers stdout to a pipe and the process was being killed before it flushed. Both made
a live process look dead. `lsof -ti :4100` is the check that actually answers the
question, and `EADDRINUSE` is now in the troubleshooting table.

Scale limits are written down in [docs/mcp.md](docs/mcp.md) §6 rather than left
implied: one machine because of SQLite, latency dominated by two model round trips
rather than anything in this code, and no rate limiting — a valid token can drive
unbounded rerank spend, which is true of the HTTP API's `/answer` too and is worth
fixing before either faces untrusted clients.

Typecheck clean, 171 tests passing.

## Steps 7b and 7c: finishing two half-built bonuses (17–18 Aug 2026)

The operator moved four items from this project's "do not build" list into scope after
the step 7 review. Two of them were bonuses that were already half-built, and those
came first: an incomplete thing sitting in the repository costs more to leave than a
missing thing nobody has started.

The AI usage log entry for 7b is late — it should have been in the same commit as the
work, which is this project's own rule. Recording that rather than backdating it.

### 7b — the ingestion trigger

The diff engine already detected new, changed and removed documents and skipped
untouched ones by content hash. Only the trigger was missing, so this is `fs.watch`
plus coalescing: stdlib, no dependency, and deliberately not a poller.

**Where AI was wrong: it wanted to label watcher runs `cli`.** The `trigger` column
already had three legal values and 'watch' was not one of them, so the path of least
resistance was to reuse `cli` and move on. That column exists to answer "why did the
index change", which is the observability requirement — reusing `cli` would have made
the dashboard lie. The honest fix cost a table rebuild, because SQLite cannot alter a
CHECK constraint. Safe here specifically because nothing references `ingestion_runs`,
and verified by reading the surviving row back with its `duration_ms` intact rather than
by trusting the migration to have worked.

Writing that migration also turned up `startup`, declared in the trigger enum in step 1
and never produced by anything. It has a real producer now — the watcher's initial
catch-up pass, which is a genuinely different event from a file changing.

**The scheduling moved into its own module because it is where the silent failures
are.** Two of them: coalescing breaking costs an embedding pass per filesystem event
and nobody notices except the bill, and dropping a change that arrives mid-run leaves
the index stale while every run still reports success. Five tests cover both.

Verified against a scratch corpus by reading the run table, not the log: add recorded
`indexed=1 skipped=1`, modify recorded `updated=1`, delete recorded `deleted=1`, a
`.txt` recorded nothing, and a five-write burst plus a modify produced one run rather
than six. Restarting on an unchanged corpus skipped everything, which is what makes the
catch-up pass cheap rather than a full re-embed on every boot.

### 7c — OIDC on the MCP server

Better Auth's `mcp` and `oidcProvider` plugins supply the endpoints. This repository
supplies migration 007, the consent screen, and one policy decision that turned out to
matter more than all the wiring.

**The finding that mattered: consent was not happening.** The flow worked on the first
try — register, authorize, token, call the tool — and the authorize step went straight
to the client with a code. Reading the plugin rather than the happy path explained it:

```js
requireConsent: query.prompt === 'consent',
```

The mcp plugin asks for consent only if the client requests it. Combined with dynamic
client registration, which the MCP spec requires to be open, that is a live hole rather
than a theoretical one: anyone can register a client, and one crafted link sent to a
signed-in user silently issues a token good for reading the entire corpus. PKCE and
`state` do not help — they protect the client from token interception, not the user from
authorizing a stranger.

I had already written comments claiming a human approves each client. That claim was
false when I wrote it. The choice was to delete the claim or make it true, and given
security is a graded axis, making it true was the only defensible option.

The fix rewrites the query to force `prompt=consent` on every authorization, using the
same before-the-mount route pattern this repo already uses to close public sign-up. The
alternative I considered first — advertising a different `authorization_endpoint` in the
discovery document — would only have redirected well-behaved clients while the
consent-free endpoint stayed mounted and reachable by exactly the crafted link it was
meant to stop. A control that only the honest obey is not a control.

**Second finding: the consent screen was decoration.** The first version rendered
`Application: UTsqeiLUXqVTEpyXCdLCuqGjmyucMhRj`, because the authorize redirect carries
only `client_id`. A consent screen that cannot say which application is asking teaches
people to approve things they cannot identify, which is worse than no screen at all —
it manufactures the reflex. Added a session-gated lookup so the page shows the client's
name and, more usefully, the host the authorization code will be delivered to: a name
can claim to be any familiar tool, the redirect host is where the code actually goes. An
unidentifiable client now gets no Approve button.

**Where AI was wrong on smaller things.** It set `accessTokenExpiresIn` and
`refreshTokenExpiresIn` to 3600 and 604800 with a comment calling them "deliberately
short" — those are the library's own defaults, so the comment claimed a tightening that
had not happened. Removed, and the defaults noted as adequate. It also reached for
`better-auth/plugins/mcp`, which is not an exported subpath (only `/mcp/client` is), and
imported the auth library directly into the API workspace, which does not depend on it —
that only resolves by hoisting, so the two discovery handlers are re-exported from
`@hatko/core` instead.

**One test failed and was right to.** I wrote "an orphan access token is refused with
401" and got `FOREIGN KEY constraint failed` — the schema makes an orphan token
impossible to create, which is a stronger guarantee than the one I was asserting. The
test now asserts that. The null-user branch in `requireMcpPermission` stays, because
`getUserById` returns a nullable and something has to handle it; it fails closed and
should never be reached.

**Two measurement corrections.** A `fetch`-based flow script got 403
`MISSING_OR_NULL_ORIGIN` on sign-in, which looked like the bearer path had regressed;
curl returns 200, so the documented flow was fine and the script was sending
browser-like headers without an `Origin`. And a `pkill -f`/`ps | grep -c` pair reported
no servers running while curl was demonstrably being answered by a stale process holding
the port — that stale process was running pre-fix code, which is why a logging change
appeared not to work. `lsof -ti :4100` is the check that actually answers it.

Verified end to end against the running pair: discovery chain, open registration, deny
answered with `error=access_denied`, approve returning a code with `state` intact, PKCE
exchange, a wrong verifier rejected with "code verification failed", the OAuth token
searching the corpus, a bogus token refused, and the bearer path still working. The
Approve button was clicked in a real browser and landed on the callback with the code.

Typecheck clean, 184 tests passing, format clean.

## Step 8: admin user management (18 Aug 2026)

List accounts, add one, change a role, deactivate and reactivate. Built without a new
dependency: Better Auth ships an `admin` plugin that would have supplied list/ban/role
for free, and it was the wrong trade — it brings its own role model, which would have
left this system with two answers to "what may this account do" and no rule about which
one wins. The four operations are a query, an insert through the existing
`upsertAccount`, and an update.

### The two refusals that are the actual feature

An admin panel that can demote the administrator using it, or the last administrator
left, is not a feature — it is a way to lock everyone out of a system that can only be
recovered from a CLI. Both are enforced in core, at the point of the write, and both are
tested:

- **You cannot change your own role or deactivate yourself.** It is one click, it is
  never what someone means from a list of other people, and changing your own role is a
  deliberate act that already has a home in `npm run seed`.
- **The last _active_ administrator cannot be demoted or disabled.** Active, not
  existing: disabling the second-to-last admin is fine, and the count has to exclude
  people who are already switched off or the guard passes while the door locks.

The UI disables those buttons too, with the reason in a tooltip. That is a courtesy over
the rule, not the rule — stated in the panel's own comment so nobody later deletes the
server-side check on the grounds that the button is already greyed out.

### Deactivate rather than delete, and where the check goes

Deleting a user would cascade — migration 003 and 007 both point at `user` — taking
their MCP tokens _and_ their search history out of the analytics the dashboard reports.
Deactivation revokes access and keeps the record.

The interesting decision was where to enforce it. Checking at sign-in would have been
the obvious place and the wrong one: every session and OAuth token issued beforehand
would keep working for up to seven days, which is not what someone pressing "Deactivate"
is asking for. It goes in `getSessionUser`, which is the one place both the web app and
the MCP server resolve an identity, plus the OAuth branch's `getUserById`, which does not
pass through it. One flag, both surfaces, immediately.

### Where I was wrong

**I believed the feature worked before it did.** After building it, a live check showed a
deactivated user's bearer token still listing MCP tools, and their sign-in still
returning 200. The first was pure process staleness — the MCP server had been started
before migration 008 — and restarting it gave the 401 the test suite had been asserting
all along. The lesson is not about the code: a stale long-running process had already
wasted a debugging round earlier in this session, and I still reached for "the feature is
broken" before "the process is old".

**The second half was a real defect.** Sign-in returned 200 for a deactivated account,
set a cookie, and then every subsequent request behaved as signed out — a loop with no
explanation in it, which reads as a broken application rather than a closed account. The
tests did not catch it because they asserted the _session_ was refused, which it was.
Fixed by refusing sign-in with a message that names the cause. Recorded honestly as error
handling rather than security: the session was already inert, so nothing was reachable
either way.

**AI got three component APIs wrong** and typechecking caught all three: `apiSend` takes
the method as its first argument rather than its last, `LabelFrame` has no `aside` prop,
and `ErrorCard` has no `retryLabel`. It also wrote the update route as `PATCH`, which
would have failed at the CORS preflight — the API's allow-list and the browser client's
method union both stop at PUT. Widening both to gain a more precise verb buys nothing
when the body is a partial update either way.

**A generated helper was named `upsactivateFixture`**, which is not a word. Renamed.

Verified in the browser as well as by test: the panel lists both accounts, marks the
requesting administrator as "you", disables both of that row's buttons with the reason in
a tooltip, and deactivating the other account flipped its badge to DEACTIVATED and its
button to Reactivate. Then confirmed out of band that the deactivated account's existing
MCP bearer token returned 401, a fresh session read back as `{"user":null}`, and search
returned 401 — and that reactivating restored all three. The demo database was left with
both accounts active.

Typecheck clean, 192 tests passing.

## Step 8b: production configuration and the deploy guide (18 Aug 2026)

Target `hatko.tugrap.dev`, operator runs the deploy. The guide is
[docs/deployment.md](docs/deployment.md).

**One real blocker existed and would have been found the hard way.** The MCP server's
DNS-rebinding guard accepted only loopback hostnames, which is correct on a laptop and
fatal behind a reverse proxy: the proxy forwards the public hostname, the guard does not
recognise it, and _every_ MCP request becomes a 403. The likely outcome of shipping that
is not a bug report — it is an operator meeting a blanket 403 on a fresh deployment and
switching the protection off, because that is the fastest way to make it work. So the
control is now configurable via `MCP_ALLOWED_HOSTS`, with a test asserting both halves:
a configured public host is accepted, and `evil.example.com` still is not. That is the
second time in this session the same control has needed widening for the same reason —
the first was for bare `localhost` and IPv6.

**The topology is one origin, and that is the decision the guide argues for.** Splitting
web and API across subdomains means the session cookie has to be widened to the parent
domain and every browser request becomes cross-origin, so CORS, `SameSite` and cookie
`Domain` all become things that must be right, each of them a way to lock yourself out or
leak a cookie further than intended. Behind one origin none of those questions exist. The
API already namespaces itself under `/api`, so nothing had to be renamed to get there.

**A trap worth writing down rather than discovering.** The nginx default
`proxy_set_header Host $proxy_host` would make the MCP server see `127.0.0.1:4100`
instead of the public name. That _passes_, because loopback is always allowed — so the
guard would appear to work while checking nothing at all. Noted in the guide beside the
nginx instruction, because a control that silently stops checking is worse than one that
fails loudly.

**Claims were checked rather than written from memory.** Every `npm run` script the guide
references was verified to exist, and the Node version requirement against
`engines`. The one instruction I could not verify is the deployment itself: I have not
run this on a server, so the guide is written from what the code does rather than from a
completed deploy, and the verification section exists so the operator confirms rather
than trusts it.

The guide ends with what the deployment does not have — no rate limiting, no horizontal
scaling past one SQLite file, no email, no alerting — because each is a real gap and
listing them is cheaper than having them found.

Typecheck clean, 193 tests passing.

## Audit of the four bonus features (18 Aug 2026)

A read of every file touched by steps 7b, 7c, 8 and 8b, plus a sweep for dead and
duplicated code across the repository. Typecheck was clean and all 193 tests passed
before it started, so nothing here was found by a failing test — which is the point of
reading the code rather than running it.

**The worst finding was a comment, and it was mine.** The module docblock at the top of
[apps/mcp/src/app.ts](apps/mcp/src/app.ts) still said "There is no OIDC here. That is the
stated bonus and it is deliberately not built", written when that was true. Step 7c built
it, and the handler thirty lines below the comment implements the 401 and
`WWW-Authenticate: resource_metadata` bootstrap that starts the OAuth flow. So the file
opened by denying the feature it implements. Nothing tests a comment, and the cost is
paid exactly once, in the worst place: an interviewer reading the MCP server top to bottom
is told the significant bonus was skipped. Rewritten to describe the two credentials the
file actually accepts.

**A consent screen made a promise the code does not keep.** The last line of the OAuth
consent page read "You can revoke access by signing out of Hatko." I checked it against
the library rather than assuming, and it is false: Better Auth's `getMcpSession` resolves
a token by looking it up in `oauthAccessToken` and never consults the session table, and
the `mcp()` plugin re-exports only `oAuthConsent` from `oidcProvider` — so
`/oauth2/endsession`, the one endpoint that deletes a user's tokens, is not mounted. An
approved client therefore keeps working after sign-out for up to an hour, or seven days if
it refreshes.

The tempting fix was to make the sentence true by deleting the user's token rows on
sign-out, about twelve lines mirroring the existing sign-in intercept. That would have
been wrong, and [docs/mcp.md](docs/mcp.md) already contains the argument against it: a
credential that dies with the user's session is precisely the bearer path's weakness, and
it is the reason OIDC is the documented default. Tying OAuth tokens back to the session
would have removed the property that justifies the whole flow. So the copy now states the
real bound — tokens expire, and deactivating the account is the immediate cut-off — and
`docs/mcp.md` §7 gains the limit it was missing: there is no per-client revoke surface,
and that is the right fix rather than this one. A consent screen that overstates the
user's control is worse than one that admits its limits, because that sentence is exactly
what someone would rely on.

**A comment claimed a transaction that did not exist.** `assertNotLastAdmin` in
[packages/core/src/auth/users.ts](packages/core/src/auth/users.ts) said it was "counted
inside the same transaction as the write so two concurrent requests cannot each see two
admins and each remove one". There was no transaction anywhere in `updateUser` and no
caller wrapping it. The invariant did hold — `node:sqlite` is synchronous and there is no
`await` between the count and the `UPDATE`, so nothing can interleave in this process —
but it held by accident of the driver rather than by design, and it would stop holding the
day someone made that function await anything. The count and the write are now wrapped in
the existing `transaction` helper, so the guarantee belongs to the code.

**The test that was missing was on the half nothing else covers.** Step 8's commit claimed
"one flag, both surfaces, immediately" for deactivation, and the API suite proves the web
half thoroughly: the session goes null, search returns 401, reactivating restores both.
The MCP half runs through a different function — `getUserById`, which the OAuth branch
reaches without passing through `getSessionUser` — and had no test at all. That is the
half that fails silently: the token row stays valid with its expiry untouched, so a
missing check leaves a disabled account querying the corpus through its client for up to a
week. Added, and verified as a real check by deleting the `isDisabled` line and confirming
the test goes red.

**Redundancy found and removed.** `Textarea` in the UI kit had no consumer anywhere — the
chat composer is an `<input>` — so it was speculative surface and is gone.
`listUsersQuerySchema` hand-wrote `limit` and `offset` instead of extending the shared
`paginationSchema` the way `listDocumentsQuerySchema` does, and the two copies had already
drifted to different defaults, which nothing intended. `.env.example` documented
`WEB_PORT` and `BETTER_AUTH_URL`, neither of which any code reads: the web port is Next's
own flag, and Better Auth's `baseURL` is passed explicitly from `API_URL`, so a second
variable naming the same address could only disagree with the first. Both removed from the
example file and from the deploy guide, since that file is the one a reviewer copies.

**Two smaller inaccuracies.** The reranker's docblock illustrated its argument with
`1/(60+1)` although `DEFAULT_RRF_K` is 10 and this project has a pinned test forbidding
k=60; it now states the constant symbolically. And `docs/mcp.md`'s troubleshooting row for
`403 Invalid Host header` still said only "reach the server as localhost", omitting
`MCP_ALLOWED_HOSTS` — the exact failure step 8b was written to prevent, missing from the
table someone hits it in.

**What the audit did not find is worth recording too.** No authorization gap: every admin
route is gated by middleware before its handler, both MCP credentials land on the single
`authorize` call, and the role is never read from request data. No SQL injection surface:
the one interpolated identifier is a sort key mapped through a closed record, and both
`LIKE` filters escape their wildcards. No secret reachable by any read path. The retrieval
and answer layers needed no changes.

Typecheck clean, 194 tests passing.

## Step 9: rate limiting (18 Aug 2026)

Both `docs/mcp.md` §7 and `docs/deployment.md` §10 had named this as a known gap since
they were written: a valid token could drive an unbounded number of rerank calls, and so
could `/answer`. The limit exists for provider spend, not for abuse, and saying which one
decided every design question below.

**Keyed by user, not by IP.** Every route it guards already requires a session, so there
is always a real account to charge, and the spend being capped is per account. IP would
also be the wrong thing to trust behind the reverse proxy the deploy guide recommends: it
arrives in a header the proxy sets, and treating a client-supplied header as identity is
how a limiter becomes decorative.

**A sliding window rather than a fixed one, and that was not the first draft.** The AI
proposed the textbook fixed-window counter — a count and a window-start per key, reset
when the window rolls. It is a line or two shorter and wrong at the boundary: 30 requests
at 11:59:59 and 30 more at 12:00:01 is 60 in two seconds, every window, for ever. Keeping
the timestamps of a key's recent requests instead costs a small array bounded by `max` and
removes the hole, so there was no reason to accept it. A test pins the difference at
specific instants rather than by sleeping.

**Two behaviours I had to go back and fix after writing the tests.** A refused request
originally recorded itself, which meant a caller hammering a closed door pushed its own
recovery further away on every attempt — the limiter would have punished retrying rather
than just refusing it, and a client politely polling once a second would never have got
back in. And `retryAfterSeconds` could round down to `0`, which invites an immediate retry
guaranteed to fail; it is now rounded up and floored at one. Both are tested, and both
were found by asking what a well-behaved client would do next rather than by anything
failing.

**Where the check sits, on each surface, was the decision worth making.** On the HTTP API
it is middleware mounted _after_ `requires`, so authorization refuses an anonymous caller
before anyone's allowance is touched — limiting first would mean counting requests before
knowing who made them, and a flood of unauthenticated requests could exhaust a real
account's budget. There is a test for exactly that. On the MCP server it is inside
`runSearchTool` rather than on the `/mcp` endpoint, because that endpoint also carries
`initialize` and `tools/list`, which touch no model and cost nothing: limiting there would
make a client that reconnects often burn its budget without ever running a search. The
refusal arrives as a tool error naming the wait, not an HTTP 429, since a JSON-RPC client
reads the result rather than the status line — and the message names seconds because the
reader is a language model deciding what to do next.

**One allowance, not one per route.** `/search`, `/answer` and the MCP tool all draw from
the same per-account budget. Separate buckets would let a caller spend twice the intended
amount by alternating endpoints, and `/answer` is the more expensive of the two at three
provider calls against a search's two. Tested by exhausting the allowance through
`/search` and then finding `/answer` closed.

**The limit is configurable, and that is a lesson from this repository rather than a
preference.** `MCP_ALLOWED_HOSTS` exists because the host guard had to be widened twice
after blocking legitimate callers, and the note in that commit was that a control which
blocks legitimate traffic gets switched off rather than tuned. A rate limit with no knob
is the same shape of mistake, so `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_SECONDS` are
environment values, `0` disables the limiter, and both servers print the active setting at
startup — because a protection an operator believes is on when it is off is worse than not
having one.

**Verified rather than asserted.** Both servers were started and their new startup lines
read, including the `DISABLED` warning under `RATE_LIMIT_MAX=0`. Then against the running
API: sign in as the demo admin, send thirty requests that are counted but reach no
provider, and the thirty-first answered `429` with `retry-after: 60` and
`{"error":{"code":"rate_limited",…}}`. `rate_limited` was declared in `apiErrorSchema`
from step 1 and had no producer until now — the same story as the `startup` ingestion
trigger, which sat unused until the watcher earned it.

Both wirings were mutation-tested: removing `throttle()` from the search route fails the
API tests, and deleting the limiter call from `runSearchTool` fails the MCP one. The MCP
test drives the limiter directly to exhaust the allowance rather than making thirty real
searches, which is not a dodge around the thing under test — the check runs before any
embedding, so the one call that matters needs no provider, and what gets pinned is that
the MCP path consults the limiter at all. That is the half no unit test can see, and it
fails silently: forget the call and MCP traffic is simply uncapped while everything else
still passes.

Typecheck clean, 208 tests passing.

## Step 10: streaming answers (18 Aug 2026)

The last search-experience item on `bonus.md`, and the one where the risk is not that it
breaks but that it quietly weakens the guarantee the whole system rests on.

**The invariant, stated before any code was written.** Streaming changes _when_ an answer
arrives, never _what_ it is allowed to claim. Citation validation and the abstain decision
run against the complete text, exactly as before — so a stream can deliver forty words of
confident prose and still terminate in `abstained: true`, because none of it cited a
passage. That is not an edge case to tolerate; it is the correct behaviour, and it is the
one thing a naive implementation gets wrong by treating the fragments as the answer. Three
tests in `packages/core` pin it, including one that streams an uncited sentence word by
word and asserts the published result is still "No documents cover this."

**Content negotiation rather than a second endpoint.** `Accept: text/event-stream` gets the
streamed representation; anything else gets the same answer in one JSON body. The
alternatives were a `/answer/stream` route or a `stream: true` flag in the body, and both
would have meant two documented endpoints for one resource — `curl`, the eval and any
future client keep working untouched, and the browser opts in with a header that already
means this. Both branches call the same `answerQuestion` and record the same analytics, so
there is no second code path to keep in step.

**The JSON envelope had to go, and that was the AI's suggestion.** The answer model was
being asked for `{"answer":"…"}` and unwrapped. Streaming makes that actively harmful: the
deltas would be fragments of a JSON string literal, unrenderable until the closing quote
arrives and carrying escape sequences to decode. A single free-text field gains nothing
from being wrapped, so `chatText` returns prose. Structure is still validated where there
is structure — the reranker's grades keep `chatJson`.

**Always streamed, even when nobody is watching.** `chatText` streams unconditionally and
callers that want the whole answer omit `onDelta`. Two paths would have meant the
incremental one — the one with chunk boundaries mid-character, keep-alive frames and
streams that end without a terminator — being the path with no test and no CLI exercising
it. One path, exercised by everything.

**One SSE reader, in `packages/shared`.** There are two consumers on opposite sides of the
boundary: core reads OpenAI's stream, the browser reads ours. Both need the same thing and
both have the same fiddly part. `EventSource` cannot serve either — GET only, no body, no
cross-origin credentials — so this was code to write rather than a dependency to add, and
the ten tests are all deliberately-chosen chunk boundaries: mid-payload, mid-separator, and
one splitting an em dash across two reads. That class of bug does not fail loudly. It drops
a word or emits a replacement character on some requests and not others, depending on how
the network happened to split the response, and the only way to see it is to choose the
splits yourself.

**Writes are chained, not fired concurrently.** `onDelta` is synchronous and writing a
frame is not, so unawaited writes could interleave the bytes of two SSE events — and half
an event is not something a reader recovers from. Four lines of promise chaining, and
awaiting the terminal event now awaits every event before it.

**A failure after the first byte has no status code left.** The 200 goes out with the
passages, so a provider dying mid-answer cannot be a 502 — it arrives as an `error` event
carrying the same envelope every other route uses. It is classified by calling
`toErrorResponse`, the existing function, and discarding the status it computes: a second
hand-rolled translation in the streaming path is precisely how the streaming path becomes
the one that leaks a stack trace.

### What this found

**A wrong status on an existing failure, made visible by streaming.** Forcing a provider
failure mid-answer produced `500 internal` — "something went wrong on our side" — where the
truthful answer is `502` and "try again in a moment". Cause: `answerQuestion` wrapped every
generator failure in a plain `Error` to distinguish it from abstention, and that wrap cost a
`ProviderError` its type. The JSON path had the same bug since step 4; nothing had exercised
it. A provider outage now rethrows unchanged, with a test, because the distinction from
abstention is made by throwing at all, not by the message. This is slightly outside step 10
and was fixed rather than filed: it is a wrong status on the exact path the step touches.

**The draft must not look like the answer.** The first UI draft rendered streaming text with
the finished component, which would have shown citation chips built from markers not yet
validated, and the deprecation banner before its notices were computed. The draft is now
muted, chip-free, and carries a caret; the terminal event replaces it wholesale. The error
path clears it too — a truncated answer left beside an error card reads as a partial result
when nothing about it was ever checked.

**Accessibility was already handled, by accident.** The turn list is an `aria-live` region
with `aria-busy={pending}`, added in step 6 for a different reason. Because `aria-busy`
suppresses announcements until it clears, screen readers get the finished answer once
instead of ninety-nine delta announcements. It would have been an unpleasant bug and the
existing markup prevented it.

### Verified

Against the running API, with a real key, printing each event and its timing:

- Sample question 2: passages at 1550 ms (six sources, `sdk-notes-v2.md` among them), first
  delta at 2036 ms, 99 deltas, terminal answer at 3000 ms, one citation, and the answer
  states that `lumen.track` is deprecated in v3. The reader sees the evidence roughly a
  second and a half before the answer exists.
- The unanswerable question: passages reported, **zero deltas**, terminal
  `abstained: true`. Abstention is decided before generation, so no false draft is ever
  shown.
- Provider unreachable: `200`, then a single `error` event with `upstream_failed` and no
  internals in the message.
- Provider dying _after_ four deltas: the deltas arrive, then the `error` event, in that
  order — the chained writes hold, and a truncated answer cannot masquerade as a complete
  one. Both failures were forced by temporarily pointing `API_BASE` at a dead path and by
  throwing mid-stream; the file was restored and the diff checked before committing.

The route test asserts the stream ends in exactly one terminal event and that every event
validates against the shared schema, and it runs with or without a provider key — without
one it exercises the failure branch, which is the branch worth having on a fresh clone.

Typecheck clean, 226 tests passing.

---

## Step 11: self-hosted models (18 Aug 2026)

### What AI did

Wrote the whole step: the `OPENAI_BASE_URL` indirection, the migration templating, the
admin model panel and its probe endpoint, `docs/self-hosted.md`, and the tests.

### What the human decided

Three corrections to scope, all of which changed the result:

1. **Add selectable models to the settings UI**, not just environment variables. The step
   as written in CLAUDE.md was env-only; a dropdown beside the API key is what an operator
   actually reaches for.
2. **Direct users who lack the models to install them.** This produced the probe endpoint.
   Without it the panel would have accepted a local selection on a machine with no Ollama
   and let the mistake surface as a 404 on somebody's first question.
3. **Drop `llama3.2:3b` and `qwen2.5:3b` from the offered presets.** Both had been measured
   and both were weak. The instruction was that a bad option should not be offered at all —
   a dropdown entry is an endorsement.

### The design, and what it is not

Ollama, llama.cpp, LM Studio and vLLM all serve `/embeddings` and `/chat/completions` in
OpenAI's own shape. So "self-hosted models" is **a base URL**, not a provider interface with
two implementations. The first instinct was a `Provider` abstraction with an OpenAI class and
an Ollama class; it would have been two classes wrapping one identical `fetch`. What
genuinely differs is two lines: OpenAI requires an API key, and its `dimensions` parameter is
a Matryoshka feature no local model can honour.

### Where AI was wrong, and how it was caught

**The panel told an operator to install a model they already had.** The install prompt
compared the _selected_ preset's models against the _active_ provider's model list — so with
OpenAI active and the local preset selected, it searched OpenAI's 124 models for
`qwen2.5:7b`, failed to find it, and printed `ollama pull qwen2.5:7b` to someone whose Ollama
was running with that model loaded. Caught by reading the rendered panel in a browser, not by
any test — every unit test passed, because each half was individually correct. Fixed by
making the probe follow the selection (`?probe=<presetId>`), and the response now reports
`probedBaseUrl` so the panel can refuse to read an answer about a different host. A preset
id rather than a URL, so an admin-supplied string never becomes a server-side fetch target.

**A claim in the UI that the measurements contradicted.** The first draft of the panel copy
said local answer quality was "measurably lower". Then `qwen2.5:7b` scored 12/12 on the
answer checks — identical to `gpt-4o-mini` — and the sentence became false. Rewritten to the
limits that are real: one validated model, slower, and smaller models rejected for failing to
abstain. This is the second time in this repository that plausible-sounding copy was written
before the measurement and had to be corrected after it.

**The abstain path failed for a reason that was not the abstain path.** `qwen2.5:3b` scored
6/12, with five answerable questions abstaining. The obvious reading was that the local
reranker could not hold the 0.67 threshold. Inspecting the raw completion showed the reranker
was fine — grade 1.00 — and the model had answered `"5 MB"`: correct, and with no `[1]`
marker, so the citation check withheld it as unverifiable. The system was behaving exactly as
designed; the diagnosis would have been wrong without looking at the actual model output. A
worked example was added to the answer prompt, which took `qwen2.5:3b` from 6/12 to 7/12 and
left OpenAI unchanged at 12/12 — re-measured, because changing a shared prompt to help a weak
model is exactly how the strong path regresses unnoticed.

### Verified

Ollama installed on this machine, four models pulled, and every figure below observed:

- **Ingest**: 142 documents embedded with `nomic-embed-text` at 768d in 1.7 s. The vector
  column was created at 768 from `EMBEDDING_DIMENSIONS`, with no schema edit.
- **`qwen2.5:7b`**: recall@1 100%, recall@3 100%, MRR 1.000, **12/12 answer checks**, and the
  relevance grades separate cleanly — answerable 1.0000, unanswerable 0.0000.
- **`qwen2.5:3b`**: 7/12. **`llama3.2:3b`**: 4/12, graded every unanswerable question fully
  relevant, and dragged hybrid recall@1 down to 56%. Both rejected, both recorded in
  `docs/self-hosted.md` rather than silently dropped.
- **OpenAI, re-measured after the prompt change**: recall@1 100%, MRR 1.000, 12/12. No
  regression.
- **Latency**: 4.4 s local against 2.7 s OpenAI for the same question, both correct, both
  citing and both carrying the deprecation notice.
- **Endpoints**, by curl against a running API: GET reports active config plus probe; PUT
  switches to local and lists the five installed models; an unreachable address reports
  `reachable: false` with the connection error; DELETE resets to `.env`; an invalid base URL
  is a 400 naming the field.
- **The panel**, in a browser against a production build: renders the active configuration,
  the measured note per preset, the `ollama pull` commands plus the download link when the
  server is stopped, and the `.env` lines plus rebuild command for the embedding-width
  change. With Ollama running and the model present, no install prompt appears — the bug
  above, fixed and re-checked.

Typecheck clean, 231 tests passing.

### Left undone

The dashboard cannot change the embedding model, and deliberately: the vec0 column width is
a literal, vectors from two models are not comparable, and a form field that quietly empties
search is worse than no field. It prints the `.env` lines and the rebuild command instead.
The migration refuses to open a database whose stored width disagrees with the configured
one, which is the check that turns a silent retrieval failure into a startup error.

### Step 11 follow-up: two bugs the tests did not catch (18 Aug 2026)

Asked to fix the bugs found during step 11, re-reading the new code turned up two more.
Both had passing tests around them, and both were the same class of mistake: a check
asking a _nearby_ question rather than the actual one.

**The API-key panel called a working installation broken.** `getApiKeyStatus` decided
whether a key was needed from `config.isOpenAI` — the provider named in the environment.
But an admin can now switch to a local server _from the dashboard_, which is stored in the
database and leaves that flag true. So an operator running entirely on Ollama with no
`OPENAI_API_KEY` saw "not configured — embedding and answer generation will fail" beside a
system answering questions perfectly well. This is exactly the false alarm the
`self-hosted` state had been added to prevent, reintroduced one function away from itself.
Fixed by resolving through `activeModels`, which is the only thing that knows which
provider is in force. `getApiKeyStatus` also gained the `envFallback` parameter that
`resolveApiKey` already had, for the reason that file already documents: otherwise the
test asserts something about the developer's machine.

**The install prompt ignored the embedding model.** The panel checked whether the selected
preset's answer and rerank models were installed, and not its embedding model — because
the panel cannot _set_ the embedding model, and "cannot set it" quietly became "need not
check it". An operator with `qwen2.5:7b` pulled and `nomic-embed-text` missing therefore
got a clean panel, followed the `.env` instructions, and met the failure at
`npm run ingest`. The list is now `presetModels` in `@hatko/shared`, where it can be
tested; assembling it inline in the component is what let the omission through.

Both fixes carry a regression test, and both tests were **verified to fail against the
old logic** before being kept — restored the two broken lines, watched the two tests go
red, put the fixes back. A test written after a fix that has never seen the bug is a test
that proves nothing.

Typecheck clean, 238 tests passing, format:check clean.

### Step 11 review: the eval script named the wrong models (18 Aug 2026)

A deep review of step 11 before starting step 12. The feature holds up — the provider is a
base URL and not an abstraction, the panel probes before it promises, the vector width is
enforced at open time, and the two rejected models are recorded rather than quietly
omitted. One defect survived it.

**The eval banner reported the environment's provider while calling the database's.**
`packages/core/src/eval/run.ts` printed `config.providerLabel`, `config.rerankModel` and
`config.answerModel` — the values `.env` supplies. Every call underneath it resolves
through `activeModels(db)`, which the same step had just made overridable from the
dashboard. So an admin who switched to Ollama on the settings page and then ran
`npm run eval` got qwen's numbers under a heading saying `gpt-4o-mini`. That is the one
output in this repository whose entire job is to attach a measurement to the configuration
that produced it, and the `measured` strings in `MODEL_PRESETS` and the table in
`docs/self-hosted.md` are both quoted from it.

Found by reading, not by a test: every consumer of the model settings was listed with one
grep, and this was the only one still reading `config`. Verified by copying the indexed
database, writing the three override rows into `settings` by hand, and running the eval
against the copy — the banner now reads `Provider localhost:11434 — … rerank qwen2.5:7b,
answer qwen2.5:7b` where it previously read OpenAI. The embedding model deliberately stays
on `config`, because it is env-only by design and cannot be overridden.

No test added: the divergence it would assert is already pinned by "a stored model choice
overrides the environment" in `settings.test.ts`, and a test that a console banner
interpolates the variable next to it would be asserting the line it duplicates.

Typecheck clean, 238 tests passing, format:check clean.

## Step 12: the 3D embedding view (18 Aug 2026)

AI wrote the PCA implementation, the projection endpoint, the canvas panel and the tests;
the shape of the step — Gram matrix, power iteration, canvas, no dependency — was fixed in
`CLAUDE.md` before any of it was written, so the model was implementing a decision rather
than making one.

**What this panel is for.** Three documents in this repository assert that 78 of the 142
files are near-identical delivery reports and that the vector arm therefore cannot tell
them apart. Until now that was a sentence. The measurement the panel now shows: the
delivery reports occupy an RMS radius of **0.08** where the whole corpus occupies **0.68** —
one eighth of the spread for 55% of the documents. Verified before the UI was written, by
running `getEmbeddingMap` against the indexed database and printing the per-category radii.

**Three things the model got right without prompting**, all of them the kind of detail that
would have been invisible if wrong:

- **Centring before the Gram matrix.** Skip it and the first component is the corpus mean,
  which for unit-length embeddings dominates everything and collapses the plot to a dot.
- **One scale factor across all three axes.** Normalising each axis to its own range would
  stretch a third component carrying 8.6% of the variance to the same visual width as the
  first, turning a flat corpus into a convincing cloud that is not there.
- **A deterministic starting vector** (`sin(i)`, not `Math.random()`), so the same corpus
  produces the same picture on every load. A random start mirrors and rotates the plot
  between page loads, which would make two screenshots of an unchanged corpus disagree.

**Where review changed the output.** Three corrections, all made by reading rather than by
a failing test:

1. **Rayleigh quotient removed.** The first draft computed the eigenvalue estimate with a
   nested `reduce` inside the iteration loop — a second O(n²) pass for a number the
   normalisation already had. A Gram matrix is positive semi-definite, so `‖Av‖` for a unit
   `v` _is_ the eigenvalue estimate.
2. **The plot was drawn full-bleed.** At 1196px wide with a projection scaled by the shorter
   side, the corpus rendered as a speck in the middle of a sheet of paper. Capped and
   centred.
3. **Series colours became tokens.** The palette was going to be hex values in the
   component, which `docs/design.md` §11 rejects by name. They are now `--series-1..7` in
   `globals.css` and documented in §1.3a — and the canvas has to read them with
   `getComputedStyle`, which only works because they are custom properties.

**The tests were verified to fail against broken logic**, not written after the fact and
assumed to work. Deflation disabled: the variance-ordering test goes red. Centring removed:
that test and the degenerate-input test both go red. The failure mode being defended
against is the one that matters here — every one of these mistakes still draws a plausible
picture, and an operator would read a wrong conclusion off it with nothing to say anything
was amiss.

**What was verified live and what was not.** The endpoint was exercised end to end: 200 with
142 points for the demo admin, 403 for the demo user, 30 KB of payload, 23 ms to compute.
The panel was rendered in a browser against the real corpus and captured — the delivery
reports appear as a dense knot, meeting notes as a second cluster, the rest scattered,
matching the numbers above. One presentational change landed **after** that capture (the
width cap in fix 2), and the browser pane became unavailable before it could be
re-photographed, so that specific change is verified by typecheck and by reading, not by a
second screenshot.

Typecheck clean, 242 tests passing, format:check clean.

## Full audit of steps 1–12, and the five defects it found (18 Aug 2026)

Every step in §9 of the working agreement was re-verified against a running system rather
than against its own commit message, on the user's instruction to "check every single step
and verify it implemented without any bug and keeps the promise". The exercise was worth it:
the numbers all held, and five defects came out of it that no test in the repository covered.

**What was confirmed by measurement, not by reading.** The eval was re-run
(`--rerank --answers`) and reproduces the claimed keyword/hybrid recall@1 100%, MRR 1.000,
12/12 answer checks. The self-hosted claim in `MODEL_PRESETS` was re-measured independently
on a separate 768-dimension index — qwen2.5:7b with nomic-embed-text, recall@1 100%,
MRR 1.000, 12/12 — so that string is a measurement and not a memory. The 3D view's premise
was checked arithmetically off the endpoint: mean intra-cluster distance 0.136 among the
delivery reports against 0.954 for everything else, a sevenfold difference, which is the
claim the whole hybrid design rests on. Deactivation was confirmed to be a real revocation:
an already-issued cookie stops resolving immediately, not at expiry. Ingestion was driven
through change, deletion, an empty file, a symlink and a `node_modules` directory on a
scratch corpus, and the run log matched the disk every time. `hatko.tugrap.dev` was checked
and is still a parking page, which is what §9 says.

**Defect 1 — `cp .env.example .env` broke every backend process.** The worst of the five and
the one a grader would have hit first. `.env.example` ships `OPENAI_API_KEY=` with a comment
inviting you to leave it blank and set the key from the admin UI. `process.loadEnvFile` reads
that as `''`, and `z.string().min(1).optional()` rejects `''`, because `.optional()` admits
`undefined` and not the empty string. So the documented first command of a fresh install
threw `OPENAI_API_KEY: Too small` at import, in migrate, seed, ingest, eval, the API and the
MCP server — `npm run setup` died on `db:migrate`.

Three separate promises depended on this working: `.env.example`'s own comment, the
admin-managed-key feature in §3 (which exists so an operator can stand the system up
_without_ a key and enter one in the browser), and `docs/self-hosted.md`'s "No API key is
required". All three were false as shipped.

Why nothing caught it: the machine it was written on has a real key in `.env`, and every
test that touches key resolution injects `envFallback` explicitly — `resolveApiKey`'s own
comment explains that config.ts snapshots `process.env` at import, so tests deliberately
avoid that path. The single configuration no developer is ever in is the one every new
reader starts in. The fix strips blank values from the whole env object rather than patching
that one field, because every `.default()` has the same hole for the same reason: blanking
`API_PORT=` to "use the default" would have failed too. The test spawns a child process with
`.env.example`'s contents and asserts config loads — asserted against the file itself, since
the bug was a disagreement between that file and the schema and a test restating the file
could not see it. Verified to fail when the fix is reverted.

**Defect 2 — `?next=` was inert for every route but one.** `app/(app)/layout.tsx` called
`requireUser('/chat')` with a hardcoded destination, and a layout resolves before the page
inside it, so `dashboard/page.tsx` passing the correct `/dashboard` never ran. An anonymous
request for `/dashboard` redirected to `/sign-in?next=%2Fchat`, and an admin who followed a
link to the dashboard signed in and landed on the chat page. The whole round trip existed
and was carefully built — `safeNext` correctly refuses absolute, protocol-relative and
`javascript:` destinations, all three verified — and one literal made it pointless.

A layout is not given the pathname, so the fix publishes it in a request header from
`proxy.ts`. Worth recording that the file convention was checked rather than assumed:
`middleware.ts` is **deprecated in Next 16** and renamed to `proxy.ts` with the export
renamed to match, which the local `node_modules/next/dist/docs` says plainly and training
data would not. The header constant lives in its own import-free module because the same
docs warn that a proxy may be deployed to a CDN and should not rely on shared modules — and
`lib/session.ts`, the natural home, imports `next/headers`.

**Defect 3 — the OIDC discovery documents described a system that does not exist.** Both
advertised `jwks_uri`, which answers 404, and `RS256`, while the issued `id_token` is in fact
HS256 — verified by decoding one from a completed authorization-code flow. Migration 007
deliberately installs no JWT plugin and no `jwks` table, and that decision is right: opaque
tokens are revocable by deleting a row where a self-contained JWT is not. Better Auth
generates the metadata assuming its asymmetric setup, and nobody had reconciled the two. A
strict OIDC client validating the ID token against the advertised JWKS would fail on a
document we published. Corrected downward — `jwks_uri` removed, since HS256 is symmetric and
there is no public key to publish — rather than installing the plugin to make the original
claims true, which would have traded revocation for a signing key to rotate in order to
satisfy a document nothing in the MCP flow reads.

**Defect 4 — a missing account was a 409.** `PUT /api/admin/users/nope` answered
`409 conflict: No such account.`, because `updateUser` threw `UserManagementError` for both
the lockout guards and a bad id, and `errors.ts` maps that type to 409 wholesale. A `404`
subclass, tested before its parent so the ordering cannot silently reinstate the 409.

**Defect 5 — `limit` truncated before the reranker could read anything.** Found while
verifying deployment readiness, and the most consequential of the five, because it is on the
top-graded axis. Both search surfaces called `hybridSearch({ limit })` and then `rerank`, so
the caller's `limit` — 1 to 20 on `/api/search` and on the MCP tool — decided the candidate
set _before_ any passage was graded. Measured on sample question 3:

    limit=1  guides/asset-naming.md   fused 0.174   judged 0.67
    limit=6  build-pipeline.md        fused 0.168   judged 1.00

At `limit=1` the document that answers the question was not in the response at all. It loses
on fused score and wins on judged relevance, which is the entire reason the rerank pass
exists — `rerank.ts` says so in its first paragraph, and §5 of the working agreement says no
lexical or vector tuning can substitute for it. The pass was being neutered by an argument
the caller controls, and it fails silently: a worse answer, never an error.

`retrieveAndRerank` now owns the ordering for all three surfaces — draw at least
`MIN_RERANK_CANDIDATES`, grade all of them, then cut to `limit`, so `limit` can only widen
what gets judged. `DEFAULT_ANSWER_PASSAGES` is defined as that constant rather than its own
`6`, because two literals meaning "how deep does the grader read" would eventually disagree.
The answer path was already correct by accident of its fixed depth, which is exactly the
drift `requireMcpPermission` warns about in a different context: one decision implemented
twice, and the copy nobody looks at is the one that is wrong. Re-measured after the change:
recall@1 100%, MRR 1.000, 12/12 — unchanged at the measured depth, fixed at small limits.
The test marks the passage fusion ranks _last_ as the only relevant one, so it can only pass
if grading precedes truncation; verified to fail against the old order.

**Six lower-priority items, all fixed.** An in-place `UPDATE` of a chunk's text kept
`chunks_fts` correct and left `chunks_vec` holding the old embedding, so the two arms of one
retriever would disagree about what a passage says with nothing reporting a fault. Nothing in
the pipeline does it — `replaceChunks` deletes and reinserts — but a test asserted the update
path worked, which read as an endorsement. Migration 009 refuses the operation and that test
now pins the refusal; asserting a path that silently corrupts the index was worse than having
no test. `EADDRINUSE` crashed both servers through an unhandled `error` event with twenty
lines of Node internals and no mention of the port, which is how this audit began; both now
name the port and the variable to change. Two `eslint-disable` directives were the only
mentions of eslint in a repository that has never had it. Fourteen inferred type exports in
`packages/shared` had no consumer in either direction across the boundary. `seed.ts` told
operators their credentials were "listed in the README", which does not exist yet. And
`path.relative(repoRoot, …)` printed a corpus outside the repository as
`../../../../../private/tmp/…`, longer than the absolute path it was shortening, in exactly
the case the brief cares about — pointing `CORPUS_PATH` at the real corpus somewhere else.

**Deployment readiness.** The production web build had never been run: `next build` succeeds
and reports `ƒ Proxy (Middleware)`, confirming `proxy.ts` is registered for production and
not only for dev. A fresh install was then driven end to end in isolation from
`.env.example` alone — migrate (9 migrations), seed, ingest (142/142), both servers up, demo
credentials, role gating, a grounded answer with a citation, an abstention, and the MCP tool
over a bearer token. Under `NODE_ENV=production` the session cookie is issued as
`__Secure-…; HttpOnly; Secure; SameSite=Lax`, and with `MCP_ALLOWED_HOSTS=hatko.tugrap.dev`
the host guard accepts the proxied hostname, still answers 403 to `evil.example.com`, and
discovery advertises the public origin rather than localhost.

Typecheck clean, 245 tests passing, format:check clean, eval unchanged.
