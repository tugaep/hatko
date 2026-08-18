import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEASURED_CHAT_MODEL,
  MODEL_PRESETS,
  OPENAI_CHAT_MODELS,
  chatModels,
  hasModel,
  presetModels,
  rerankWarning,
} from './models.ts';

/**
 * `hasModel` decides whether the dashboard tells an admin to install something.
 *
 * Both ways of being wrong are bad and neither is loud. Too strict, and someone who has
 * already pulled every model is told to pull them again — the panel cries wolf and gets
 * ignored. Too loose, and the install instructions never appear for the person who
 * actually needs them, who then meets a 404 on their first question instead.
 */

test('an implicit :latest tag counts as installed', () => {
  // Ollama reports `ollama pull nomic-embed-text` as `nomic-embed-text:latest`, so a
  // literal comparison against the configured name reports a working model as missing.
  assert.equal(hasModel(['nomic-embed-text:latest'], 'nomic-embed-text'), true);
  assert.equal(hasModel(['qwen2.5:7b'], 'qwen2.5:7b'), true);
});

test('a different tag of the same model is not a substitute', () => {
  // qwen2.5:3b was measured at 7/12 answer checks where 7b reaches 12/12. Treating one
  // tag as another would silently run the configuration nobody chose.
  assert.equal(hasModel(['qwen2.5:3b'], 'qwen2.5:7b'), false);
  assert.equal(hasModel([], 'qwen2.5:7b'), false);
});

test('the embedding model is one of the models a preset requires', () => {
  for (const preset of MODEL_PRESETS) {
    // The panel cannot change the embedding model, and that turned into not checking it:
    // an operator with the chat model pulled and the embedding model missing got a clean
    // panel and a failure at `npm run ingest`. Not settable is not the same as not needed.
    assert.ok(
      presetModels(preset).includes(preset.embeddingModel),
      `${preset.id} omits its embedding model from the models it requires`,
    );
  }
});

test('every preset names the models its install commands actually pull', () => {
  // The commands are what an operator copies. If a preset's models and its instructions
  // drift apart, the panel confidently prints the wrong fix — and it would still look
  // right, because nothing else compares the two.
  for (const preset of MODEL_PRESETS) {
    if (!preset.install) continue;
    const pulled = preset.install.commands.map((command) => command.split(/\s+/).at(-1) ?? '');
    for (const model of presetModels(preset)) {
      assert.ok(
        hasModel(pulled, model) || pulled.includes(model),
        `${preset.id} uses ${model} but never pulls it`,
      );
    }
  }
});

/**
 * The dropdown's contents.
 *
 * `chatModels` decides what an admin is offered, and both ways of being wrong show up
 * as a support question rather than a crash: offer `text-embedding-3-small` and their
 * first question dies on a modality error, filter too hard on a self-hosted server and
 * the dropdown is empty on a machine where everything is installed correctly. The
 * OpenAI list below is real ids from /v1/models, not invented ones.
 */

const OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-5-nano',
  'gpt-3.5-turbo',
  'gpt-4o',
  'gpt-4.1',
  'o3-mini',
  'text-embedding-3-small',
  'text-embedding-3-large',
  'gpt-4o-realtime-preview',
  'gpt-4o-audio-preview',
  'gpt-4o-transcribe',
  'tts-1',
  'whisper-1',
  'dall-e-3',
  'omni-moderation-latest',
  'gpt-3.5-turbo-instruct',
  'gpt-4o-search-preview',
];

test('OpenAI is narrowed to the three offered models, in that order', () => {
  assert.deepEqual(chatModels(OPENAI_MODELS, true), ['gpt-4o-mini', 'gpt-5-nano', 'gpt-3.5-turbo']);
});

test('nothing that cannot answer a question survives, whatever the provider lists', () => {
  const offered = chatModels(OPENAI_MODELS, true);
  for (const rejected of [
    'text-embedding-3-small',
    'tts-1',
    'whisper-1',
    'dall-e-3',
    'gpt-3.5-turbo-instruct',
    'gpt-4o-realtime-preview',
  ]) {
    assert.ok(!offered.includes(rejected), `${rejected} cannot answer a question`);
  }
});

/**
 * The half that keeps a dropdown entry honest. An account without `gpt-5-nano` must not be
 * offered it — a curated list that ignores what the provider actually has just moves the
 * failure from the dropdown to the first question.
 */
test('a model the account does not advertise is not offered', () => {
  const withoutNano = OPENAI_MODELS.filter((id) => id !== 'gpt-5-nano');
  assert.deepEqual(chatModels(withoutNano, true), ['gpt-4o-mini', 'gpt-3.5-turbo']);
  assert.deepEqual(chatModels([], true), []);
});

test('the measured model is first, so it is the visible default', () => {
  assert.equal(chatModels(OPENAI_MODELS, true)[0], MEASURED_CHAT_MODEL);
  assert.equal(OPENAI_CHAT_MODELS[0], MEASURED_CHAT_MODEL, 'display order is the list order');
});

test('an unreachable provider yields an empty list rather than throwing', () => {
  assert.deepEqual(chatModels([], true), []);
  assert.deepEqual(chatModels([], false), []);
});

test('every offered model is one a preset or the measured default already names', () => {
  // Guards the list against drifting into ids nobody checked against this corpus.
  assert.ok(OPENAI_CHAT_MODELS.includes(MEASURED_CHAT_MODEL));
  assert.equal(new Set(OPENAI_CHAT_MODELS).size, OPENAI_CHAT_MODELS.length);
});

/**
 * The warning exists because changing the rerank model changes whether the system
 * abstains, and that failure is silent — it answers confidently instead of erroring.
 */
test('changing the rerank model warns about abstention, keeping the measured one does not', () => {
  assert.equal(rerankWarning(MEASURED_CHAT_MODEL), null);

  const warning = rerankWarning('gpt-4o');
  assert.ok(warning, 'a different grader must be flagged');
  assert.match(warning, /0\.67/, 'the threshold is named, because that is what shifts');
  assert.match(warning, /gpt-4o/, 'the model being warned about is named');
});
