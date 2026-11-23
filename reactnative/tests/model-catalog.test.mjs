import assert from "node:assert/strict";
import test from "node:test";
import { decodeCatalog } from "../src/providers/openrouter/catalogCache.ts";

const models = [
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
  assert.deepEqual(decodeCatalog(JSON.parse(JSON.stringify(models))), models);
});

test("a catalog in any other shape is rejected for a fresh download", () => {
  for (const bad of [
    null,
    [],
    { version: 5, models },
    [{ ...models[0], maxOutput: undefined }],
    [{ ...models[0], contextLength: undefined }],
    // Saved before aliases were read.
    [{ ...models[0], aliasTarget: undefined }],
    [{ ...models[0], aliasTarget: "" }],
    [{ ...models[0], audio: "yes" }],
    [{ ...models[0], inputPrice: -1 }],
    [{ ...models[0], outputPrice: "0" }],
    [{ ...models[0], id: "" }],
  ])
    assert.throws(() => decodeCatalog(bad), /Invalid saved model catalog/);
});
