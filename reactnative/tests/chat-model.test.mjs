import assert from "node:assert/strict";
import test from "node:test";
import {
  connect,
  coordinator,
  latestId,
  appendTurn,
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
let settings = { apiKey: "test-key", model: "alpha" };
// Runs one call with changed settings; they are read as the call starts.
function withSettings(change, call) {
  const before = settings;
  settings = { ...settings, ...change };
  try {
    return call();
  } finally {
    settings = before;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("each chat keeps its own model; a new chat starts without one and keeps its choice across restarts", async () => {
  const { store, sqlite } = connect();
  const turn = (text) => ({ kind: "text", text, photos: [] });
  try {
    await store.initialize();
    const first = await store.readNewChat();
    assert.equal(first.selectedModel, null);
    await store.setSelectedModel(first.id, "alpha");
    let history = await store.beginReply(first.id, turn("one"), "alpha", 1);
    history = await store.finishReply(history.replyId, {
      status: "complete",
      text: "ok",
      error: null,
      model: "provider/actual",
      elapsedMillis: null,
    });
    assert.equal(history.chat.selectedModel, "alpha");
    assert.equal(history.chat.messages.at(-1).model, "provider/actual");
    // The first chat is saved now, so the new chat is another one.
    const second = (await store.activateNew()).chat;
    assert.notEqual(second.id, first.id);
    assert.equal(second.selectedModel, null);
    await store.setSelectedModel(second.id, "beta");
    await store.beginReply(second.id, turn("two"), "beta", 2);
    await store.setSelectedModel(second.id, "gamma");
    assert.equal((await store.activate(first.id)).chat.selectedModel, "alpha");
    assert.equal((await store.activate(second.id)).chat.selectedModel, "gamma");
    const third = (await store.activateNew()).chat;
    assert.equal(third.selectedModel, null);
    await store.setSelectedModel(third.id, "scratch");
    assert.equal((await store.activateNew()).chat.id, third.id);
    await store.initialize();
    assert.equal((await readLatest(store)).selectedModel, "gamma");
    assert.equal((await store.activate(first.id)).chat.selectedModel, "alpha");
    assert.deepEqual(await store.readNewChat(), {
      id: third.id,
      selectedModel: "scratch",
      draft: { text: "", photos: [] },
    });
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
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: async (_messages, selected) => {
      requests.push(selected.model);
      return reply;
    },
    settings: () => settings,
  });
  try {
    assert.equal(await controller.send("hello", []), true);
    await tick();
    const draft = controller.state.getState().draft;
    draft.edit("next message");
    await draft.flush();
    await controller.chooseModel("beta");
    assert.equal(controller.state.getState().draft, draft);
    assert.equal(draft.value.text, "next message");
    assert.deepEqual(requests, ["alpha"]);
    resolve({
      text: "done",
      model: "routed/model",
      usage: MOCK_USAGE,
      stopped: null,
    });
    await tick();
    assert.equal(controller.state.getState().history.selectedModel, "beta");
    assert.equal(
      controller.state.getState().history.messages.at(-1).model,
      "routed/model",
    );
    failRead();
    await assert.rejects(controller.chooseModel("failed"));
    assert.equal(controller.state.getState().saving, false);
    assert.equal(controller.state.getState().error, null);
    assert.equal((await readLatest(store)).selectedModel, "beta");
    assert.equal(
      await withSettings({ model: "new-global-default" }, () =>
        controller.send("next", []),
      ),
      true,
    );
    await tick();
    assert.deepEqual(requests, ["alpha", "beta"]);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a failed activation read cannot commit chat navigation or mix the pending chat's draft", async () => {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  await appendTurn(store, "b", "B", "reply B", 1);
  let resolve;
  const reply = new Promise((done) => {
    resolve = done;
  });
  const controller = await coordinator({
    store,
    openAt: null,
    reply: () => reply,
    settings: () => settings,
  });
  try {
    await controller.send("A", []);
    const draft = controller.state.getState().draft;
    draft.edit("private A draft");
    await draft.flush();
    failRead();
    assert.equal(await controller.select("b"), false);
    assert.equal(controller.state.getState().openFailure.id, "b");
    assert.equal((await readLatest(store)).activeId, "chat");
    resolve({
      text: "reply A",
      model: "alpha",
      usage: MOCK_USAGE,
      stopped: null,
    });
    await tick();
    assert.equal(controller.state.getState().history.activeId, "chat");
    assert.equal(controller.state.getState().draft, draft);
    assert.equal(draft.value.text, "private A draft");
    assert.equal(
      controller.state.getState().history.messages.at(-1).text,
      "reply A",
    );
    assert.equal(await controller.select("b"), true);
    assert.equal(controller.state.getState().draft.value.text, "");
    assert.equal(await store.readDraft("chat"), "private A draft");
    assert.equal(await controller.remove("b"), true);
    // Deleting the open chat opens the new chat.
    const opened = controller.state.getState();
    assert.equal(opened.history.activeId, "chat-2");
    assert.deepEqual(opened.history.messages, []);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
