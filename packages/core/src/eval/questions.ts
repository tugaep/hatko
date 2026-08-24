/**
 * The evaluation set.
 *
 * Written against the Circassian corpus that replaced the original sample
 * documents. The shapes are carried over deliberately, because they are what the
 * retriever was built to survive rather than facts about any one corpus: a
 * specific number stated in exactly one place, a question phrased in none of the
 * document's own vocabulary, a document buried under near-identical neighbours,
 * an answer spread across documents, and several questions the corpus genuinely
 * cannot answer.
 *
 * One shape is missing and cannot be reproduced here. The original corpus
 * contained a document declaring itself superseded by its replacement, which is
 * the case for the rerank pass existing at all — no lexical or vector tuning
 * separates two near-identical documents when the only difference is that one is
 * obsolete. Encyclopaedia articles do not announce their own obsolescence, so
 * that behaviour is now covered only by the fixture corpus in `src/testing`, not
 * by this eval.
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
   * Retrieval rank is not the whole requirement. A question can be retrieved
   * perfectly and still answered without the fact that made it worth asking, and
   * the eval would report success while the requirement failed.
   */
  mustMention?: string[];
  /** Why this question is in the set — what it is meant to catch. */
  probes: string;
}

export const EVAL_QUESTIONS: EvalQuestion[] = [
  // --- a fact stated in exactly one document --------------------------------
  {
    id: 'flag-stars',
    question: 'What is on the Circassian flag, and when is flag day?',
    expected: ['circassian-culture/circassian-flag.md'],
    mustMention: ['twelve', 'April 25'],
    probes: 'Two specific facts, both stated in one document and nowhere else.',
  },
  {
    id: 'genocide-scale',
    question:
      'What proportion of the Circassian population was killed or deported during the ' +
      'Russian conquest?',
    expected: ['circassian-genocide/circassian-genocide.md'],
    alsoRelevant: ['circassians/circassians.md', 'circassian-genocide/muhacir.md'],
    mustMention: ['95'],
    probes:
      'A number the corpus states once, in a topic many documents discuss. Every document ' +
      'in the genocide and diaspora categories mentions the deportation; one gives the figure.',
  },

  // --- phrased in none of the document's own vocabulary ---------------------
  {
    id: 'ubykh-consonants',
    question: 'Which Caucasian language had an unusually large number of speech sounds?',
    expected: ['circassian-culture/ubykh-language.md', 'ubykh-language/ubykh-phonology.md'],
    mustMention: ['consonant'],
    probes:
      '"Speech sounds" appears nowhere in the corpus; the documents say "consonants". The ' +
      'keyword arm cannot bridge that, so a hit here is the vector arm doing the work.\n\n' +
      'Two documents are accepted, and the second was added after retrieval found it and ' +
      'this list called it a miss. That is worth flagging, because moving the goalposts ' +
      'after seeing a result is usually how an eval gets quietly corrupted. It stands here ' +
      'because the ground truth was wrong rather than the ranking: ubykh-phonology.md opens ' +
      'with "the largest consonant inventory of all documented languages that do not use ' +
      'clicks, with 84", which answers the question more directly than the language article ' +
      'originally listed. A question with two right answers should say so.',
  },
  {
    id: 'horse-breed',
    question: 'Which animal bred in the Caucasus is prized for coping with mountains?',
    expected: ['circassian-culture/kabarda-horse.md'],
    probes: 'Neither "animal" nor "coping" appears in the document. Paraphrase, not term overlap.',
  },

  // --- buried under near-identical neighbours -------------------------------
  {
    id: 'confederation-leader',
    question: 'Who led the Circassian Confederation in the final years of the war with Russia?',
    expected: [
      'circassian-nobility/gerandiqo-berzeg.md',
      'circassian-nobility/rulers-of-circassia.md',
    ],
    probes:
      'The crowding case. Forty-seven biographies in circassian-nobility share almost all of ' +
      'their vocabulary — Circassian, war, Russia, exile, Ottoman — so vector similarity ' +
      "returns a wall of near-identical documents. Two documents answer it — the leader's own " +
      'biography and the survey of who held the office — and both count, because either one ' +
      'grounds the answer.',
  },
  {
    id: 'secret-language',
    question: 'Was there a secret language used only by Circassian nobles?',
    expected: ['circassian-culture/chakobsa.md'],
    alsoRelevant: ['circassian-culture/circassian-languages.md'],
    probes:
      'A yes/no question whose answer is one clause. The language documents share heavy ' +
      'vocabulary, so the distinguishing term has to carry the retrieval.',
  },

  // --- near-identical pair, where only one document answers ------------------
  {
    id: 'smoked-cheese',
    question: 'How is Circassian smoked cheese produced?',
    expected: ['circassian-cuisine/circassian-smoked-cheese.md'],
    alsoRelevant: ['circassian-cuisine/circassian-cheese.md'],
    probes:
      'Two documents on the same cheese, one of them about the smoked variety. The unsmoked ' +
      'document is longer and mentions cheese more often, which is exactly the way BM25 gets ' +
      'this wrong.',
  },

  // --- an answer that spans documents ---------------------------------------
  {
    id: 'muhacir-diaspora',
    question: 'Why do large Circassian communities live in Turkey and the Levant today?',
    expected: ['circassian-genocide/muhacir.md', 'circassian-diaspora/circassian-diaspora.md'],
    alsoRelevant: ['circassian-genocide/circassian-genocide.md'],
    probes:
      'The cause is in one category and the consequence in another. A good answer joins the ' +
      'deportation to the present-day communities rather than citing either alone.',
  },
  {
    id: 'nart-mother',
    question: 'Who is the mother of the Narts, and what is she compared to?',
    expected: ['circassian-mythology/satanaya.md'],
    alsoRelevant: ['circassian-mythology/nart-saga.md'],
    mustMention: ['Demeter'],
    probes:
      'The saga document is far longer and mentions Satanaya throughout, so length-normalised ' +
      'scoring has to prefer the shorter document that is actually about her.',
  },

  // --- unanswerable, on purpose ---------------------------------------------
  {
    id: 'unanswerable-salary',
    question: 'What is the average salary of a software engineer in Adygea?',
    expected: [],
    probes:
      'The corpus is historical and cultural; it carries no economic data. The correct ' +
      'behaviour is an honest refusal with no invented citation.',
  },
  {
    id: 'unanswerable-population-today',
    question: 'How many people were living in Maykop in 2024?',
    expected: [],
    probes:
      'Plausible-sounding and on-topic — Maykop is named in the corpus — but the figure is ' +
      'not there. Abstention has to survive a question about a subject the corpus does cover.',
  },
  {
    id: 'unanswerable-plausible',
    question: 'How many stars are on the Chechen flag?',
    expected: [],
    probes:
      'The hard case for abstention. Lexically near-identical to flag-stars, and the corpus ' +
      'confidently returns the Circassian flag document for it. Abstaining requires judging ' +
      'relevance, not similarity.',
  },
];

export const ANSWERABLE = EVAL_QUESTIONS.filter((q) => q.expected.length > 0);
export const UNANSWERABLE = EVAL_QUESTIONS.filter((q) => q.expected.length === 0);
