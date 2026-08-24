# The corpus

**`corpus/` is not in this repository.** Run `npm run corpus:fetch` and it appears —
1083 markdown documents, about twenty minutes, no API key needed. `npm run setup` does it
for you as its first step.

## Why the data is not here

It is text from the English Wikipedia, which is published under CC BY-SA 4.0 — a
share-alike licence. Committing it would attach that obligation to everyone who clones
this repository, over text none of us wrote, in a project whose own code is MIT. Shipping
the recipe instead keeps the two licences from having to be reconciled: what is version
controlled is `scripts/wiki-corpus.mjs` and the category list in `package.json`, both
original work, and the Wikipedia text stays at Wikipedia.

Nothing about the system depends on this particular corpus. Point `CORPUS_PATH` at a
directory of your own markdown and ingestion, retrieval and the dashboard work the same;
the eval set in `packages/core/src/eval/questions.ts` is the only thing that names
specific documents.

## What `npm run corpus:fetch` retrieves, and under what licence

Articles from the English Wikipedia, walked from eleven Circassian categories and
converted to markdown. Once fetched, that text is
**[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)** and stays that way —
this repository's MIT licence does not cover it. In short, and not as a substitute for
reading the licence: you may reuse and adapt it, including commercially, provided you
attribute it and release your adaptation under the same terms.

The corpus is regenerated rather than pinned, so a fetch today will not match one from
last year — Wikipedia articles and category memberships change. That is a fair
description of the system's actual job.

**Attribution.** Each file's `# ` heading is the title of the Wikipedia article it came
from, so a document is traceable to its source at
`https://en.wikipedia.org/wiki/<article title>`, where the page history carries the list
of authors. The directory a document sits in is the Wikipedia category it was first
reached through, which is a fact about the category graph rather than about the document.

**What the conversion changed.** Articles were fetched as plain-text extracts, so
infoboxes, tables, images, references, and inline citation markers are absent; section
headings survive as markdown headings. Nothing was rewritten, reordered, or summarised —
the prose is Wikipedia's. Text that is missing is missing entirely rather than altered.

**Why this corpus.** It replaced a corpus of invented internal documents. Wikipedia was
chosen because it is freely licensed, densely cross-referential, and full of genuinely
near-identical articles — several hundred short biographies sharing most of their
vocabulary — which is the retrieval problem this system is built to handle rather than an
accident of the sample.

**A different corpus.** `npm run corpus:wikipedia -- <out-dir> <max-files> <categories>`
takes any category list. Wikipedia's
[API terms](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use) apply to the
fetch; the script identifies itself, requests serially, and honours `Retry-After`.

**Tests.** The 23 tests whose subject is retrieval on a large corpus skip with an
instruction when it is absent, so `npm test` on a fresh clone is 264 passing and 0
failing. Everything asserting ingestion mechanics runs against a small fixture corpus in
`packages/core/src/testing/`, which is original writing and is committed.

## Questions

`sample_questions.md` is original to this repository and covered by its licence, not by
CC BY-SA. It names Wikipedia documents but quotes none of them.
