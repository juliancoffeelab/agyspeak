import assert from "node:assert/strict";
import test from "node:test";
import { connect, appendTurn } from "./sqlite-helper.mjs";
import { ChatController } from "../src/chat/ChatController.ts";

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

test("elapsed response time is saved for completion, Stop and retry without using wall-clock timestamps", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  let now = 1000,
    attempt = deferred();
  const controller = new ChatController(
    store,
    await store.read(),
    (_messages, _settings, _signal, onText) => {
      onText("partial");
      return attempt.promise;
    },
    () => "chat",
    "",
    () => null,
    () => null,
    [],
    () => now,
  );
  try {
    await controller.send("Hello", settings);
    await tick();
    now = 2250;
    attempt.resolve({ text: "Complete", model: "test/model", cost: 0 });
    await tick();
    assert.equal((await store.read()).messages.at(-1).elapsedMillis, 1250);
    now = 3000;
    attempt = deferred();
    await controller.send("Again", settings);
    await tick();
    now = 3400;
    await controller.stop();
    const id = controller.getSnapshot().history.messages.at(-1).id;
    assert.equal((await store.read()).messages.at(-1).elapsedMillis, 400);
    now = 5000;
    attempt = deferred();
    await controller.retryReply(id, settings);
    await tick();
    assert.equal((await store.read()).messages.at(-1).elapsedMillis, null);
    now = 5650;
    attempt.reject(new Error("offline"));
    await tick();
    assert.equal((await store.read()).messages.at(-1).elapsedMillis, 650);
    assert.equal((await store.read()).messages.at(-1).status, "failed");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("v9 migration preserves history/model selections and leaves unknown old durations empty", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "old", "Keep me", "Old reply", 1);
    sqlite.exec(
      "ALTER TABLE messages DROP COLUMN elapsed_millis; PRAGMA user_version = 9",
    );
    await store.initialize();
    const history = await store.read();
    assert.equal(history.selectedModel, "test/model");
    assert.equal(history.messages.at(-1).text, "Old reply");
    assert.equal(history.messages.at(-1).elapsedMillis, null);
    assert.equal(sqlite.prepare("PRAGMA user_version").get().user_version, 10);
  } finally {
    sqlite.close();
  }
});
