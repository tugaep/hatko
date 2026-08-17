/**
 * Chunking.
 *
 * The strategy is: cut on markdown headings, then greedily merge adjacent
 * sections up to a target size, and only hard-split a section that exceeds the
 * ceiling on its own.
 *
 * Why heading-aware rather than a fixed-width sliding window: the documents are
 * already structured, with ~294 level-2 headings across 142 files. A fixed window
 * would slice through the middle of "QA findings and fixes" and hand the answer
 * model half a list. Cutting where the author already cut never splits an idea.
 *
 * Why merge upward afterwards: in this corpus the sections are *small*. The
 * largest document is 1030 bytes and the mean is 800, so a heading-only split
 * would produce many ~250-byte fragments. Fragments retrieve badly — there is not
 * enough text for a meaningful embedding — and they retrieve especially badly
 * here, because the 78 near-identical delivery reports would shatter into
 * hundreds of interchangeable "## Sign-off" pieces that no ranking could tell
 * apart. Merging up to a target keeps a whole small document as one coherent
 * passage while still splitting a genuinely long one on its own headings.
 *
 * Measured on the sample corpus, this produces exactly one chunk per document:
 * 142 documents, 142 chunks, mean 799 characters. Every file is below the target,
 * so nothing splits. That is the correct outcome rather than a degenerate one —
 * sample_questions.md names expected answers as whole documents, so document-sized
 * passages are precisely the retrieval unit being evaluated. The splitting path is
 * what keeps this same code correct against a corpus with longer files.
 */

export interface RawChunk {
  /** The heading this passage sits under; null for content before the first heading. */
  heading: string | null;
  /** Verbatim slice of the source document. */
  content: string;
}

export interface ChunkOptions {
  /** Merge adjacent sections while the result stays under this. */
  targetChars?: number;
  /** A single section longer than this is split internally. */
  maxChars?: number;
}

const DEFAULT_TARGET_CHARS = 1200;
const DEFAULT_MAX_CHARS = 2000;

/** ATX headings only. The corpus uses no setext headings. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * A fenced code block delimiter: three or more backticks or tildes, indented by
 * up to three spaces, per CommonMark.
 *
 * Tracked because `#` starts a comment in most of the languages a runbook embeds,
 * and a line-by-line heading scan cannot tell `# install dependencies` inside a
 * shell block from a document heading. Measured on a runbook with one ```sh
 * block: the fence was cut in half across two chunks, the first left with an
 * unclosed delimiter; the enclosing `## Setup` heading was lost, because the
 * comment registered as level 1 and a group reaching the document top is labelled
 * null; and rejoining the pieces with a blank line turned 150 source bytes into
 * 152, so the chunk stopped being the verbatim slice this module promises. The
 * sample corpus contains no code fences, which is exactly why none of that showed.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Section {
  heading: string | null;
  /** 1-6 for an ATX heading; 0 for content preceding the first heading. */
  level: number;
  content: string;
}

/** Split a document at heading lines. The heading line stays with its section. */
function splitIntoSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let heading: string | null = null;
  let level = 0;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) sections.push({ heading, level, content });
    buffer = [];
  };

  /** The delimiter that opened the current fence, or null outside one. */
  let fence: string | null = null;

  for (const line of lines) {
    const delimiter = FENCE_RE.exec(line)?.[1];
    if (delimiter) {
      // A fence closes only on the same character, at least as long as the one
      // that opened it — so a ```` block may contain a ``` line as content.
      if (fence === null) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
    }

    const match = fence === null ? HEADING_RE.exec(line) : null;
    if (match) {
      flush();
      // The level-1 heading is normally the document title. It is kept in the
      // content anyway: it carries the distinguishing words — client, game, date —
      // that separate one delivery report from the other 77 in keyword search.
      heading = match[2]?.trim() || null;
      level = match[1]?.length ?? 0;
    }
    buffer.push(line);
  }
  flush();

  return sections;
}

/**
 * A chunk's heading answers "which section of the document is this", so it is
 * null whenever the chunk reaches back to the document's own top — a whole-document
 * chunk is not "in" a section, and labelling it with the level-1 heading would
 * merely repeat the document title that is already displayed beside it.
 */
function headingForGroup(group: Section[]): string | null {
  if (group.some((section) => section.level <= 1)) return null;
  return group.find((section) => section.heading)?.heading ?? null;
}

/**
 * Cut text on whitespace so nothing can exceed the ceiling.
 *
 * The last resort, below paragraphs and sentences. Preferring not to split
 * mid-sentence is a quality choice; never splitting at all is a correctness problem,
 * because a chunk has to fit the embedding model's context — text-embedding-3-small
 * takes 8192 tokens, so an unbounded chunk is a request that fails outright and a
 * document that never gets indexed. A cut on a word boundary beats that.
 *
 * Whitespace runs are preserved as their own tokens, so the text stays verbatim
 * rather than being reflowed.
 */
