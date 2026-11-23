import assert from "node:assert/strict";
import test from "node:test";
import { decodeCatalog } from "../src/providers/openrouter/catalogCache.ts";

const MOCK_SAVED_MODELS = [
  {
    id: "test/model",
    name: "Model",
    audio: true,
    image: false,
    inputPrice: 0,
    outputPrice: null,
    maxOutput: 65_536,
    contextLength: 1_048_576,
    aliasTarget: null,
  },
  {
    id: "~test/model-latest",
    name: "Model latest",
    audio: true,
    image: false,
    inputPrice: 0,
    outputPrice: null,
    maxOutput: 65_536,
    contextLength: 1_048_576,
    aliasTarget: "test/model",
  },
];

test("a saved catalog reads back as the models that were saved", () => {
  assert.deepEqual(
    decodeCatalog(JSON.parse(JSON.stringify(MOCK_SAVED_MODELS))),
    MOCK_SAVED_MODELS,
  );
});

test("a catalog in any other shape is rejected for a fresh download", () => {
  for (const bad of [
    null,
    [],
    { version: 5, models: MOCK_SAVED_MODELS },
    [{ ...MOCK_SAVED_MODELS[0], maxOutput: undefined }],
    [{ ...MOCK_SAVED_MODELS[0], contextLength: undefined }],
    // Saved before aliases were read.
    [{ ...MOCK_SAVED_MODELS[0], aliasTarget: undefined }],
    [{ ...MOCK_SAVED_MODELS[0], aliasTarget: "" }],
    [{ ...MOCK_SAVED_MODELS[0], audio: "yes" }],
    [{ ...MOCK_SAVED_MODELS[0], inputPrice: -1 }],
    [{ ...MOCK_SAVED_MODELS[0], outputPrice: "0" }],
    [{ ...MOCK_SAVED_MODELS[0], id: "" }],
  ])
    assert.throws(() => decodeCatalog(bad), /Invalid saved model catalog/);
});
