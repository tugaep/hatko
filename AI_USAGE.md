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
symlinked in to resolve workspace packages, and that symlink points `@sorrel/core`
back at the _fixed_ tree. A "before" run of anything importing `@sorrel/core` by
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
`answerResponseSchema` and `sessionResponseSchema` exist in `@sorrel/shared` and no
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
  `@sorrel/core` barrel**, so the API ships the evaluation set.
- **Importing `@sorrel/core` still requires `BETTER_AUTH_SECRET` and opens the
  database.** Verified: `import('@sorrel/core')` with the secret unset throws
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
into `@sorrel/shared`, the schema is built from it, and `categoryOf` truncates to
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
longer re-exported from the `@sorrel/core` barrel. And `auth` became `getAuth()`,
built on first use — `import('@sorrel/core')` no longer throws
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

`listDocuments` is the one flagged item deliberately kept. It has no production
caller — `listDocumentsFiltered` is what the API uses — but five tests read "every
document", and replacing it means `{ limit: 1000, offset: 0 }` at each of them.
Deleting four lines to add ten is not a saving, so it stays, recorded as a choice
rather than left looking like an oversight.

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