function splitOnWords(text: string, maxChars: number): string[] {
  // Packs greedily to the ceiling. Aiming for equal-sized pieces instead was tried,
  // to avoid leaving the remainder in a short trailing chunk, and measured worse: it
  // produced more chunks and *introduced* a runt in the case that previously had
  // none. A short trailing fragment survives here on pathological input; see the
  // note on splitOversized.
  const parts: string[] = [];
  let current = '';

  for (const token of text.split(/(\s+)/)) {
    if (!current || current.length + token.length <= maxChars) current += token;
    else {
      parts.push(current);
      current = token;
    }
  }
  if (current) parts.push(current);

  // A single unbroken token longer than the ceiling — a URL, a base64 blob, a
  // minified line. There is no boundary left to respect, so cut it.
  return parts
    .flatMap((part) =>
      part.length <= maxChars
        ? [part]
        : Array.from({ length: Math.ceil(part.length / maxChars) }, (_, i) =>
            part.slice(i * maxChars, (i + 1) * maxChars),
          ),
    )
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Split an oversized section: paragraphs first, then sentences, then words.
 *
 * Preference order is about retrieval quality — a fragment ending halfway through a
 * clause embeds poorly and reads worse as a citation — but the ceiling is honoured
 * at the end regardless, because an oversized chunk is not indexable at all.
 *
 * Known residual, stated rather than hidden: greedy packing can leave the remainder
 * of a very long paragraph in a short trailing chunk, and a document consisting of a
 * heading followed by one unbroken multi-kilobyte token still orphans the heading,
 * because there is no boundary at which anything could be packed with it. Both are
 * low-value passages rather than incorrect ones, and neither arises in a corpus of
 * prose — nothing in this one is oversized at all.
 */
function splitOversized(section: Section, maxChars: number): RawChunk[] {
  const units = section.content.split(/\n{2,}/).filter((p) => p.trim());
  const parts: string[] = [];
  let current = '';

  const push = (unit: string) => {
    if (!current) {
      current = unit;
    } else if (current.length + unit.length + 2 <= maxChars) {
      current = `${current}\n\n${unit}`;
    } else {
      parts.push(current);
      current = unit;
    }
  };

  // A heading line is its own paragraph, so on its own it would be flushed as a
  // standalone chunk — measured, a 3-character passage reading `# T`, embedded and
  // indexed as though it were prose. A heading labels what follows it, so it is
  // glued to the next unit before packing rather than being allowed to stand alone.
  const merged: string[] = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    if (previous !== undefined && HEADING_RE.test(previous) && !previous.includes('\n')) {
      merged[merged.length - 1] = `${previous}\n\n${unit}`;
    } else {
      merged.push(unit);
    }
  }

  for (const unit of merged) {
    if (unit.length <= maxChars) {
      push(unit);
      continue;
    }
    // One paragraph over the ceiling: fall back to sentence boundaries, and to word
    // boundaries for a sentence that is itself too long.
    let sentence = '';
    for (const piece of unit.split(/(?<=[.!?])\s+/)) {
      if (sentence && sentence.length + piece.length + 1 > maxChars) {
        push(sentence);
        sentence = piece;
      } else {
        sentence = sentence ? `${sentence} ${piece}` : piece;
      }
    }
    if (sentence) push(sentence);
  }
  if (current) parts.push(current);

  // Resolved the same way as a merged group, so an oversized level-1 section is
  // labelled null rather than repeating the document title.
  const heading = headingForGroup([section]);
  return parts
    .flatMap((content) =>
      content.length <= maxChars ? [content] : splitOnWords(content, maxChars),
    )
    .map((content) => ({ heading, content }));
}

export function chunkMarkdown(body: string, options: ChunkOptions = {}): RawChunk[] {
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const sections = splitIntoSections(body);
  if (sections.length === 0) return [];

  const chunks: RawChunk[] = [];
  let group: Section[] = [];
  let groupLength = 0;

  const flushGroup = () => {
    if (group.length === 0) return;
    chunks.push({
      heading: headingForGroup(group),
      content: group.map((section) => section.content).join('\n\n'),
    });
    group = [];
    groupLength = 0;
  };

  for (const section of sections) {
    if (section.content.length > maxChars) {
      flushGroup();
      chunks.push(...splitOversized(section, maxChars));
      continue;
    }

    const merged =
      groupLength === 0 ? section.content.length : groupLength + 2 + section.content.length;
    if (group.length > 0 && merged > targetChars) flushGroup();

    group.push(section);
    groupLength = groupLength === 0 ? section.content.length : merged;
  }
  flushGroup();

  return chunks;
}

/**
 * The text that actually gets embedded.
 *
 * A passage lifted out of its document loses the context that makes it
 * interpretable — "Maximum file size: 5 MB" means nothing without knowing it is
 * an AppLovin spec. Prefixing the document title and heading restores that, and
 * measurably helps when many documents share phrasing, which is exactly this
 * corpus. The prefix is derived here rather than stored, so what is displayed to
 * the user stays verbatim.
 */
export function buildEmbeddingText(title: string, heading: string | null, content: string): string {
  const firstLine = content.slice(0, content.indexOf('\n') + 1 || content.length);
  // Skip the title when the passage already opens with it, which is the common
  // case for a whole-document chunk starting at its level-1 heading.
  const needsTitle = !firstLine.includes(title);

  const label = [needsTitle ? title : null, heading && heading !== title ? heading : null]
    .filter(Boolean)
    .join(' › ');

  return label ? `${label}\n\n${content}` : content;
}

/**
 * Approximate token count, used for display and index statistics only.
 *
 * Roughly four characters per token holds for English prose. A real tokeniser
 * would mean a dependency and a native build for a number that never affects
 * retrieval or truncation here; if either ever depends on it, replace this.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
