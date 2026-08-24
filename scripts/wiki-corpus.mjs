/**
 * Build a markdown corpus from a Wikipedia category tree.
 *
 *   node scripts/wiki-corpus.mjs <out-dir> <max-files> <Category_A,Category_B,...>
 *
 * One directory per category, because `categoryOf` takes the first path segment
 * as the document's category facet.
 *
 * Articles are fetched as plain-text extracts rather than wikitext: wikitext would
 * need template expansion to be readable, and the extract already carries
 * `== Section ==` headings, which is the one thing the heading-based chunker needs.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';

const [out, max = '142', seeds = ''] = process.argv.slice(2);
if (!out || !seeds) {
  console.error('usage: wiki-corpus.mjs <out-dir> <max-files> <Category_A,Category_B,...>');
  process.exit(1);
}

/**
 * Which subcategories are worth descending into.
 *
 * Wikipedia's category graph is not a tree and has no natural bottom — two levels
 * below "Circassians" is the whole Caucasus, and three is the Ottoman Empire. The
 * corpus is supposed to be one dense topic, so descent is bounded by the subject
 * rather than by depth: follow a subcategory only if its name still names the
 * subject. Widening the corpus to another topic means widening this pattern.
 */
const ON_TOPIC = /circass|adyghe|kabard|ubykh|abaza|abkhaz|shapsug|nart|cherkess|adygea/i;

/** Editor and maintenance categories are not corpus material at all. */
const META = /wikipedi|sockpuppet|stubs?$|templates?$|redirects/i;

/**
 * Tracking categories — "Articles containing Adyghe-language text" and the like.
 *
 * Their members are real articles worth having, so they are walked, but last:
 * an article takes the name of the category it is first found in, and being
 * filed under a maintenance category tells a reader nothing. Deferring these
 * until the topical categories are exhausted means only the articles reachable
 * by no other route are still holding one, and those are filed under `general`
 * — which is the honest label, since what they have in common is belonging to
 * no topical category rather than sharing a subject.
 */
const TRACKING =
  /^articles (containing|with|needing|lacking|using)|^pages (containing|using)|^cs1|^webarchive/i;

const API = 'https://en.wikipedia.org/w/api.php';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wikipedia throttles a client that asks too fast, and full-text extracts cannot
 * be batched — one article is one request — so a corpus of a thousand articles
 * will be throttled partway through. A 429 is a "wait", not a failure: honour
 * `Retry-After` when it is sent and back off geometrically when it is not.
 */
const query = async (params, attempt = 0) => {
  const url = `${API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params })}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'hatko-corpus/1 (https://hatko.tugrap.dev)' },
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
    console.log(`  ${res.status} from Wikipedia, waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    return query(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}: ${url}`);

  const body = await res.json();
  if (body.error) throw new Error(`Wikipedia API: ${body.error.info}`);
  return body;
};

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

/** The directory an article is filed under, and so the category facet it gets. */
const folderFor = (category) => (TRACKING.test(category) ? 'general' : slug(category));

/** `== X ==` is the only markup an extract carries; everything else is plain prose. */
const toMarkdown = (title, extract) =>
  `# ${title}\n\n${extract
    .replace(/^====\s*(.+?)\s*====$/gm, '#### $1')
    .replace(/^===\s*(.+?)\s*===$/gm, '### $1')
    .replace(/^==\s*(.+?)\s*==$/gm, '## $1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;

/** Every member of one category, split into articles and on-topic subcategories. */
async function members(category) {
  const pages = [];
  const subcategories = [];
  let cont = {};
  do {
    const res = await query({
      list: 'categorymembers',
      cmtitle: `Category:${category}`,
      cmtype: 'page|subcat',
      cmlimit: '500',
      ...cont,
    });
    for (const m of res.query?.categorymembers ?? []) {
      if (m.ns === 0) pages.push(m.title);
      else {
        const name = m.title.replace(/^Category:/, '');
        if (ON_TOPIC.test(name) && !META.test(name)) subcategories.push(name);
      }
    }
    cont = res.continue ?? {};
  } while (cont.cmcontinue);
  return { pages, subcategories };
}

/**
 * Full-text extracts come back one page per request however high `exlimit` is set,
 * so this pages with `excontinue` until the batch of 20 titles is exhausted.
 */
async function* extracts(titles) {
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    let cont = {};
    do {
      const res = await query({
        titles: batch.join('|'),
        prop: 'extracts',
        explaintext: '1',
        exlimit: '20',
        ...cont,
      });
      for (const page of res.query?.pages ?? []) {
        if (page.extract?.trim()) yield page;
      }
      cont = res.continue ?? {};
    } while (Object.keys(cont).length > 0);
  }
}

// --- walk the tree, breadth-first, recording where each article was first seen ---
const limit = Number(max);
const origin = new Map(); // article title -> category it was first found in
const visited = new Set();
const queue = seeds
  .split(',')
  .map((c) => c.trim().replace(/^Category:/, ''))
  .filter(Boolean);
const deferred = [];

while ((queue.length > 0 || deferred.length > 0) && origin.size < limit) {
  const category = queue.shift() ?? deferred.shift();
  if (visited.has(category)) continue;
  visited.add(category);

  const { pages, subcategories } = await members(category);
  for (const title of pages) {
    if (origin.size >= limit) break;
    if (!origin.has(title)) origin.set(title, category);
  }
  for (const sub of subcategories) {
    if (visited.has(sub)) continue;
    (TRACKING.test(sub) ? deferred : queue).push(sub);
  }
  console.log(
    `  ${category}: ${pages.length} articles, ${subcategories.length} subcategories -> ${origin.size} collected`,
  );
}

console.log(`\n${visited.size} categories walked, ${origin.size} articles to fetch\n`);

// --- fetch and write ----------------------------------------------------------
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );

// Resumable: a run interrupted by throttling or a dropped connection should not
// re-fetch what it already has. One request per article is the expensive part.
const pending = [];
for (const [title, category] of origin) {
  if (!(await exists(`${out}/${folderFor(category)}/${slug(title)}.md`))) pending.push(title);
}
const already = origin.size - pending.length;
if (already > 0) console.log(`${already} already on disk, ${pending.length} to fetch\n`);

let written = 0;
for await (const page of extracts(pending)) {
  const dir = `${out}/${folderFor(origin.get(page.title))}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${slug(page.title)}.md`, toMarkdown(page.title, page.extract));
  written++;
  if (written % 100 === 0) console.log(`  ${written}/${pending.length} written`);
}

console.log(`\n${written} written, ${already + written} files in ${out}`);
