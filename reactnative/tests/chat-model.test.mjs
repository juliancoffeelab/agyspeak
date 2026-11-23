import assert from "node:assert/strict";
import test from "node:test";
import { connect, readLatest } from "./sqlite-helper.mjs";

const said = (text) => ({
  kind: "user",
  text,
  audio: null,
  photos: [],
  postedAt: 1,
});
const wrote = (text, model) => ({
  kind: "reply",
  status: "complete",
  text,
  ending: null,
  providerMessage: null,
  model,
  usage: null,
  maxTokens: null,
  compaction: null,
  postedAt: 1,
  elapsedMillis: null,
});

test("each chat keeps its own model; a new chat starts without one and keeps its choice across restarts", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    const first = await store.readNewChat();
    assert.equal(first.selectedModel, null);
    await store.setSelectedModel(first.id, "alpha");
    await store.writeLog(
      first.id,
      0,
      [said("one"), wrote("ok", "provider/actual")],
      null,
      "alpha",
      1,
    );
    let opened = (await store.activate(first.id)).chat;
    assert.equal(opened.selectedModel, "alpha");
    assert.equal(opened.log.at(-1).model, "provider/actual");
    // The first chat is saved now, so the new chat is another one.
    const second = (await store.activateNew()).chat;
    assert.notEqual(second.id, first.id);
    assert.equal(second.selectedModel, null);
    // A first message fixes the model it was sent with.
    await store.setSelectedModel(second.id, "beta");
    await store.writeLog(second.id, 0, [said("two")], null, "beta-sent", 2);
    opened = (await store.activate(second.id)).chat;
    assert.equal(opened.selectedModel, "beta-sent");
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
