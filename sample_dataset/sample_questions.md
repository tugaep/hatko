# Sample Questions

Example queries for testing retrieval and answers against the Circassian corpus in
`corpus/`. A good answer cites the listed documents.

These mirror `packages/core/src/eval/questions.ts`, which the eval script runs. The
shapes are the point rather than the specific facts: each question is here because it
fails in a particular way if one part of the retriever is missing.

1. What is on the Circassian flag, and when is flag day?
   Expect: circassian-culture/circassian-flag.md
   — Two specific facts, both stated in one document and nowhere else.

2. What proportion of the Circassian population was killed or deported during the
   Russian conquest?
   Expect: circassian-genocide/circassian-genocide.md
   (circassian-genocide/muhacir.md and circassians/circassians.md add context)
   — A number the corpus states once, in a topic dozens of documents discuss.

3. Which Caucasian language had an unusually large number of speech sounds?
   Expect: circassian-culture/ubykh-language.md
   — "Speech sounds" appears nowhere in the corpus; the document says "consonants".
   The keyword arm cannot bridge that, so this one belongs to the vector arm.

4. Who led the Circassian Confederation in the final years of the war with Russia?
   Expect: circassian-nobility/gerandiqo-berzeg.md or
   circassian-nobility/rulers-of-circassia.md
   — The crowding case. Hundreds of biographies share almost all of their vocabulary
   — Circassian, war, Russia, exile, Ottoman — so similarity alone returns a wall of
   near-identical documents.

5. Was there a secret language used only by Circassian nobles?
   Expect: circassian-culture/chakobsa.md
   — A yes/no question whose answer is a single clause, against a set of language
   documents that share heavy vocabulary.

6. How is Circassian smoked cheese produced?
   Expect: circassian-cuisine/circassian-smoked-cheese.md
   (circassian-cuisine/circassian-cheese.md is the near-identical neighbour)
   — Two documents about the same cheese. The unsmoked one is longer and says
   "cheese" more often, which is how BM25 gets this wrong.

7. Why do large Circassian communities live in Turkey and the Levant today?
   Expect: circassian-genocide/muhacir.md and
   circassian-diaspora/circassian-diaspora.md
   — The cause is in one category and the consequence in another. A good answer joins
   them rather than citing either alone.

8. Who is the mother of the Narts, and what is she compared to?
   Expect: circassian-mythology/satanaya.md
   (circassian-mythology/nart-saga.md adds context)
   — The saga document is far longer and mentions her throughout, so length
   normalisation has to prefer the shorter document that is actually about her.

Also test questions the corpus cannot answer. The correct behaviour is an honest
"no documents cover this", with no invented citation:

- What is the average salary of a software engineer in Adygea?
  — The corpus is historical and cultural and carries no economic data.

- How many people were living in Maykop in 2024?
  — On-topic and plausible; Maykop is named in the corpus, but the figure is not
  there. Abstention has to survive a question about a subject the corpus does cover.

- How many stars are on the Chechen flag?
  — The hard case. Lexically near-identical to question 1, and retrieval confidently
  returns the Circassian flag document for it. Abstaining requires judging relevance
  rather than similarity.
