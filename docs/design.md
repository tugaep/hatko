# Hatko — Design System

Implementation spec for the web UI. Brand rationale lives in [brand.md](brand.md); this file is tokens and component contracts.

Every contrast ratio in this document was computed, not estimated. Numbers are WCAG 2.1 relative-luminance ratios.

---

## 1. Color

### 1.1 Raw scales

Three families. Green carries the brand and all structure. Ochre and clay are accents with fixed jobs — ochre for attention and highlighting, clay for destructive and deprecated. A muted slate handles neutral-informational so it can't be confused with either.

```
Green    50  #EEF4F0    Ochre   200  #F2DFB8    Clay   200  #F0D3C9
         100 #D9E7DF            400  #E0A952           400  #DE8465
         200 #B4CFC0            500  #C8892C           500  #B4482F
         300 #87B29C            600  #A66E1F           600  #93361F
         400 #5A9077
         500 #3A7059    Slate   500  #4A6670
         600 #2A5A46            600  #3A525A
         700 #1F4536
         800 #173428    Stone   rule          #E2DCCE
         900 #11261D            rule-strong   #CFC7B4
         950 #0A1712            interactive   #8A8674
                                text-muted    #6B6455

Paper    #F7F4EC (ground)   #FFFDF7 (raised)   #EEEAE0 (sunken)
Ink      #EDE8DC (dark-mode text)   #8A9A8F (dark-mode muted)
```

**Green 800 `#173428` is the primary brand color.** Deep, slightly desaturated, unmistakably green without tipping into emerald or teal.

### 1.2 Two hard rules

**Ochre is a fill, never text on paper.** `ochre-500` on paper is 2.70:1 — it fails. Ochre appears as a background with dark ink on top, or as `ochre-600` (3.92:1) for icons and 18px+ text only. Never ochre body copy on light.

**Borders that mean something clear 3:1.** Decorative dividers may be faint (`--rule` is 1.24:1 and that's fine — it separates, it doesn't inform). But any border that defines an interactive target — input outlines, button edges, checkbox frames — uses `--border-interactive`, which clears the 3:1 non-text threshold.

### 1.3 Semantic tokens

```css
/* Light (default) */
--bg: #f7f4ec;
--bg-raised: #fffdf7;
--bg-sunken: #eeeae0;
--bg-inverse: #11261d;

--text: #0a1712; /* 16.70:1 on bg */
--text-muted: #6b6455; /*  5.34:1 on bg */
--text-inverse: #f7f4ec;

--rule: #e2dcce; /* decorative dividers */
--rule-strong: #cfc7b4;
--border-interactive: #8a8674; /*  3.33:1 on bg, 3.59:1 on raised */

--brand: #173428; /* 12.26:1 with paper text */
--brand-hover: #1f4536;
--brand-active: #0a1712;
--brand-subtle: #d9e7df; /* 12.47:1 with green-900 text */

--focus: #2a5a46; /*  7.21:1 on bg */

--attention: #c8892c; /* fill only */
--attention-subtle: #f2dfb8; /* 12.15:1 with green-900 text */
--attention-text: #a66e1f; /* icons + 18px↑ only */

--danger: #93361f; /*  6.85:1 with paper text */
--danger-subtle: #f0d3c9; /* 11.27:1 with green-900 text */
--danger-text: #b4482f; /*  4.89:1 on bg */

--info: #3a525a; /*  7.54:1 on bg */
--highlight: #f2dfb8; /* 14.00:1 with ink — search term marks */
```

```css
/* Dark */
--bg: #0a1712;
--bg-raised: #11261d;
--bg-sunken: #060f0b;
--bg-inverse: #ede8dc;

--text: #ede8dc; /* 15.01:1 on bg */
--text-muted: #8a9a8f; /*  6.20:1 on bg, 5.38:1 on raised */
--text-inverse: #0a1712;

--rule: #22402f;
--rule-strong: #2e5240;
--border-interactive: #557a64; /*  3.81:1 on bg, 3.30:1 on raised */

--brand: #b4cfc0; /* inverts: pale fill, dark ink — 11.04:1 */
--brand-hover: #d9e7df;
--brand-active: #87b29c;
--brand-subtle: #173428;

--focus: #e0a952; /*  8.71:1 on bg, 7.56:1 on raised */

--attention: #e0a952;
--attention-subtle: #4a3a17;
--attention-text: #e0a952; /*  8.71:1 on bg */

--danger: #b4482f;
--danger-subtle: #3a1e15;
--danger-text: #de8465; /*  6.64:1 on bg, 5.76:1 on raised */

--info: #8fa8b0;
--highlight: #4a3a17; /*  9.00:1 with ink */
```

