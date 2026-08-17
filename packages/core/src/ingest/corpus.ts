import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CATEGORY_UNCATEGORISED } from '@sorrel/shared';

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

  const all = fs
    .readdirSync(corpusRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.relative(corpusRoot, path.join(entry.parentPath, entry.name)))
    .map((rel) => rel.split(path.sep).join('/'))
    .sort();

  return {
    files: all.filter((rel) => !isIgnored(rel, ignore)),
    ignored: all.filter((rel) => isIgnored(rel, ignore)),
  };
}

/**
 * A document's category is its top-level directory. Files sitting at the corpus
 * root have no directory to take a category from and fall back to a constant.
 *
 * Derived rather than enumerated so that a corpus organised differently from the
 * sample still ingests.
 */
export function categoryOf(sourcePath: string): string {
  const [first, ...rest] = sourcePath.split('/');
  return rest.length > 0 && first ? first : CATEGORY_UNCATEGORISED;
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
  const body = raw.toString('utf8');
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
