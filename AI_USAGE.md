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

### 1. Claimed hybrid retrieval was better, then measured it as worse

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

### 2. Wrote a deprecation detector that would have flagged the wrong document

`sdk-notes-v2.md` is deprecated; `sdk-notes-v3.md` is current and says _"It
supersedes v2."_ A regex matching "supersede" anywhere flags **v3** — inverting
exactly the distinction sample question 2 exists to test, and silently: retrieval
still works, the wrong document just wears the badge.

**Caught by:** writing the test against the real corpus text before the
implementation was accepted. Only the passive direction now matches, asserted in
both directions.

### 3. Built a category enum from the sample corpus's folder names

`documentCategorySchema` was written as `z.enum(['guides', 'changelogs', ...])`.
Both `TASK.md` and `RULES.md` require that pointing ingestion at the _real_ corpus
be straightforward — and this would have failed validation on every document in a
corpus organised differently.

**Caught by:** the must-have audit before committing step 1. This is the concrete
reason that checklist exists, and it is now drift rule #1.

### 4. Tried to fix a requirement with prompt engineering, three times

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

### 5. Wrote a test that leaked my live API key into the terminal

A settings test asserted "no key is configured". `config.ts` loads `.env` from
disk regardless of shell environment, so once I added a real key the test found
it, failed, and printed the key in full in the assertion diff.

**Caught by:** running the suite after adding the key. The AI flagged it
immediately and unprompted, and told me to rotate the key — which I did. The
environment fallback is now an explicit parameter, so the test cannot read
ambient state.

### 6. Built ahead of the agreed scope

Step 1 shipped a streaming-answer schema and a `users:manage` permission. Both
belong to bonus items I had explicitly declined. Small — about ten lines — but
they imply features that will not exist.

**Caught by:** the same must-have audit. Now drift rule #2: _a schema for an
unselected bonus is drift even when it costs ten lines._

### 7. Estimated 450 chunks; the real number is 142

Carried as an assumption from the first corpus analysis into schema comments and
the working agreement, then repeated back to me as if measured. The chunker
produces exactly one chunk per document, because every file is smaller than the
chunk target.

**Caught by:** actually measuring it before writing the commit message. The
figures are corrected everywhere they appeared. The outcome turned out to be
_correct_ — `sample_questions.md` names expected answers as whole documents — but
it was right by luck, not by design, until it was measured.

### 8. Its own tooling polluted the provided dataset

The claude-mem plugin wrote `CLAUDE.md` context stubs into `sample_dataset/` and
`sample_dataset/corpus/`, and they were committed with the initial scaffold. The
corpus copy would have been ingested as a 44-byte document, corrupting document
counts in a dataset I am not supposed to modify.

**Caught by:** a file listing during step 2 that showed 143 markdown files where
the corpus has 142. Removed, and the path is now gitignored.

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

- **The eval measures retrieval, not answer content.** It scores recall and MRR
  over expected documents. Failure #4 passed retrieval while failing the actual
  requirement. An answer-level assertion — "this answer must mention the
  deprecation" — would have caught it, and is not built.
- **The vector arm's contribution is unproven on unseen queries.** It ties
  keyword-only on this eval set, where questions share vocabulary with their
  answers. Its value is a hypothesis about the private set.
- **The rerank grade threshold is calibrated on 12 questions.** Separation is
  clean today (answerable 1.00, unanswerable ≤0.33, threshold 0.67) but that is a
  small sample.
