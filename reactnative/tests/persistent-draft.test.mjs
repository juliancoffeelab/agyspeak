import assert from "node:assert/strict";
import test from "node:test";
import { PersistentDraft } from "../src/chat/PersistentDraft.ts";
import { ChatController } from "../src/chat/ChatController.ts";
import { connect, appendTurn } from "./sqlite-helper.mjs";

const settings = { apiKey: "fake-never-sent", model: "test" };

test("typing coalesces saves; explicit flush persists the latest text without trimming", async () => {
  const writes = [];
  const draft = new PersistentDraft(
    1,
    null,
    "",
    async (text) => {
      writes.push(text);
    },
    () => assert.fail("write failed"),
  );
  try {
    draft.edit("a");
    draft.edit("ab");
    draft.edit("  ab\n");
    assert.deepEqual(writes, []);
    await new Promise((resolve) => setTimeout(resolve, 430));
    assert.deepEqual(writes, ["  ab\n"]);
    draft.edit("latest");
    await draft.flush();
    assert.deepEqual(writes, ["  ab\n", "latest"]);
    await new Promise((resolve) => setTimeout(resolve, 410));
    assert.equal(writes.length, 2, "flush cancels the pending timer");
  } finally {
    draft.close();
  }
});

test("background flush cannot persist the optimistic Send clear before the message is saved", async () => {
  const writes = [];
  let finish;
  const saving = new Promise((resolve) => {
    finish = resolve;
  });
  const draft = new PersistentDraft(
    1,
    null,
    "original",
    async (text) => {
      writes.push(text);
    },
    () => {},
  );
  try {
    draft.edit("original edited");
    const sent = draft.submit(
      () => saving,
      () => {},
      () => {},
    );
    await draft.flush();
    assert.deepEqual(writes, []);
    finish(false);
    await sent;
    assert.equal(draft.value.text, "original edited");
    assert.deepEqual(writes, ["original edited"]);
  } finally {
    draft.close();
  }
});

test("failed writes retain a dirty draft for retry; closed sessions cannot write late", async () => {
  let fail = true;
  const writes = [];
  const draft = new PersistentDraft(
    1,
    null,
    "",
    async (text) => {
      if (fail) throw new Error("disk");
      writes.push(text);
    },
    () => {},
  );
  draft.edit("kept");
  await assert.rejects(draft.flush(), /disk/);
  fail = false;
  await draft.flush();
  draft.close();
  draft.edit("late");
  await draft.flush();
  assert.deepEqual(writes, ["kept"]);
});

test("drafts stay isolated per conversation and the new-chat slot without creating chats", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await appendTurn(store, "existing", "hello", "hi", 1);
  await store.select(null);
  let next = 0;
  const history = await store.read();
  const controller = new ChatController(
    store,
    history,
    () => new Promise(() => {}),
    () => `chat-${++next}`,
    await store.readDraft(history.activeId),
  );
  try {
    const snapshot = controller.getSnapshot();
    snapshot.draft.edit("New chat draft");
    assert.equal(controller.getSnapshot(), snapshot);
    await controller.flushDraft();
    assert.equal((await store.read()).chats.length, 1);
    assert.equal(await controller.select("existing"), true);
    assert.equal(controller.getSnapshot().draft.initialText, "");
    controller.getSnapshot().draft.edit("Existing draft");
    await controller.select(null);
    assert.equal(controller.getSnapshot().draft.initialText, "New chat draft");
    await controller.select("existing");
    assert.equal(controller.getSnapshot().draft.initialText, "Existing draft");
    await controller.remove("existing");
    assert.equal(await store.readDraft("existing"), "");
    await store.saveDraft("existing", "late");
    assert.equal(await store.readDraft("existing"), "");
    assert.equal(controller.getSnapshot().draft.initialText, "New chat draft");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("successful Send consumes its draft atomically and preserves typing during the save", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const controller = new ChatController(
    store,
    await store.read(),
    () => new Promise(() => {}),
    () => "created",
    "",
  );
  try {
    const draft = controller.getSnapshot().draft;
    draft.edit("message to send");
    await draft.flush();
    const sending = draft.submit(
      (text) => controller.send(text, settings),
      () => {},
      () => {},
    );
    draft.edit("next message");
    assert.equal(await sending, true);
    assert.equal(
      controller.getSnapshot().draft,
      draft,
      "first Send does not remount the composer",
    );
    assert.equal(draft.chatId, "created");
    assert.equal(await store.readDraft(null), "");
    assert.equal(await store.readDraft("created"), "next message");
    assert.equal((await store.read()).messages[0].text, "message to send");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("failed message transactions preserve the saved draft, including after snapshot failure", async () => {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  await store.saveDraft(null, "original");
  failRead();
  await assert.rejects(store.beginReply("new", "original", "test", 1));
  assert.equal(await store.readDraft(null), "original");
  assert.equal(await store.readDraft("new"), "");
  assert.deepEqual((await store.read()).chats, []);
  const accepted = await store.beginReply("new", "original", "test", 1);
  assert.equal(await store.readDraft(null), "");
  assert.equal(await store.readDraft(accepted.activeId), "");
  sqlite.close();
});

test("audio Send transfers and preserves a text draft instead of consuming it", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const controller = new ChatController(
    store,
    await store.read(),
    () => new Promise(() => {}),
    () => "audio-chat",
    "",
  );
  try {
    const draft = controller.getSnapshot().draft;
    draft.edit("text for later");
    await draft.flush();
    await controller.sendAudio({ data: "UklGRg==", format: "wav" }, settings);
    assert.equal(draft.chatId, "audio-chat");
    assert.equal(draft.value.text, "text for later");
    assert.equal(await store.readDraft("audio-chat"), "text for later");
    assert.equal(await store.readDraft(null), "");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("failed navigation keeps the current composer and its persisted text", async () => {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  const controller = new ChatController(
    store,
    await store.read(),
    () => new Promise(() => {}),
    () => "new",
    "",
  );
  try {
    const draft = controller.getSnapshot().draft;
    draft.edit("still here");
    failRead();
    assert.equal(await controller.select(null), false);
    assert.equal(controller.getSnapshot().draft, draft);
    assert.equal(draft.suspended, false);
    assert.equal(await store.readDraft(null), "still here");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
