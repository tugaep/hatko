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
export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;

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
export type SetModelsRequest = z.infer<typeof setModelsRequestSchema>;

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
