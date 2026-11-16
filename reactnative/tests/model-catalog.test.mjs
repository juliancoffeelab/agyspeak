import assert from "node:assert/strict";
import test from "node:test";
import { decodeCatalog, encodeCatalog } from "../src/chat/modelCatalog.ts";

const models = [
  {
    id: "test/model",
    name: "Model",
    audio: true,
    image: false,
    inputPrice: 0,
    outputPrice: null,
  },
];

test("saved catalog preserves normalized records without reconstructing provider JSON", () => {
  const stored = JSON.parse(JSON.stringify(encodeCatalog(models)));
  assert.deepEqual(stored, { version: 4, models });
  assert.deepEqual(decodeCatalog(stored), models);
});

test("unsupported or damaged catalogs are rejected for a fresh download", () => {
  for (const bad of [
    null,
    { version: 1, models },
    { version: 2, models },
    { version: 3, models },
    { version: 4, models: [] },
    { version: 4, models: [{ ...models[0], audio: "yes" }] },
    { version: 4, models: [{ ...models[0], inputPrice: -1 }] },
    { version: 4, models: [{ ...models[0], outputPrice: "0" }] },
    { version: 4, models: [{ ...models[0], id: "" }] },
  ])
    assert.throws(() => decodeCatalog(bad), /Invalid saved model catalog/);
});
