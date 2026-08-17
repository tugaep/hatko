import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CATEGORY_MAX_CHARS, CATEGORY_UNCATEGORISED } from '@sorrel/shared';

/** A source file read from disk, before chunking or embedding. */
export interface SourceDocument {
  /** Path relative to the corpus root, always POSIX-separated. The document's identity. */
  sourcePath: string;
  title: string;
  category: string;
  contentHash: string;
  byteSize: number;
  isDeprecated: boolean;
  supersededBy: string | null;
  /** File contents, verbatim. */
  body: string;
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * Path segments that are never corpus content.
 *
 * Having no exclusions at all was a real defect, not a theoretical one: an agent
 * plugin wrote a `CLAUDE.md` stub into the sample corpus and ingestion indexed it
 * as a 43-byte document, taking the count to 143. Gitignoring the file was the
 * wrong layer — it stopped the file being committed and did nothing to stop it
 * being indexed.
 *
 * `node_modules` is the one that would hurt most. "Point CORPUS_PATH at the real
 * corpus" is a stated requirement, and a documentation tree that lives inside a
 * repository has thousands of `README.md` files under there.
 *
 * Deliberately short, and deliberately not including `README.md`: in a real
 * documentation tree a README is often genuine content, and a default that
 * silently drops it would be a worse bug than the one this fixes. Everything here
 * is unambiguously tooling. If a corpus ever needs its own exclusions, this is the
 * seam to lift into configuration — until one does, a setting for it is a guess.
 */
export const IGNORED_SEGMENTS = ['node_modules', 'CLAUDE.md'];

/**
 * Hidden files and directories are tooling by convention — `.git`, `.obsidian`,
 * `.github/PULL_REQUEST_TEMPLATE.md`, `.DS_Store`. No corpus addresses a document
 * by a dot-prefixed path.
 */
const isHidden = (segment: string) => segment.startsWith('.');

function isIgnored(relativePath: string, ignore: readonly string[]): boolean {
  return relativePath
    .split('/')
    .some(
      (segment) =>
        isHidden(segment) || ignore.some((entry) => entry.toLowerCase() === segment.toLowerCase()),
    );
}

/**
 * Walk the corpus directory and return every markdown file, sorted by path.
 *
 * Sorted so that ingestion order — and therefore document ids — are stable
 * between runs on the same corpus, which makes ingest output diffable.
 *
 * Returns the excluded paths alongside the kept ones so the pipeline can report
 * what it skipped. Silence is what made the `CLAUDE.md` case a defect: an
 * exclusion nobody can see is indistinguishable from a document that failed to
 * index.
 *
 * Symlinks are not followed, and this is the reason the walk is written out
 * rather than left to `readdirSync({ recursive: true })`, which follows them with
 * no way to opt out. Two measured consequences of following them: a directory
 * symlink pointing outside the corpus pulled the files behind it into the index —
 * the same "foreign file in the corpus" defect the exclusion list above exists to
 * prevent, reached by a route the exclusion list cannot see — and a
 * self-referential symlink yielded the same document sixteen times under sixteen
 * paths, which is sixteen embeddings bought and sixteen interchangeable results
 * returned. A symlink inside a documentation tree is aliasing or tooling; the
 * document it points at is either already in the corpus or deliberately outside it.
 *
 * An excluded directory is reported once, by name, rather than descended into to
 * enumerate what it holds. That keeps the exclusion visible — the whole point of
 * returning this list — without `node_modules` producing thousands of lines of it.
 */
export function scanCorpus(
  corpusRoot: string,
  ignore: readonly string[] = IGNORED_SEGMENTS,
): { files: string[]; ignored: string[] } {
  if (!fs.existsSync(corpusRoot)) {
    throw new Error(
      `Corpus directory not found: ${corpusRoot}\n` +
        `Set CORPUS_PATH in .env to the directory holding the documents.`,
    );
  }

  const found: string[] = [];
  const skipped: string[] = [];

  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const rel = path.relative(corpusRoot, absolute).split(path.sep).join('/');

      const extension = path.extname(entry.name);
      const couldBeContent = MARKDOWN_EXTENSIONS.has(extension) || extension === '';

      // Reported rather than dropped quietly, for the same reason the ignore list
      // is reported: a path that exists on disk and not in the index has to be
      // explainable without reading this function. Only when it could have been
      // content, though — a link with a non-markdown extension is skipped as
      // silently as the ordinary file of that kind beside it. An extensionless
      // name is assumed to be a directory link, since following it is exactly the
      // case worth announcing.
      if (entry.isSymbolicLink()) {
        if (couldBeContent) skipped.push(`${rel} (symlink)`);
        continue;
      }
      if (entry.isDirectory()) {
        // Named once rather than descended into. Listing every markdown file under
        // an excluded tree is how `node_modules` turns this list into thousands of
        // lines; saying nothing is how the exclusion becomes indistinguishable from
        // a document that failed to index. The directory itself is the useful unit.
        if (isIgnored(rel, ignore)) skipped.push(`${rel}/`);
        else walk(absolute);
        continue;
      }
      if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(extension)) continue;

