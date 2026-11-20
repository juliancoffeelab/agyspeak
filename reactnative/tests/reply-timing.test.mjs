import assert from "node:assert/strict";
import test from "node:test";
import {
  connect,
  coordinator,
  latestId,
  readLatest,
} from "./sqlite-helper.mjs";

// Usage a mocked reply reports: none.
const MOCK_USAGE = {
  costUSD: null,
  promptTokens: null,
  completionTokens: null,
  cachedPromptTokens: null,
  cacheWritePromptTokens: null,
};
const settings = { apiKey: "test-key", model: "test/model" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("elapsed response time is saved for completion, Stop and retry without using wall-clock timestamps", async (t) => {
  const { store, sqlite } = connect();
  await store.initialize();
  let now = 1000,
    attempt = deferred();
  t.mock.method(performance, "now", () => now);
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: (_messages, _settings, _signal, onText) => {
      onText("partial");
      return attempt.promise;
    },
    settings: () => settings,
  });
  try {
    await controller.send("Hello", []);
    await tick();
    now = 2250;
    attempt.resolve({
      text: "Complete",
      model: "test/model",
      usage: MOCK_USAGE,
      stopped: null,
    });
    await tick();
    assert.equal((await readLatest(store)).messages.at(-1).elapsedMillis, 1250);
    now = 3000;
    attempt = deferred();
    await controller.send("Again", []);
    await tick();
    now = 3400;
    await controller.stop();
    const id = controller.state.getState().history.messages.at(-1).id;
    assert.equal((await readLatest(store)).messages.at(-1).elapsedMillis, 400);
    now = 5000;
    attempt = deferred();
    await controller.retryReply(id);
    await tick();
    assert.equal((await readLatest(store)).messages.at(-1).elapsedMillis, null);
    now = 5650;
    attempt.reject(new Error("offline"));
    await tick();
    assert.equal((await readLatest(store)).messages.at(-1).elapsedMillis, 650);
    assert.equal((await readLatest(store)).messages.at(-1).status, "failed");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
