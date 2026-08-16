# Sorrel — Brand

## What it is

Sorrel is a semantic search and grounded-answer tool for a studio's internal document corpus. You ask a question in plain language; it finds the passages that actually answer it and writes an answer that cites them. When the corpus doesn't hold the answer, it says so.

## The name

Sorrel is a wild green you forage — you find it by knowing where to look, not by walking into a shop. That is the product: the answer already exists somewhere in the corpus, and the work is knowing where to look.

It also earns the palette. A dark green brand named Sorrel is coherent; a dark green brand named Cortex or Nexus is a color bolted onto a word. And it opens a visual world — botanical field guides, seed packets, apothecary labels — that maps unusually well onto a document index: labeled specimens, catalog numbers, plates, provenance.

Two syllables, easy to say out loud, unclaimed in developer tooling.

## Positioning

**For** teams whose knowledge is scattered across hundreds of documents nobody has read end to end,
**Sorrel** is an internal retrieval tool
**that** answers questions with passages you can verify,
**unlike** a chat assistant that sounds confident and cites nothing.

The competitor is not another search box. It is the colleague who half-remembers the answer.

## The one principle

**Show your work.**

Every claim carries its source. Every source is one click from the passage it came from. The interface never asks you to take its word for anything — retrieval scores are visible, deprecated documents are flagged, and an answer built on thin evidence looks thin.

This is a design constraint, not a slogan. It rules out the confident-blob-of-prose answer UI that most RAG products ship. Citations are not decoration appended after the fact; they are the load-bearing element, and the layout should reflect that.

## Voice

Plain, precise, quietly certain. Sorrel sounds like a good technical writer, not a product marketer.

| Do                                    | Don't                                           |
| ------------------------------------- | ----------------------------------------------- |
| "No documents cover this."            | "I couldn't find anything, sorry!"              |
| "Indexed 142 documents in 12s."       | "Success! Your corpus is ready 🎉"              |
| "sdk-notes-v2 is deprecated. See v3." | "Note: there may be a newer version available." |
| "Ingestion failed on 3 files."        | "Oops! Something went wrong."                   |

Rules:

- State the fact before the feeling. Never open with an apology.
- Numbers over adjectives. "12 results in 240ms", not "found lots of results fast".
- No exclamation marks. No emoji in product UI.
- Uncertainty is stated flatly, never hedged into mush. "The corpus does not cover this" is a complete, correct answer and should read like one.

That last rule is the whole product. The system's most important behavior is refusing to answer when it shouldn't, and the copy has to make that refusal feel like competence rather than failure. If the abstain state reads as an error, the design has undermined the engineering.

## The mark

A sorrel leaf reduced to flat geometry: a shield-shaped leaf built from three solid shapes, one center vein, no outline, no gradient.

The vein is drawn as a vertical bar with a slight taper. At 16px and below the leaf silhouette drops away and the vein reads as a text caret — a search cursor. Leaf at large sizes, cursor at small. One shape, two readings, which is what a mark should do.

**Construction**: 24×24 grid, 2px minimum stroke equivalent, all curves on 4px increments. Solid `--color-green-800` on light, `--color-green-200` on dark. One-color only — never a two-tone or gradient version.

**Clear space**: one leaf-width on all sides. **Minimum size**: 16px. Below that, use the caret alone.

**Wordmark**: `Sorrel` set in Fraunces, weight 500, optical size at display, tracking `-0.02em`. Lowercase-sensitive — always capital S, never all-caps, never all-lowercase.

## Visual world: flat vector packaging

The reference is a seed packet or a botanical field-guide plate — printed matter that has to organize dense information in a small rectangle, using ink and rules rather than depth.

What this means concretely:

**Ink on paper, not glass.** Deep green on warm off-white. The interface is a printed surface, not a lit one. No glassmorphism, no translucency, no glow.

**Rules do the work of shadows.** Hierarchy comes from hairline borders, fill weight, and negative space. Flat is the constraint — a shadow is an admission that the layout failed to separate two things. (One exception, for overlays, specified in `design.md`.)

**Everything is labeled and numbered.** Documents, chunks, ingestion runs, and results all carry mono catalog numbers, the way a specimen plate does. This is native to the aesthetic and it happens to be exactly what a retrieval system needs — every result must be traceable to a source.

**Solid fills, no gradients.** Illustrations use at most four palette colors, geometric construction, consistent 2px stroke where stroked, no outline on filled shapes, no texture, no noise.

### Four recurring motifs

1. **The label frame** — a 1px rule inset from the card edge with the catalog number in the top-right corner. The signature component; it wraps source cards, stat tiles, and document rows.
2. **The corner notch** — a small diagonal cut on the top-right of primary cards, borrowed from a tear-open packet. Used sparingly, on one element per view.
3. **Hairline rules** — 1px dividers as the primary structural device, generously spaced.
4. **Catalog numbers** — IBM Plex Mono, small, uppercase, tracked out. `DOC-0142` · `CHUNK-08` · `RUN-2026-08-17`.

### Illustration

Flat vector botanical plates for empty states and the sign-in page. Specimen-style: a single plant form, centered, drawn in two or three flats from the green scale plus one ochre accent. No people, no isometric offices, no floating UI cards, no 3D.

Each empty state gets a different specimen so the surfaces are distinguishable at a glance: a fern frond for empty search, a seed for an empty corpus, a pressed leaf for no results.

## What Sorrel is not

- Not a chatbot. There is no avatar, no typing indicator with three bouncing dots, no personality.
- Not a wellness brand. The botanical world is _field guide_, not _herbal tea_. Precise, archival, slightly severe — not soft or soothing.
- Not dark-mode-first. The default is paper. Dark mode exists and is properly designed, but the brand lives on light.
- Not playful. No rounded-everything, no bright multi-hue palette, no illustration mascots.

## Applying it

`design.md` holds the tokens, type scale, component specs, and verified contrast ratios. Everything here should be traceable to something implementable there — if a brand statement doesn't produce a token or a rule, it isn't doing any work.
