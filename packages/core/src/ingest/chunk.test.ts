import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbeddingText, chunkMarkdown, estimateTokens } from './chunk.ts';

/** Verbatim shape of a delivery report — the corpus's most common document. */
const DELIVERY_REPORT = `# Delivery Report: Bubble Bakery, 2025-05

Client: SweetPixel Games. Target network this cycle: Unity. Developers: Viktor, Tomas.

## QA findings and fixes
- Haptics fired on every match on ios which the client found excessive; reduced to combos.
- Memory grew slightly after repeated loops due to retained particle pools; pools now recycled.

## Observations
- Size headroom on the applovin export is under 300 kb; audio changes need platform review.
- Fail-to-retry conversion held above 80 percent across all tested devices.

## Sign-off
Checklist attached to the delivery ticket by Viktor.`;

test('a small document stays a single chunk', () => {
  const chunks = chunkMarkdown(DELIVERY_REPORT);

  assert.equal(chunks.length, 1, 'documents under the target are not fragmented');
  assert.equal(chunks[0]!.content, DELIVERY_REPORT.trim());
});

test('a single chunk keeps the distinguishing title text', () => {
  const [chunk] = chunkMarkdown(DELIVERY_REPORT);

  // "Bubble Bakery" and the date are what separate this from the other 77
  // delivery reports in keyword search. Stripping the H1 would move those words
  // out of the FTS index and make the reports genuinely interchangeable.
  assert.match(chunk!.content, /Bubble Bakery/);
  assert.match(chunk!.content, /2025-05/);
});

test('a long document splits on its own headings, never mid-section', () => {
  const long = `# Handbook

Intro paragraph.

## Alpha
${'Alpha body sentence. '.repeat(40)}

## Beta
${'Beta body sentence. '.repeat(40)}

## Gamma
${'Gamma body sentence. '.repeat(40)}`;

  const chunks = chunkMarkdown(long);

  assert.ok(chunks.length > 1, 'a document over the target is split');
  // No chunk may contain text from two different sections that were split apart.
  for (const chunk of chunks) {
    const sections = ['Alpha body', 'Beta body', 'Gamma body'].filter((s) =>
      chunk.content.includes(s),
    );
    assert.ok(sections.length <= 1, `chunk mixes sections: ${sections.join(', ')}`);
  }
});

test('a section chunk is labelled with its own heading', () => {
  const long = `# Handbook

## Alpha
${'Alpha body. '.repeat(60)}

## Beta
${'Beta body. '.repeat(60)}

## Gamma
${'Gamma body. '.repeat(60)}`;

  const chunks = chunkMarkdown(long);
  const beta = chunks.find((c) => c.content.includes('Beta body'));
  const gamma = chunks.find((c) => c.content.includes('Gamma body'));

  assert.equal(beta?.heading, 'Beta');
  assert.equal(gamma?.heading, 'Gamma');
});

test('a chunk reaching the top of the document has no section heading', () => {
  // heading answers "which section is this"; a whole-document chunk is not in a
  // section, and echoing the level-1 heading would just repeat the title already
  // shown next to it. On this corpus every document is one chunk, so labelling
  // them by their H1 would make the field pure noise.
  const [whole] = chunkMarkdown(DELIVERY_REPORT);
  assert.equal(whole!.heading, null);

  const long = `# Handbook

## Alpha
${'Alpha body. '.repeat(60)}

## Beta
${'Beta body. '.repeat(60)}`;
  const opening = chunkMarkdown(long).find((c) => c.content.includes('# Handbook'));
  assert.equal(opening?.heading, null, 'the opening chunk reaches the document top');
});

test('an oversized single section is split without cutting a sentence', () => {
  const body = `## Enormous\n${'This is one complete sentence. '.repeat(200)}`;

  const chunks = chunkMarkdown(body, { targetChars: 400, maxChars: 600 });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 600, `chunk of ${chunk.content.length} exceeds the ceiling`);
    assert.match(chunk.content.trim(), /[.!?]$/, 'chunks end on a sentence boundary');
  }
});

