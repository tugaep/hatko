/**
 * The evaluation set.
 *
 * The first five are verbatim from sample_dataset/sample_questions.md, with the
 * expected documents exactly as that file states them. The brief says the private
 * evaluation uses "these plus a private set in the same style", so those five are
 * treated as a specification rather than as examples, and the rest are written to
 * cover the same shapes without overfitting to the five: a question answered by
 * one of the 78 near-identical delivery reports, one whose answer is spread
 * across documents, and several the corpus genuinely cannot answer.
 *
 * `expected` lists documents that count as correct. `alsoRelevant` documents are
 * not required for a hit but are useful context and are reported separately, so
 * a change that starts surfacing them is visible rather than invisible.
 */

export interface EvalQuestion {
  id: string;
  question: string;
  /** Source paths, any of which counts as a correct retrieval. Empty = unanswerable. */
  expected: string[];
  alsoRelevant?: string[];
  /**
   * Substrings the generated answer must contain, matched case-insensitively.
   *
   * Retrieval rank is not the whole requirement. Sample question 2 was retrieved
   * perfectly — the current SDK document at rank 1 — while the answer omitted
   * that the previous version is deprecated, which sample_questions.md names as
   * part of a good answer. The eval reported success and the requirement failed,
   * so answer content is now asserted too.
   */
  mustMention?: string[];
  /** Why this question is in the set — what it is meant to catch. */
  probes: string;
}

export const EVAL_QUESTIONS: EvalQuestion[] = [
  // --- verbatim from sample_questions.md ------------------------------------
  {
    id: 'sample-1',
    question: 'What is the maximum file size for an AppLovin playable, and how does it ship?',
    expected: ['network-specs-applovin.md'],
    mustMention: ['5 MB'],
    probes: 'A specific numeric fact stated in exactly one document.',
  },
  {
    id: 'sample-2',
    question: 'How do I initialize the current Lumen SDK, and what happened to lumen.track?',
    expected: ['sdk-notes-v3.md'],
    alsoRelevant: ['sdk-notes-v2.md'],
    mustMention: ['deprecat'],
    probes:
      'The deprecation trap. v2 is semantically near-identical to v3 and mentions lumen.track ' +
      'more prominently, so it can out-rank the current document. Retrieving v3 first is the ' +
      'test; the answer must also say v2 is deprecated.',
  },
  {
    id: 'sample-3',
    question: 'Why are sound assets built in a separate pass?',
    expected: ['build-pipeline.md'],
    alsoRelevant: ['incident-postmortem-2026-03.md'],
    probes:
      'The delivery-report crowding. 78 near-identical reports discuss builds and audio in ' +
      'similar language, so pure vector similarity buries the one document that answers this. ' +
      'The lexical arm is what rescues it.',
  },
  {
    id: 'sample-4',
    question: 'What caused the March 2026 AppLovin rejections and what was fixed?',
    expected: ['incident-postmortem-2026-03.md'],
    alsoRelevant: ['changelogs/lumen-build-4.2.md', 'build-pipeline.md'],
    probes: 'An answer that spans documents; the postmortem is the anchor.',
  },
  {
    id: 'sample-5',
    question: 'Which languages must every playable ship with, and what is the fallback?',
    expected: ['localization-guide.md'],
    mustMention: ['English'],
    probes: 'A list plus a rule, both in one document.',
  },

  // --- same style, written to cover the same failure shapes ------------------
  {
    id: 'extra-orientation',
    question: 'Do playables need to support both portrait and landscape?',
    expected: ['network-specs-applovin.md', 'network-specs-unity-meta.md'],
    probes: "Phrased with none of the document's own wording, so it leans on the vector arm.",
  },
  {
    id: 'extra-analytics-applovin',
    question: 'Are analytics beacons allowed in AppLovin builds?',
    expected: ['network-specs-applovin.md'],
    alsoRelevant: ['analytics-events.md'],
    probes: 'Two documents share vocabulary; only one states the rule.',
  },
  {
    id: 'extra-review-process',
    question: 'Who is allowed to run the delivery review for a pod?',
    expected: ['guides/review-process.md'],
    probes:
      'The phrase appears in all 78 delivery reports as boilerplate, so the guide that actually ' +
      'defines the rule has to beat a wall of documents that merely mention it.',
  },
  {
    id: 'extra-hardcoded-strings',
    question: 'Is hard-coding UI copy in a component a QA blocker?',
    expected: ['localization-guide.md'],
    alsoRelevant: ['qa-checklist.md'],
    probes: 'A yes/no policy question whose answer is one clause inside a longer document.',
  },

  // --- unanswerable, on purpose ---------------------------------------------
  {
    id: 'unanswerable-salary',
    question: 'What is the starting salary for a junior developer at Lumen?',
    expected: [],
    probes:
      'The corpus has no HR content. The correct behaviour is an honest refusal with no ' +
      'invented citation. Named directly in sample_questions.md.',
  },
  {
    id: 'unanswerable-vacation',
    question: 'How many vacation days do employees get per year?',
    expected: [],
    probes: 'As above. Also named in sample_questions.md.',
  },
  {
    id: 'unanswerable-plausible',
    question: 'What is the maximum file size for a TikTok playable?',
    expected: [],
    probes:
      'The hard case for abstention: TikTok is a network the corpus never covers, but the ' +
      'question is lexically near-identical to sample-1, so retrieval will confidently return ' +
      'the AppLovin spec. Abstaining here requires judging relevance, not just similarity.',
  },
];

export const ANSWERABLE = EVAL_QUESTIONS.filter((q) => q.expected.length > 0);
export const UNANSWERABLE = EVAL_QUESTIONS.filter((q) => q.expected.length === 0);