Note the brand inversion in dark mode: the primary button becomes a **pale green fill with dark ink**, not a dark green fill. A dark-green button on a dark-green ground has nowhere to go.

### 1.3a Categorical series

One place in the product needs several colours that mean _different_ rather than _better_ or _worse_: the dashboard's embedding view, which plots every indexed passage coloured by category. Categories are an open string, so the palette cycles.

```css
--series-1: #173428; /* green 800 */
--series-2: #c8892c; /* ochre 500 */
--series-3: #b4482f; /* clay 500  */
--series-4: #3a525a; /* slate 600 */
--series-5: #5a9077; /* green 400 */
--series-6: #de8465; /* clay 400  */
--series-7: #6b6455; /* stone     */
```

Assigned largest category first, so the biggest group gets the darkest ink. These are tokens rather than raw scale values in the component for the reason section 11 gives — and because a canvas reads them back with `getComputedStyle`, which only works on custom properties.

**Colour is never the only carrier.** The legend states each category's name and count beside its swatch, and hovering a point names the document. A reader who cannot separate ochre from clay loses nothing that is not also written down.

### 1.4 Verified contrast

| Pair                                             | Ratio | Grade   |
| ------------------------------------------------ | ----: | ------- |
| `--text` on `--bg` (light)                       | 16.70 | AAA     |
| `--text-muted` on `--bg` (light)                 |  5.34 | AA      |
| paper on `--brand` — primary button, light       | 12.26 | AAA     |
| ink on `--brand` — primary button, dark          | 11.04 | AAA     |
| `--text` on `--bg` (dark)                        | 15.01 | AAA     |
| `--text-muted` on `--bg` (dark)                  |  6.20 | AA      |
| `--danger-text` on `--bg` (light)                |  4.89 | AA      |
| `--danger-text` on `--bg-raised` (dark)          |  5.76 | AA      |
| green-900 on `--attention-subtle` — badge, light | 12.15 | AAA     |
| ink on `--highlight` (dark)                      |  9.00 | AAA     |
| `--border-interactive` on `--bg` (light)         |  3.33 | AA (UI) |
| `--border-interactive` on `--bg` (dark)          |  3.81 | AA (UI) |
| `--focus` on `--bg` (light)                      |  7.21 | AA (UI) |
| `--focus` on `--bg` (dark)                       |  8.71 | AA (UI) |

Every text token clears 4.5:1 in both themes. Every interactive boundary clears 3:1.

---

## 2. Typography

Three families, three distinct jobs. Any of them doing another's job is a bug.

| Family                          | Job                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Fraunces** (variable)         | Display, page titles, section headings, empty-state copy. Carries the field-guide character.        |
| **Geist** (variable)            | All UI: body, labels, buttons, tables, form text. A Swiss neo-grotesque in the Helvetica/Univers line. |
| **Geist Mono** (variable)       | Catalog numbers, document paths, scores, timestamps, chunk IDs, code.                               |

Fraunces runs at `opsz` matched to size and `WONK 1` at 30px and above only — the wonk is character at display size and noise at 20px.

Geist and Geist Mono replaced Inter and IBM Plex Mono, which were two unrelated families doing adjacent jobs. Geist's closed apertures and horizontal terminals are the point of it, so the `cv05, cv11, ss03` that used to open Inter's terminals went with Inter rather than being carried over as three no-ops. The fallback chain is `'Helvetica Neue', Helvetica, Arial` — the faces the UI font was chosen to resemble, so an unloaded state has the same proportions. `system-ui` is deliberately absent: it is a different design on every OS, which is the opposite of what a fallback is for.

Tabular figures are applied contextually via `.tabular`, never globally — prose should not be tabular.

### Scale

