import assert from "node:assert/strict";
import test from "node:test";
import {
  matchModels,
  modelPrice,
  parseModels,
  parseUsage,
  routerGet,
} from "../src/chat/routerMetadata.ts";

test("catalog keeps text-output models and their audio capabilities", () => {
  const models = parseModels({
    data: [
      {
        id: "google/flash",
        name: "Gemini Flash",
        architecture: {
          input_modalities: ["text", "audio"],
          output_modalities: ["text"],
        },
      },
      {
        id: "vendor/image",
        name: "Image",
        architecture: { output_modalities: ["image"] },
      },
      {
        id: "vendor/chat",
        name: "Chat",
        architecture: { input_modalities: ["text"] },
      },
      { id: 42 },
    ],
  });
  assert.deepEqual(
    models.map((model) => [model.id, model.audio]),
    [
      ["vendor/chat", false],
      ["google/flash", true],
    ],
  );
  assert.equal(matchModels(models, "GOOGLE flash")[0].name, "Gemini Flash");
  assert.deepEqual(matchModels(models, "missing"), []);
  assert.throws(() => parseModels({ data: [] }));
});

test("wallet balance and key allowance remain distinct, including uncapped keys", () => {
  const key = {
    data: { usage_daily: 0.00123, usage_monthly: 2, limit_remaining: 8 },
  };
  assert.deepEqual(
    parseUsage(key, { data: { total_credits: 20, total_usage: 5 } }),
    { daily: 0.00123, monthly: 2, remaining: 15, accountBalance: true },
  );
  assert.equal(parseUsage(key, null).remaining, 8);
  assert.equal(parseUsage(key, null).accountBalance, false);
  assert.equal(
    parseUsage({ data: { ...key.data, limit_remaining: null } }, null)
      .remaining,
    null,
  );
  assert.throws(() => parseUsage({ data: { usage_monthly: 2 } }, null));
});

test("catalog GET is public; usage GET uses bearer auth without sending prompts", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const signal = new AbortController().signal;
  await routerGet("models", signal, undefined, fetcher);
  await routerGet("key", signal, "fake-key", fetcher);
  assert.equal(calls[0][0], "https://openrouter.ai/api/v1/models");
  assert.deepEqual(calls[0][1].headers, {});
  assert.equal(calls[1][1].headers.Authorization, "Bearer fake-key");
  assert.equal(calls[1][1].body, undefined);
  await assert.rejects(
    routerGet("key", signal, "fake-key", async () => ({
      ok: false,
      status: 401,
    })),
    /rejected/,
  );
});

test("suggestion prices use catalog rates, preserve free, and reject missing prices", () => {
  const [paid] = parseModels({
    data: [
      {
        id: "paid",
        name: "Paid",
        pricing: { prompt: "0.0000003", completion: "0.0000025" },
      },
    ],
  });
  assert.equal(modelPrice(paid), "$0.30 in · $2.50 out / 1M tokens");
  const [free] = parseModels({
    data: [
      { id: "free", name: "Free", pricing: { prompt: "0", completion: "0" } },
    ],
  });
  assert.equal(modelPrice(free), "$0.00 in · $0.00 out / 1M tokens");
  const [unknown] = parseModels({
    data: [
      {
        id: "unknown",
        name: "Unknown",
        pricing: { prompt: "", completion: "-1" },
      },
    ],
  });
  assert.equal(modelPrice(unknown), "Price unavailable");
  const [cached] = parseModels({
    data: [
      {
        id: paid.id,
        name: paid.name,
        pricing: { prompt: paid.inputPrice, completion: paid.outputPrice },
      },
    ],
  });
  assert.equal(modelPrice(cached), modelPrice(paid));
});
