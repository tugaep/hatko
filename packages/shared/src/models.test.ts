import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRESETS, hasModel, presetModels } from './models.ts';

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