| Token        | Size / LH | Tracking | Family        | Use                        |
| ------------ | --------- | -------- | ------------- | -------------------------- |
| `display-lg` | 48 / 1.05 | −0.03em  | Fraunces 500  | Sign-in, marketing surface |
| `display`    | 38 / 1.10 | −0.025em | Fraunces 500  | Page hero                  |
| `h1`         | 30 / 1.15 | −0.02em  | Fraunces 500  | Page title                 |
| `h2`         | 24 / 1.25 | −0.015em | Fraunces 500  | Section                    |
| `h3`         | 20 / 1.30 | −0.01em  | Geist 600     | Card title                 |
| `h4`         | 16 / 1.40 | −0.005em | Geist 600     | Sub-head, table caption    |
| `body`       | 16 / 1.60 | 0        | Geist 400     | Answers, prose             |
| `body-sm`    | 14 / 1.55 | 0        | Geist 400     | UI default, table cells    |
| `caption`    | 12 / 1.40 | 0.01em   | Geist 400     | Metadata, helper text      |
| `eyebrow`    | 12 / 1.00 | 0.08em   | Geist 600     | Uppercase section labels   |
| `mono`       | 13 / 1.50 | 0.02em   | Geist Mono 400 | Paths, snippets            |
| `mono-label` | 11 / 1.40 | 0.06em   | Geist Mono 500 | Uppercase catalog numbers  |

**Measure**: answer prose caps at `68ch`, and so does the question chip above it — the chip used to align to the column edge instead, landing its right side 119px past the end of every line beneath it. The chat column takes `1fr` beside a `320-400px` evidence rail; a fixed `720px + 360px` left 112px of unexplained space at 1280. Never let generated prose run the full width of a desktop viewport.

---

## 3. Space, shape, line

**Spacing** — 4px base: `4 8 12 16 20 24 32 40 48 64 80 96`. Nothing off-scale.

**Radius** — three values, and that is the whole set:

| Token         | Value    | Applies to                             |
| ------------- | -------- | -------------------------------------- |
| `radius-none` | `0`      | Cards, frames, panels, tables, banners |
| `radius-sm`   | `3px`    | Buttons, inputs, chips, badges         |
| `radius-full` | `9999px` | Status dots, avatars only              |

Sharp corners on containers are the packaging look. The 3px on controls is the minimum that stops a small filled rect from looking like an accident.

**Borders** — `1px` default, `2px` for selected/active. Never 3px+.

---

## 4. Elevation without shadow

Flat means separation comes from fill and rule, not depth.

| Level | Recipe                                                          | Use                                   |
| ----- | --------------------------------------------------------------- | ------------------------------------- |
| L0    | `--bg`                                                          | Page ground                           |
| L1    | `--bg-raised` + 1px `--rule`                                    | Cards, panels, table containers       |
| L2    | `--bg-raised` + 1px `--rule-strong`                             | Hovered/selected cards, focused panel |
| L3    | `--bg-raised` + 1px `--border-interactive` + `--shadow-overlay` | Dropdowns, popovers, modals, toasts   |

```css
--shadow-overlay: 0 8px 24px -8px rgb(10 23 18 / 0.18);
```

**One shadow token exists in the system and only L3 may use it.** A layer floating over arbitrary content cannot establish separation with a border alone — the content behind it is unknown, so the border may land on a same-value fill. That is a real failure case, not a stylistic preference, so the exception is granted narrowly and nowhere else. If a card wants a shadow, the layout is wrong.

---

## 5. Motion

```css
--dur-fast: 120ms; /* hover, focus, color shifts */
--dur: 180ms; /* standard: expand, reveal, tab change */
--dur-slow: 240ms; /* overlays, drawers */
--ease: cubic-bezier(0.2, 0, 0, 1);
```

Animate `opacity` and `transform` only. No animated `height` on lists, no spring physics, no parallax, no entrance animations on page load.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

Streaming answer text is the one place with continuous motion, and it is text arriving — not an effect. It must not be accompanied by a cursor blink, a shimmer, or a pulse.

---

## 6. Tailwind v4 setup

CSS-first. `app/globals.css`:

