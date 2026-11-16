import assert from "node:assert/strict";
import test from "node:test";
import { connect, appendTurn } from "./sqlite-helper.mjs";
import { ChatController } from "../src/chat/ChatController.ts";

const settings = { apiKey: "test-key", model: "alpha" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("chats pin selections separately from routed reply models and the new-chat choice", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    assert.equal((await store.read()).selectedModel, null);
    await store.setSelectedModel(null, "alpha");
    let history = await store.beginReply("a", "one", "alpha", 1);
    history = await store.finishReply(
      history.messages.at(-1).id,
      "complete",
      "ok",
      null,
      "provider/actual",
    );
    assert.equal(history.selectedModel, "alpha");
    assert.equal(history.messages.at(-1).model, "provider/actual");
    await store.select(null);
    assert.equal((await store.read()).selectedModel, null);
    await store.setSelectedModel(null, "beta");
    await store.beginReply("b", "two", "beta", 2);
    await store.setSelectedModel("b", "gamma");
    assert.equal((await store.select("a")).selectedModel, "alpha");
    assert.equal((await store.select("b")).selectedModel, "gamma");
    assert.equal((await store.select(null)).selectedModel, null);
    await store.setSelectedModel(null, "scratch");
    await store.select("a");
    await store.initialize();
    assert.equal((await store.read()).selectedModel, "alpha");
    assert.equal((await store.select(null)).selectedModel, "scratch");
  } finally {
    sqlite.close();
  }
});

test("v8 migration preserves history and restores the last recorded model", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "old", "question", "reply", 1);
    sqlite.exec(
      "ALTER TABLE chats DROP COLUMN selected_model; ALTER TABLE app_state DROP COLUMN draft_model; PRAGMA user_version = 8",
    );
    await store.initialize();
    assert.equal((await store.read()).selectedModel, "test/model");
    assert.equal((await store.read()).messages.length, 2);
    assert.equal(sqlite.prepare("PRAGMA user_version").get().user_version, 9);
  } finally {
    sqlite.close();
  }
});

test("switching during a reply preserves its model and draft; next send uses the chat selection", async () => {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  let resolve;
  const reply = new Promise((done) => {
    resolve = done;
  });
  const requests = [];
  const controller = new ChatController(
    store,
    await store.read(),
    async (_messages, selected) => {
      requests.push(selected.model);
      return reply;
    },
    () => "a",
    "",
    () => null,
    () => null,
  );
  try {
    assert.equal(await controller.send("hello", settings), true);
    await tick();
    const draft = controller.getSnapshot().draft;
    draft.edit("next message");
    await draft.flush();
    assert.equal(await controller.chooseModel("beta"), true);
    assert.equal(controller.getSnapshot().draft, draft);
    assert.equal(draft.value.text, "next message");
    assert.deepEqual(requests, ["alpha"]);
    resolve({ text: "done", model: "routed/model", cost: 0 });
    await tick();
    assert.equal(controller.getSnapshot().history.selectedModel, "beta");
    assert.equal(
      controller.getSnapshot().history.messages.at(-1).model,
      "routed/model",
    );
    failRead();
    assert.equal(await controller.chooseModel("failed"), false);
    assert.equal((await store.read()).selectedModel, "beta");
    assert.equal(
      await controller.send("next", {
        ...settings,
        model: "new-global-default",
      }),
      true,
    );
    await tick();
    assert.deepEqual(requests, ["alpha", "beta"]);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a failed photo-draft read cannot commit chat navigation or mix the pending chat's draft", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await appendTurn(store, "b", "B", "reply B", 1);
  await store.select(null);
  let resolve;
  const reply = new Promise((done) => {
    resolve = done;
  });
  const controller = new ChatController(
    store,
    await store.read(),
    () => reply,
    () => "a",
    "",
    () => null,
    () => null,
  );
  const originalRead = store.readPhotoDraft.bind(store);
  try {
    await controller.send("A", settings);
    const draft = controller.getSnapshot().draft;
    draft.edit("private A draft");
    await draft.flush();
    store.readPhotoDraft = async (id) => {
      if (id === "b") throw new Error("storage failure");
      return originalRead(id);
    };
    assert.equal(await controller.select("b"), false);
    assert.equal((await store.read()).activeId, "a");
    resolve({ text: "reply A", model: "alpha", cost: 0 });
    await tick();
    assert.equal(controller.getSnapshot().history.activeId, "a");
    assert.equal(controller.getSnapshot().draft, draft);
    assert.equal(draft.value.text, "private A draft");
    store.readPhotoDraft = async (id) => {
      if (id === null) throw new Error("storage failure");
      return originalRead(id);
    };
    assert.equal(await controller.remove("a"), false);
    assert.equal((await store.read()).activeId, "a");
    assert.equal(controller.getSnapshot().draft, draft);
    let reads = 0;
    store.readPhotoDraft = async (id) => {
      reads++;
      if (reads > 1) throw new Error("post-commit read");
      return originalRead(id);
    };
    assert.equal(await controller.select("b"), true);
    assert.equal(reads, 1);
    reads = 0;
    assert.equal(await controller.remove("b"), true);
    assert.equal(reads, 1);
  } finally {
    store.readPhotoDraft = originalRead;
    await controller.dispose();
    sqlite.close();
  }
});