/**
 * `maxChars` has to be a real ceiling, not a preference.
 *
 * Preferring paragraph and sentence boundaries is a quality choice, but when there is
 * no such boundary the old code simply gave up and emitted the whole thing: a single
 * 10,000-character sentence became one 10,000-character chunk. That is not a rounding
 * problem — text-embedding-3-small accepts 8192 tokens, so an oversized chunk is a
 * request that fails and a document that never gets indexed at all.
 */
test('a chunk never exceeds the ceiling, whatever the text refuses to split on', () => {
  const ceiling = 600;
  const cases: Array<[string, string]> = [
    ['one enormous sentence', `# T\n\n${'word '.repeat(2000).trim()}.`],
    ['one unbroken token', `# T\n\n${'x'.repeat(4000)}`],
    ['no whitespace at all', `# T\n\n${'abc'.repeat(1000)}`],
    ['sentence then giant token', `# T\n\nShort sentence. ${'y'.repeat(3000)}`],
  ];

  for (const [name, body] of cases) {
    const chunks = chunkMarkdown(body, { targetChars: 400, maxChars: ceiling });

    assert.ok(chunks.length > 0, `${name} produced nothing`);
    for (const chunk of chunks) {
      assert.ok(
        chunk.content.length <= ceiling,
        `${name}: chunk of ${chunk.content.length} exceeds the ${ceiling} ceiling`,
      );
    }
    // Splitting must not lose text. Whitespace at the cut points is normalised away,
    // so compare with whitespace stripped.
    const strip = (s: string) => s.replace(/\s+/g, '');
    assert.equal(
      strip(chunks.map((c) => c.content).join('')),
      strip(body),
      `${name}: content was lost or duplicated`,
    );
  }
});

/**
 * A heading line is its own paragraph, so an oversized section used to flush it as a
 * standalone chunk — measured, a 3-character passage reading `# T`, embedded and
 * indexed as though it were prose. A heading labels what follows; it is not a passage.
 */
test('an oversized section does not emit its heading as a chunk of its own', () => {
  const body = `## Section\n\n${'alpha '.repeat(900).trim()}.`;

  const chunks = chunkMarkdown(body, { targetChars: 400, maxChars: 600 });

  assert.ok(chunks.length > 1, 'the section is oversized and must split');
  assert.match(chunks[0]!.content, /^## Section/, 'the heading stays attached to its text');
  assert.ok(
    chunks[0]!.content.includes('alpha'),
    `the first chunk is ${JSON.stringify(chunks[0]!.content)} — the heading with no text`,
  );
});

test('a document with no headings still produces a chunk', () => {
  // 34 of the 142 corpus documents have no level-2 heading at all.
  const chunks = chunkMarkdown('Just a paragraph of prose with no heading whatsoever.');

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.heading, null);
});

test('empty input produces no chunks rather than one empty chunk', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('   \n\n  \n'), []);
});

test('embedding text prefixes context a passage would otherwise lose', () => {
  const text = buildEmbeddingText(
    'Network Specs: AppLovin',
    'Hard limits',
    '- Maximum file size: 5 MB for the final single HTML file.',
  );

  // "Maximum file size: 5 MB" is uninterpretable alone; the prefix is what ties
  // it to AppLovin so the passage can be retrieved by a query naming the network.
  assert.match(text, /^Network Specs: AppLovin › Hard limits\n\n/);
  assert.match(text, /5 MB/);
});

test('embedding text does not repeat a title the passage already opens with', () => {
  const content = '# Build Pipeline\n\nThe pipeline has four stages.';
  const text = buildEmbeddingText('Build Pipeline', null, content);

  assert.equal(text, content, 'no redundant prefix for a whole-document chunk');
});

test('token estimate is proportional and never zero for non-empty text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a') >= 1);
  assert.ok(estimateTokens('x'.repeat(400)) === 100);
});