```css
@import 'tailwindcss';

@theme {
  --color-green-50: #eef4f0;
  --color-green-100: #d9e7df;
  --color-green-200: #b4cfc0;
  --color-green-300: #87b29c;
  --color-green-400: #5a9077;
  --color-green-500: #3a7059;
  --color-green-600: #2a5a46;
  --color-green-700: #1f4536;
  --color-green-800: #173428;
  --color-green-900: #11261d;
  --color-green-950: #0a1712;

  --color-ochre-200: #f2dfb8;
  --color-ochre-400: #e0a952;
  --color-ochre-500: #c8892c;
  --color-ochre-600: #a66e1f;

  --color-clay-200: #f0d3c9;
  --color-clay-400: #de8465;
  --color-clay-500: #b4482f;
  --color-clay-600: #93361f;

  --color-paper: #f7f4ec;
  --color-paper-raised: #fffdf7;
  --color-ink: #ede8dc;

  --font-display: var(--font-fraunces), Georgia, serif;
  --font-sans: var(--font-inter), system-ui, sans-serif;
  --font-mono: var(--font-plex-mono), ui-monospace, monospace;

  --radius-sm: 3px;

  --ease-brand: cubic-bezier(0.2, 0, 0, 1);
}

/* Semantic layer — components consume these, never the raw scale. */
:root {
  --bg: #f7f4ec;
  --bg-raised: #fffdf7;
  --bg-sunken: #eeeae0;
  --text: #0a1712;
  --text-muted: #6b6455;
  --rule: #e2dcce;
  --rule-strong: #cfc7b4;
  --border-interactive: #8a8674;
  --brand: #173428;
  --brand-hover: #1f4536;
  --brand-subtle: #d9e7df;
  --focus: #2a5a46;
  --attention: #c8892c;
  --attention-subtle: #f2dfb8;
  --attention-text: #a66e1f;
  --danger: #93361f;
  --danger-subtle: #f0d3c9;
  --danger-text: #b4482f;
  --info: #3a525a;
  --highlight: #f2dfb8;
  --shadow-overlay: 0 8px 24px -8px rgb(10 23 18 / 0.18);
}

.dark {
  --bg: #0a1712;
  --bg-raised: #11261d;
  --bg-sunken: #060f0b;
  --text: #ede8dc;
  --text-muted: #8a9a8f;
  --rule: #22402f;
  --rule-strong: #2e5240;
  --border-interactive: #557a64;
  --brand: #b4cfc0;
  --brand-hover: #d9e7df;
  --brand-subtle: #173428;
  --focus: #e0a952;
  --attention: #e0a952;
  --attention-subtle: #4a3a17;
  --attention-text: #e0a952;
  --danger: #b4482f;
  --danger-subtle: #3a1e15;
  --danger-text: #de8465;
  --info: #8fa8b0;
  --highlight: #4a3a17;
  --shadow-overlay: 0 8px 24px -8px rgb(0 0 0 / 0.5);
}

@theme inline {
  --color-bg: var(--bg);
  --color-bg-raised: var(--bg-raised);
  --color-text: var(--text);
  --color-text-muted: var(--text-muted);
  --color-rule: var(--rule);
  --color-brand: var(--brand);
  /* …one entry per semantic token */
}

body {
  background: var(--bg);
  color: var(--text);
  font-feature-settings:
    'cv05' 1,
    'cv11' 1,
    'ss03' 1;
}

.tabular {
  font-variant-numeric: tabular-nums;
}
```

Fonts load through `next/font/google` so there is no external stylesheet request and no layout shift.

**Rule: components reference semantic tokens (`bg-bg-raised`, `text-text-muted`), never the raw scale (`bg-green-800`).** The raw scale exists to define the semantic layer and for illustration fills. This is what makes dark mode a token swap rather than a per-component `dark:` audit.

---

## 7. Components

### Button

| Variant   | Rest                                              | Hover              | Active               | Disabled                   |
| --------- | ------------------------------------------------- | ------------------ | -------------------- | -------------------------- |
| Primary   | `--brand` fill, `--text-inverse`                  | `--brand-hover`    | `--brand-active`     | 40% opacity, `not-allowed` |
| Secondary | transparent, 1px `--border-interactive`, `--text` | `--bg-sunken` fill | `--rule-strong` fill | 40% opacity                |
| Ghost     | transparent, no border                            | `--bg-sunken` fill | `--rule` fill        | 40% opacity                |
| Danger    | `--danger` fill, paper text                       | +8% lightness      | −8% lightness        | 40% opacity                |

