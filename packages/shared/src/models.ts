import { z } from 'zod';

/**
 * Which models the system runs on, and what it costs to change them.
 *
 * Declared here rather than in the web app because three consumers have to agree: the
 * API resolves and validates a selection, the dashboard renders the choice, and
 * docs/self-hosted.md quotes the same measured figures. A preset list maintained in the
 * component would be a fourth opinion about which models exist.
 */

/**
 * Models actually in force, after the database overrides the environment.
 *
 * `embeddingModel` and `embeddingDimensions` are reported but not settable. The vector
 * column is created at one width and vectors from two embedding models are not
 * comparable, so changing the embedding model is a rebuild — `npm run db:reset &&
 * npm run ingest` — not a form field. Sending them anyway lets the panel say so with
 * the real values instead of a generic warning.
 */
export const activeModelsSchema = z.object({
  baseUrl: z.string(),
  isOpenAI: z.boolean(),
  /** `OpenAI`, or the host of a self-hosted server. Used wherever a failure is reported. */
  providerLabel: z.string(),
  answerModel: z.string(),
  rerankModel: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int().positive(),
  source: z.enum(['database', 'environment']),
});
export type ActiveModels = z.infer<typeof activeModelsSchema>;

/**
 * What the configured server reports it can actually serve.
 *
 * The reason this exists: selecting a local preset in the dashboard does not install
 * anything. Without a probe the panel would cheerfully offer `qwen2.5:7b` to someone
 * who has never run Ollama, and the only sign of trouble would be a 404 on their first
 * question. Asking the server what it has turns that into an instruction beforehand.
 */
export const providerAvailabilitySchema = z.object({
  /**
   * Which server was actually asked.
   *
   * Reported because the answer is only meaningful next to the question. The panel
   * probes the configuration an admin is *considering*, not the one in force, and
   * without this field it read one server's model list as if it described another —
   * OpenAI's 124 models were checked for `qwen2.5:7b`, so a correctly installed local
   * model was reported missing with an install command the operator did not need.
   */
  probedBaseUrl: z.string(),
  reachable: z.boolean(),
  /** Model ids the server advertises. Empty when unreachable. */
  models: z.array(z.string()),
  /** Why the probe failed, safe to show an admin. Null when it succeeded. */
  error: z.string().nullable(),
});

export const modelSettingsSchema = z.object({
  active: activeModelsSchema,
  availability: providerAvailabilitySchema,
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const setModelsRequestSchema = z.object({
  baseUrl: z.url(),
  answerModel: z.string().trim().min(1).max(120),
  rerankModel: z.string().trim().min(1).max(120),
});

/**
 * How to obtain a preset's models when the server does not have them.
 *
 * Commands rather than prose: an admin who picked a local preset needs the two lines
 * that make it work, not a description of a package manager.
 */
export interface ModelInstall {
  runtime: string;
  url: string;
  commands: string[];
}

export interface ModelPreset {
  id: string;
  label: string;
  baseUrl: string;
  answerModel: string;
  rerankModel: string;
  /** Fixed by the vector column width; changing it needs a re-ingest, so it is shown, not set. */
  embeddingModel: string;
  embeddingDimensions: number;
  /** Null for a hosted provider, which needs no installation. */
  install: ModelInstall | null;
  /** Measured on the eval set, not estimated. Quoted in docs/self-hosted.md. */
  measured: string;
}

/**
 * The selectable configurations, each with its own measured result.
 *
 * Every `measured` string is the score from `npm run eval -- --rerank --answers` against
 * that exact configuration on the sample corpus, not an impression. They are quoted
 * because the honest summary of a model choice is a number, and an operator picking one
 * should see it before they switch rather than afterwards.
 *
 * **Only configurations that were measured to work are listed.** qwen2.5:3b (7/12 answer
 * checks) and llama3.2:3b (4/12, and it graded every unanswerable question as fully
 * relevant, which destroys abstention) were both measured and both left out. A dropdown
 * entry is an endorsement; offering a model that quietly stops the system saying "no
 * documents cover this" would be worse than offering no local option at all.
 *
 * The two entries differ in embedding width, so moving between them requires rebuilding
 * the index. The panel says so, and the migration refuses to open a mismatched database
 * in any case.
 */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI — default, recommended',
    baseUrl: 'https://api.openai.com/v1',
    answerModel: 'gpt-4o-mini',
    rerankModel: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1536,
    install: null,
    measured:
      'Measured: recall@1 100%, MRR 1.000, answer checks 12/12, about 2.7 s per answer. Needs an API key.',
  },
  {
    id: 'ollama-qwen7b',
    label: 'Local — Ollama, qwen2.5:7b',
    baseUrl: 'http://localhost:11434/v1',
    answerModel: 'qwen2.5:7b',
    rerankModel: 'qwen2.5:7b',
    embeddingModel: 'nomic-embed-text',
    embeddingDimensions: 768,
    install: {
      runtime: 'Ollama',
      url: 'https://ollama.com/download',
      commands: ['ollama pull nomic-embed-text', 'ollama pull qwen2.5:7b'],
    },
    measured:
      'Measured: recall@1 100%, MRR 1.000, answer checks 12/12, about 4.4 s per answer on an Apple M5 Pro — slower without a GPU. About 5 GB of models. No API key, and no text leaves the machine.',
  },
];

