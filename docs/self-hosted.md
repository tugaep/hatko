# Running on self-hosted models

hatko talks to OpenAI over two endpoints, `POST /embeddings` and
`POST /chat/completions`. Ollama, llama.cpp, LM Studio and vLLM all serve those two
endpoints in the same request and response shape, so running with no external provider
is a change of address rather than a second client. There is no provider abstraction in
the codebase and there should not be one: `OPENAI_BASE_URL` is the whole mechanism.

OpenAI remains the default and the recommended configuration. Local support is
deliberately basic: **one** validated configuration, listed below.

---

## 1. What was measured

Both rows are `npm run eval -- --rerank --answers` on the same machine, on 18 Aug 2026,
against the 142-document sample corpus this project used at the time. Nothing here is
estimated, and nothing here has been re-measured against the current corpus, which is
1083 documents and 7539 chunks. Treat the comparison between configurations as sound and
the absolute figures as belonging to a corpus that is no longer the default.

| Configuration                                   | recall@1 | recall@3 |   MRR | Answer checks | Latency |
| ----------------------------------------------- | -------: | -------: | ----: | ------------: | ------: |
| OpenAI `gpt-4o-mini` + `text-embedding-3-small` |     100% |     100% | 1.000 |         12/12 |   2.7 s |
| Ollama `qwen2.5:7b` + `nomic-embed-text`        |     100% |     100% | 1.000 |         12/12 |   4.4 s |

Latency is one `npm run ask` on an Apple M5 Pro with GPU acceleration; expect
considerably worse without a GPU. The answer checks are the important column, because they
assert that answerable questions are answered with a real citation, that unanswerable
ones abstain, and that no citation is invented.

**Two smaller models were measured and rejected.** They are recorded here because "we
tried and it did not work" is more useful than a silent omission:

| Rejected model | Answer checks | Why                                                                                                                             |
| -------------- | ------------: | ------------------------------------------------------------------------------------------------------------------------------- |
| `qwen2.5:3b`   |          7/12 | Answers correctly but frequently omits the `[n]` citation marker, so the answer is withheld as unverifiable.                    |
| `llama3.2:3b`  |          4/12 | Graded every unanswerable question fully relevant, which destroys abstention, and its reranking dropped hybrid recall@1 to 56%. |

The `llama3.2:3b` failure is the one that matters. A model that cannot say "nothing here
answers this" turns the corpus's most important behaviour into confident invention, and
it fails quietly. The system looks healthy and answers everything.

---

## 2. The two things that must change together

### The vector column width

`chunks_vec` is a `vec0` virtual table whose width is a literal: `float[1536]` for
OpenAI, `float[768]` for `nomic-embed-text`. It cannot be altered, and vectors from two
embedding models are not comparable in any case, so **changing the embedding model means
rebuilding the index**:

```bash
# in .env
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

```bash
npm run db:reset && npm run ingest
```

The width is substituted into migration 001 from `EMBEDDING_DIMENSIONS`, so a fresh
database is created at whatever is configured. Opening an existing database whose stored
width disagrees fails immediately with the commands above, rather than degrading into a
vector arm that silently returns nothing.

This is also why the embedding model is **not** settable from the dashboard: a form field
that quietly empties search is worse than no form field.

### The abstain threshold

Abstention compares the reranker's absolute grade against `MIN_USEFUL_GRADE / 3`, and
0.67. That threshold was calibrated on `gpt-4o-mini`, and it holds for `qwen2.5:7b`:
measured, answerable questions grade 1.00 and unanswerable ones 0.00, so the two sets do
not overlap at all. It does **not** hold for the rejected models above. Any new model
needs `npm run eval -- --rerank --answers` run against it before it is trusted, which is
the reason the presets carry measured numbers rather than adjectives.

---

## 3. Setting it up

```bash
# 1. install and start a runtime
brew install ollama          # or https://ollama.com/download
ollama serve

# 2. pull the validated pair
ollama pull nomic-embed-text
ollama pull qwen2.5:7b

# 3. point hatko at it, in .env
OPENAI_BASE_URL=http://localhost:11434/v1
ANSWER_MODEL=qwen2.5:7b
RERANK_MODEL=qwen2.5:7b
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768

# 4. rebuild the index at the new width
npm run db:reset && npm run ingest && npm run seed
```

No API key is required. `OPENAI_API_KEY` is still sent if one is set, because vLLM and
similar can be started with `--api-key`.

Set `OLLAMA_CONTEXT_LENGTH=8192` before `ollama serve`. The default 4096 is not comfortably
larger than a rerank prompt carrying six passages, and Ollama truncates silently rather
than erroring.

### From the dashboard instead

An admin can switch between the two configurations on the dashboard without touching
`.env`. The stored choice overrides the environment for the base URL and the two chat
models, exactly as the stored API key overrides `OPENAI_API_KEY`.

The panel probes the selected server and, when the models are absent, prints the
`ollama pull` commands rather than letting the mistake surface as a 404 on somebody's
first question. It cannot complete an embedding-model change, so it prints the `.env`
lines and the rebuild command for that half.

---

## 4. Known limits

- **One validated model.** Anything else is unmeasured, and the rejected models above
  show the failure is not gradual.
- **Local abstains more readily on paraphrases.** `qwen2.5:7b` passes all twelve eval
  questions, but on wordings outside that set it was observed grading every passage 0 and
  abstaining where OpenAI answers. Retrieval is unaffected; this is the reranker being
  strict.
- **Slower, and hardware-dependent.** 4.4 s against 2.7 s here, and that gap widens
  without a GPU.
- **Embedding and chat come from one base URL.** Serving embeddings locally and answers
  from OpenAI would need two addresses, and there is no configuration for that because
  nothing has asked for it.