Sizes: `sm` 32px / 12px pad, `md` 40px / 16px pad, `lg` 48px / 20px pad. `radius-sm`. Label `body-sm` 500. Icon 16px, 8px gap.

Loading replaces the label with a spinner **at the same width** — buttons must not resize mid-interaction.

### Focus

One rule, globally, no exceptions:

```css
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

Never `outline: none` without a replacement. Focus is visible on every interactive element including custom-styled inputs and cards.

### Input / textarea

40px min height, 1px `--border-interactive`, `--bg-raised` fill, `radius-sm`, 12px horizontal pad, `body-sm`. Placeholder `--text-muted`.

Invalid state: 1px `--danger`, message below in `caption` `--danger-text` with a 14px icon. **Error text is never color-only** — it always carries the icon and the words.

### Label frame — the signature component

The recurring card. 1px `--rule` at L1, `radius-none`, 16px pad, and a catalog number in `mono-label` `--text-muted` at the top-right.

```
┌──────────────────────────────── ┐
│ Client Brief: Bubble Bakery   DOC-0042 │
│ ────────────────────────────────────── │  ← 1px --rule, 12px below title
│ client-briefs/bubble-bakery.md          │  ← mono, --text-muted
│                                         │
│ Genre: match-3. Target networks…        │
└─────────────────────────────────────────┘
```

Wraps source cards, stat tiles, and document rows. Hover promotes to L2. The corner notch (brand motif 2) applies to at most one card per view — the primary one.

---

## 8. Product-specific patterns

These are the components that carry the product's core promise. They matter more than the generic ones.

### Citation chip

Inline in answer prose: `[1]`, `mono-label`, `--attention-subtle` fill, `--text` ink, `radius-sm`, 2px horizontal pad. Hover reveals a popover (L3) with the document title, path, and the cited passage. Click scrolls the corresponding source card into view and promotes it to L2 for 1.2s.

Citations are `<button>` elements, keyboard reachable, labelled `Source 1: {document title}`.

### Source card

Label frame plus:

- Document title (`h4`) and path (`mono`, `--text-muted`)
- Retrieval score as a flat meter — a 3px bar, `--brand` fill on `--bg-sunken` track, no gradient, with the numeric score in `mono-label .tabular` alongside. Showing the number matters; a bare bar is decoration.
- Passage snippet with query terms wrapped in `<mark>` using `--highlight`
- Status badges where relevant

### Status badge

`mono-label`, uppercase, 1px border, `radius-sm`, 2px/6px pad. Subtle fill with dark ink — never a saturated fill with light text at this size.

| State      | Fill                 | Text      |
| ---------- | -------------------- | --------- |
| Indexed    | `--brand-subtle`     | green-900 |
| Pending    | `--attention-subtle` | green-900 |
| Failed     | `--danger-subtle`    | green-900 |
| Deprecated | `--danger-subtle`    | green-900 |

### Deprecated banner

When retrieval surfaces a superseded document (the `sdk-notes-v2` case), the source card gets a full-width strip above the title: `--danger-subtle` fill, 1px `--danger`, 12px pad, `body-sm`.

> **Deprecated.** Superseded by _Lumen SDK v3_. → View current

This is a product-correctness feature wearing a visual token. The retrieval layer flags it; the UI must not bury it.

### Abstain state

The most important state in the application, and it is **not an error**. No clay, no warning icon, no apologetic copy.

Centered in the answer column: a flat vector pressed-leaf specimen at 96px in green-300, then in `h3`:

> No documents cover this.

Then, in `body-sm` `--text-muted`: _Hatko only answers from the indexed corpus. Nothing in the 142 indexed documents addresses this question._ Below that, the closest-scoring chunks under a `Nearest passages` eyebrow, so the user can judge for themselves.

Styling this as a failure would teach users that honesty is malfunction. It gets the same visual weight and care as a successful answer.

### Chat message

User turn: right-aligned, `--bg-sunken` fill, `radius-sm`, max 560px, `body-sm`.
Assistant turn: full column width, no bubble, no fill, `body` at 68ch. The answer is a document, not a chat bubble — that's the show-your-work principle in layout form.

Streaming reveals text token by token with no cursor artifact. Citation chips are inert until the stream completes, then activate.

### Dashboard stat tile

Label frame. `eyebrow` label, then the figure in `h1` Fraunces `.tabular`, then a `caption` delta in `--text-muted`. No sparkline unless the series has ≥7 points — a two-point sparkline is a lie.

### Ingestion run row

`mono-label` run ID, timestamp, duration, counts (`indexed / updated / skipped / failed`), status badge. Failed runs expand to a per-file error list. The count set is deliberate: it's what makes ingestion "observable" as the brief requires.

### Empty, loading, error

**Empty** — flat vector specimen (96px, green-300), `h3` Fraunces statement of fact, `body-sm` next action, one primary button. A different specimen per surface.

**Loading** — skeletons matching the real content's geometry, `--bg-sunken` fill, opacity pulse 1.6s. Never a centered spinner on a full page. Search shows skeleton source cards so the layout doesn't jump.

**Error** — L1 card, 1px `--danger`, 20px icon in `--danger-text`, `h4` plain-language cause, `body-sm` detail, retry button. Technical detail (status code, request ID in `mono`) goes in a collapsed `<details>` — available for a bug report, not shouted at the user.

---

## 9. Responsive

Mobile-first. Breakpoints: `sm 640` · `md 768` · `lg 1024` · `xl 1280`.

| Surface   | Mobile                                                                                                                                                    | Tablet                                                       | Desktop                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Chat      | Single column, 16px gutter. Sources collapse into an expandable "N sources" section below the answer. Composer sticks to the bottom with safe-area inset. | Single column, 24px gutter, sources inline expanded.         | Two columns: answer at 720px, sources in a 360px right rail. |
| Dashboard | Stacked stat tiles 1-up. Document table becomes a card list — one label frame per document.                                                               | Tiles 2-up, table with columns dropped to title/status/date. | Tiles 4-up, full table, filters in a left rail.              |
| Nav       | Bottom bar, 3 items, 56px                                                                                                                                 | Top bar                                                      | Top bar with left rail                                       |

**Tables become cards below `md`.** Horizontally scrolling a data table on a phone is a failure state, not a responsive strategy.

Touch targets: 44×44 minimum below `md`, including citation chips — which means chips get extra vertical padding on touch, not a smaller hit area.

---

## 10. Accessibility

- **Contrast**: verified in §1.4. All text ≥4.5:1, all interactive boundaries ≥3:1, both themes.
- **Focus**: visible on everything, single global rule, never removed.
- **Color is never the only signal.** Status badges carry text. Errors carry icon plus words. Retrieval scores carry the number, not just the bar length.
- **Semantics**: one `<h1>` per page, ordered headings, `<nav>`/`<main>`/`<aside>` landmarks, real `<button>` and `<a>` elements.
- **Live regions**: streaming answers in `aria-live="polite"`; ingestion status changes announced; the abstain state announced as content, not as an alert.
- **Keyboard**: full traversal. `/` focuses search, `Esc` closes overlays and returns focus to the trigger, citation chips are tabbable in reading order.
- **Motion**: `prefers-reduced-motion` honored globally (§5).
- **Zoom**: usable at 200% without horizontal scroll.

---

## 11. Anti-patterns

Reject in review:

- A shadow anywhere outside L3
- Gradients — backgrounds, buttons, text, meters, illustrations
- Glassmorphism, backdrop blur, translucent panels
- Raw scale colors in components (`bg-green-800` instead of `bg-brand`)
- Radii outside `0 / 3px / full`
- Ochre text on paper
- `outline: none` without a replacement
- Emoji in product UI
- Bouncing-dot typing indicators or a chatbot avatar
- Generated prose running wider than 68ch
- Full-page spinners where a skeleton fits
- Horizontally scrolling tables on mobile
- The abstain state styled as an error
- Sparklines on fewer than 7 points
- Exclamation marks in system copy