      (isIgnored(rel, ignore) ? skipped : found).push(rel);
    }
  };

  walk(corpusRoot);

  return { files: found.sort(), ignored: skipped.sort() };
}

/**
 * A document's category is its top-level directory. Files sitting at the corpus
 * root have no directory to take a category from and fall back to a constant.
 *
 * Derived rather than enumerated so that a corpus organised differently from the
 * sample still ingests.
 *
 * Truncated to the width `documentCategorySchema` accepts, because this is the
 * only place a category is produced and the write path is raw SQL that does not
 * apply the schema. Without the clamp a directory name of 65 characters ingested
 * "successfully" and then made the row unreadable: every path that parses a
 * document — the admin list, the dashboard, the next ingest's diff, and
 * `hybridSearch`, which parses through `searchResultSchema` — threw a ZodError
 * from then on, with no way back short of editing the database by hand. A
 * category is a facet label, not an identity, so trimming a pathological one is
 * a fair trade for a row that can always be read back.
 */
export function categoryOf(sourcePath: string): string {
  const [first, ...rest] = sourcePath.split('/');
  const category = rest.length > 0 && first ? first : CATEGORY_UNCATEGORISED;
  return category.slice(0, CATEGORY_MAX_CHARS);
}

/** First level-1 heading, falling back to a title derived from the filename. */
export function titleOf(sourcePath: string, body: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(body);
  if (heading?.[1]) return heading[1];

  const base = path.basename(sourcePath, path.extname(sourcePath));
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Detect a document that declares *itself* obsolete.
 *
 * Direction is the whole difficulty here. `sdk-notes-v2.md` opens with
 * "# Lumen SDK v2 (DEPRECATED)" and "Status: deprecated since January 2026",
 * while `sdk-notes-v3.md` — the current document — says "It supersedes v2".
 * A regex looking for "supersede" anywhere would flag the current document and
 * invert the exact distinction this is meant to capture, so only the passive
 * direction counts, and only near the top of the file where a status header lives.
 *
 * Deprecated documents stay retrievable: suppressing them would hide legitimately
 * relevant history, and a question about v2 should still find v2. The flag travels
 * with the result so the answer can say the document is superseded.
 */
export function detectDeprecation(
  title: string,
  body: string,
): { isDeprecated: boolean; supersededBy: string | null } {
  // Status declarations live in the opening lines; a passing mention further down
  // is discussion, not a status.
  const head = body.slice(0, 400);

  const isDeprecated =
    /\bdeprecated\b/i.test(title) ||
    /^\s*status:\s*deprecated/im.test(head) ||
    /\b(?:is|are|was|were)\s+deprecated\b/i.test(head) ||
    /\bdeprecated\s+(?:since|as of|in)\b/i.test(head);

  if (!isDeprecated) return { isDeprecated: false, supersededBy: null };

  // Passive direction only — "superseded by X", never "supersedes X".
  const patterns = [
    /superseded\s+by\s+["“']?([^"”'.\n]+)/i,
    /replaced\s+by\s+["“']?([^"”'.\n]+)/i,
    // The sdk-notes-v2 phrasing: `See "Lumen SDK v3" for current guidance.`
    /\bsee\s+["“]([^"”]+)["”]/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(head);
    if (match?.[1]) return { isDeprecated: true, supersededBy: match[1].trim() };
  }

  return { isDeprecated: true, supersededBy: null };
}

/** Read and parse one corpus file. Throws if the file cannot be read. */
export function readDocument(corpusRoot: string, sourcePath: string): SourceDocument {
  const absolute = path.join(corpusRoot, sourcePath);
  const raw = fs.readFileSync(absolute);
  // A byte-order mark sits before the first `#`, so `/^#\s+/m` does not match it
  // and the document loses both its title — falling back to a humanised filename —
  // and its level-1 heading, which then also costs the chunker its section
  // labelling. It is what Windows tooling and Confluence exports emit. Stripped
  // from the text only: the content hash is taken over the raw bytes below, so
  // adding or removing a BOM still counts as a change to the file.
  const body = raw.toString('utf8').replace(/^﻿/, '');
  const title = titleOf(sourcePath, body);
  const { isDeprecated, supersededBy } = detectDeprecation(title, body);

  return {
    sourcePath,
    title,
    category: categoryOf(sourcePath),
    // Hash the bytes, not the decoded string, so any change at all is detected.
    contentHash: createHash('sha256').update(raw).digest('hex'),
    byteSize: raw.byteLength,
    isDeprecated,
    supersededBy,
    body,
  };
}
