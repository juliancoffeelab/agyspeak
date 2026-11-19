import assert from "node:assert/strict";
import test from "node:test";
import {
  matchModels,
  modelPrice,
  parseModels,
  parseUsage,
  replyTokenLimit,
  routerGet,
} from "../src/providers/openrouter/metadata.ts";

test("catalog keeps text-output models and their audio capabilities", () => {
  const models = parseModels({
    data: [
      {
        id: "google/flash",
        name: "Gemini Flash",
        endpoints: ["/api/v1/chat/completions"],
        architecture: {
          input_modalities: ["text", "audio"],
          output_modalities: ["text"],
        },
      },
      {
        id: "vendor/image",
        name: "Image",
        endpoints: ["/api/v1/chat/completions"],
        architecture: { output_modalities: ["image"] },
      },
      {
        id: "vendor/chat",
        name: "Chat",
        endpoints: ["/api/v1/chat/completions"],
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
  assert.equal(
    matchModels(models, "GOOGLE flash", null)[0].name,
    "Gemini Flash",
  );
  assert.deepEqual(matchModels(models, "missing", null), []);
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
  await routerGet("models", signal, null, fetcher);
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
        endpoints: ["/api/v1/chat/completions"],
        pricing: { prompt: "0.0000003", completion: "0.0000025" },
      },
    ],
  });
  assert.equal(modelPrice(paid), "$0.30 in · $2.50 out / 1M tokens");
  const [free] = parseModels({
    data: [
      {
        id: "free",
        name: "Free",
        endpoints: ["/api/v1/chat/completions"],
        pricing: { prompt: "0", completion: "0" },
      },
    ],
  });
  assert.equal(modelPrice(free), "$0.00 in · $0.00 out / 1M tokens");
  const [unknown] = parseModels({
    data: [
      {
        id: "unknown",
        name: "Unknown",
        endpoints: ["/api/v1/chat/completions"],
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
        endpoints: ["/api/v1/chat/completions"],
        pricing: { prompt: paid.inputPrice, completion: paid.outputPrice },
      },
    ],
  });
  assert.equal(modelPrice(cached), modelPrice(paid));
});

test("catalog requires explicit Chat Completions compatibility, independent of text output", () => {
  const model = {
    id: "vendor/chat",
    name: "Chat",
    architecture: { output_modalities: ["text"] },
  };
  const parsed = parseModels({
    data: [
      {
        ...model,
        endpoints: ["/api/v1/chat/completions", "/api/v1/responses"],
      },
      { ...model, id: "vendor/batch", endpoints: ["/api/v1/batches"] },
      { ...model, id: "vendor/responses", endpoints: ["/api/v1/responses"] },
      { ...model, id: "vendor/unknown" },
      {
        ...model,
        id: "vendor/malformed",
        endpoints: "/api/v1/chat/completions",
      },
      {
        ...model,
        id: "vendor/image-only",
        endpoints: ["/api/v1/chat/completions"],
        architecture: { output_modalities: ["image"] },
      },
    ],
  });
  assert.deepEqual(
    parsed.map((item) => item.id),
    ["vendor/chat"],
  );
});

test("a reply is asked for our limit, or the model's own when that is smaller", () => {
  const entry = (id, top_provider) => ({
    id,
    name: id,
    endpoints: ["/api/v1/chat/completions"],
    top_provider,
  });
  const models = parseModels({
    data: [
      entry("big", { max_completion_tokens: 65_536 }),
      entry("small", { max_completion_tokens: 4_096 }),
      entry("unstated", { max_completion_tokens: null }),
      entry("absent", undefined),
    ],
  });
  assert.equal(replyTokenLimit("big", models), 27_000);
  assert.equal(replyTokenLimit("small", models), 4_096);
  assert.equal(replyTokenLimit("unstated", models), 27_000);
  assert.equal(replyTokenLimit("absent", models), 27_000);
  assert.equal(replyTokenLimit("custom/unlisted", models), 27_000);
  assert.equal(replyTokenLimit("big", undefined), 27_000);
});