/**
 * Whether a server advertising `available` can serve `wanted`.
 *
 * Ollama reports an unqualified pull as `name:latest`, so a literal comparison against
 * the configured `nomic-embed-text` reports a model as missing while it sits there
 * working. Matching the implicit tag is what keeps the install prompt from firing at
 * someone who has already installed everything.
 */
export function hasModel(available: readonly string[], wanted: string): boolean {
  const target = wanted.includes(':') ? wanted : `${wanted}:latest`;
  return available.some((id) => id === wanted || id === target);
}

/**
 * Every distinct model a preset needs the server to have.
 *
 * Exported rather than assembled in the panel, because assembling it there is how the
 * embedding model got left out: the panel cannot *set* that model, and "cannot set it"
 * quietly became "need not check it" — so an operator missing `nomic-embed-text` saw no
 * install prompt and met the failure at `npm run ingest`. One list, one place, one test.
 */
export function presetModels(preset: ModelPreset): string[] {
  return [...new Set([preset.answerModel, preset.rerankModel, preset.embeddingModel])];
}

/**
 * The model this system's numbers were measured against.
 *
 * Named once, because three places have to agree about it: the preset, the option the
 * dropdown marks as measured, and the warning shown when the rerank model is something
 * else. The abstain threshold is the reason it matters — see `rerankableWarning`.
 */
export const MEASURED_CHAT_MODEL = 'gpt-4o-mini';

/**
 * The OpenAI models this system offers, and nothing else.
 *
 * A curated three rather than the ~124 ids `/v1/models` advertises, for the reason the
 * preset list already states: a dropdown entry is an endorsement. Most of those ids are
 * embeddings, speech or image models that fail on the first request; of the rest, offering
 * sixty near-identical dated snapshots invites a choice nobody has a basis for making.
 *
 * Three, spanning the axis an operator actually cares about — cost against capability —
 * with the measured one first and named as measured:
 *
 * - `gpt-4o-mini`   the default, and the only one behind the reported figures
 * - `gpt-5-nano`    newer and cheaper, untested here
 * - `gpt-3.5-turbo` the cheap floor, and old enough that its grading is the least like
 *                   the model the abstain threshold was calibrated against
 *
 * Order is significance, not alphabet, and it is the display order — this list is not
 * sorted anywhere. Anything else remains settable through `.env` for whoever has a reason.
 */
export const OPENAI_CHAT_MODELS = ['gpt-4o-mini', 'gpt-5-nano', 'gpt-3.5-turbo'] as const;

/**
 * The models to offer for a provider, given what that provider says it has.
 *
 * Two different rules, and the difference is the important half. For OpenAI the curated
 * list is intersected with what the account actually advertises, so an account without
 * `gpt-5-nano` is never offered it — the alternative is a dropdown entry that fails on
 * first use, which is the failure this function exists to prevent.
 *
 * A self-hosted server is passed through whole. It advertises exactly what was pulled onto
 * it, under names (`qwen2.5:7b`) no OpenAI-shaped rule recognises, so filtering there would
 * empty the dropdown on a correctly installed machine — the same class of bug the
 * `hasModel` tag-matching already exists to prevent. They installed it; they know what it is.
 */
export function chatModels(available: readonly string[], isOpenAI: boolean): string[] {
  if (!isOpenAI) return [...available];
  return OPENAI_CHAT_MODELS.filter((model) => available.includes(model));
}

/**
 * Why changing the rerank model is not the same kind of choice as changing the answer model.
 *
 * The answer model writes prose, and a different one writes different prose — visible,
 * judgable, reversible. The rerank model decides *whether the corpus can answer at all*:
 * abstention compares its 0–3 grade against a threshold of 0.67, and that threshold was
 * placed between measured values, answerable 1.00 and unanswerable at most 0.33, produced
 * by one model. A grader that runs generous pushes unanswerable questions above the line
 * and the system starts answering things the corpus does not cover — the one behaviour
 * §4 of the working agreement calls non-negotiable, failing silently.
 *
 * Returned as a string rather than enforced as a refusal, deliberately. An operator is
 * allowed to change it; they are not allowed to change it without being told what it
 * costs, and `npm run eval -- --rerank --answers` is how they would find out.
 */
export function rerankWarning(rerankModel: string): string | null {
  if (rerankModel === MEASURED_CHAT_MODEL) return null;
  return (
    `Abstention is calibrated against ${MEASURED_CHAT_MODEL}: answerable questions grade ` +
    '1.00 and unanswerable ones at most 0.33, with the threshold at 0.67 between them. ' +
    `${rerankModel} has not been measured on that scale, so it may answer questions the ` +
    'corpus does not cover. Re-run `npm run eval -- --rerank --answers` to check.'
  );
}
