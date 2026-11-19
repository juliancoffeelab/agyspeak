import assert from "node:assert/strict";
import test from "node:test";
import { PersistentDraft } from "../src/features/chat/runtime/PersistentDraft.ts";
import {
  connect,
  coordinator,
  appendTurn,
  savedChats,
} from "./sqlite-helper.mjs";

const settings = { apiKey: "fake-never-sent", model: "test" };
// These drafts hold text only.
const noPhotos = {
  initial: [],
  read: async () => [],
  add: async () => [],
  remove: async () => [],
};

test("typing coalesces saves; explicit flush persists the latest text without trimming", async () => {
  const writes = [];
  const draft = new PersistentDraft(
    1,
    "chat",
    "",
    async (text) => {
      writes.push(text);
    },
    () => assert.fail("write failed"),
    noPhotos,
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
    "chat",
    "original",
    async (text) => {
      writes.push(text);
    },
    () => {},
    noPhotos,
  );
  try {
    draft.edit("original edited");
    const sent = draft.submit(
      () => saving,
      () => {},
      () => {},
      false,
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
    "chat",
    "",
    async (text) => {
      if (fail) throw new Error("disk");
      writes.push(text);
    },
    () => {},
    noPhotos,
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

test("drafts stay isolated per chat, and a draft alone does not make the new chat a saved one", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await appendTurn(store, "existing", "hello", "hi", 1);
  const controller = await coordinator({
    store,
    openAt: null,
    settings: () => settings,
  });
  try {
    const snapshot = controller.state.getState();
    snapshot.draft.edit("New chat draft");
    assert.equal(controller.state.getState(), snapshot);
    await controller.flushDraft();
    assert.deepEqual(
      (await savedChats(store)).map((chat) => chat.id),
      ["existing"],
    );
    assert.equal(await controller.select("existing"), true);
    assert.equal(controller.state.getState().draft.value.text, "");
    controller.state.getState().draft.edit("Existing draft");
    await controller.select(null);
    assert.equal(
      controller.state.getState().draft.value.text,
      "New chat draft",
    );
    await controller.select("existing");
    assert.equal(
      controller.state.getState().draft.value.text,
      "Existing draft",
    );
    await controller.remove("existing");
    assert.equal(await store.readDraft("existing"), "");
    await store.saveDraft("existing", "late");
    assert.equal(await store.readDraft("existing"), "");
    assert.equal(
      controller.state.getState().draft.value.text,
      "New chat draft",
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

// The new chat's first send commits or fails at once, but its result is held
// while a second send is refused and the user keeps typing. The chat keeps
// its id either way, so what is typed meanwhile is saved to it at once and
// survives both outcomes.
for (const kind of ["text", "audio"])
  for (const outcome of ["commit", "rollback"])
    test(`a held first ${kind} send keeps newer typing with its outcome (${outcome})`, async () => {
      const { store, sqlite, failRead } = connect();
      await store.initialize();
      let release;
      const held = new Promise((resolve) => (release = resolve));
      const beginReply = store.beginReply.bind(store);
      store.beginReply = (...args) => {
        if (outcome === "rollback") failRead();
        return beginReply(...args).then(
          async (update) => {
            await held;
            return update;
          },
          async (cause) => {
            await held;
            throw cause;
          },
        );
      };
      const controller = await coordinator({
        store,
        openAt: null,
        settings: () => settings,
      });
      try {
        const draft = controller.state.getState().draft;
        let sending;
        if (kind === "text") {
          draft.edit("message to send");
          await draft.flush();
          sending = draft.submit(
            (text) => controller.send(text, []),
            () => {},
            () => {},
            false,
          );
        } else {
          sending = controller.sendAudio({ data: "UklGRg==", format: "wav" });
        }
        // A second send is refused while the first is held.
        assert.equal(
          await (kind === "text"
            ? controller.send("refused", [])
            : controller.sendAudio({ data: "UklGRg==", format: "wav" })),
          false,
        );
        draft.edit("typed while sending");
        await draft.flush();
        assert.equal(await store.readDraft("chat"), "typed while sending");
        draft.edit("latest");
        release();
        assert.equal(await sending, outcome === "commit");
        await draft.flush();
        assert.equal(
          controller.state.getState().draft,
          draft,
          "the first send does not remount the composer",
        );
        assert.equal(draft.chatId, "chat");
        assert.equal(await store.readDraft("chat"), draft.value.text);
        assert.deepEqual(
          (await savedChats(store)).map((chat) => chat.id),
          outcome === "commit" ? ["chat"] : [],
        );
        if (outcome === "commit") assert.equal(draft.value.text, "latest");
      } finally {
        await controller.dispose();
        sqlite.close();
      }
    });

test("failed message transactions preserve the saved draft, including after snapshot failure", async () => {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  const { id } = await store.readNewChat();
  await store.saveDraft(id, "original");
  const turn = { kind: "text", text: "original", photos: [] };
  failRead();
  await assert.rejects(store.beginReply(id, turn, "test", 1));
  assert.equal(await store.readDraft(id), "original");
  assert.deepEqual(await savedChats(store), []);
  await store.beginReply(id, turn, "test", 1);
  assert.equal(await store.readDraft(id), "");
  assert.deepEqual(
    (await savedChats(store)).map((chat) => chat.id),
    [id],
  );
  sqlite.close();
});

test("audio Send keeps a text draft instead of consuming it", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const controller = await coordinator({
    store,
    openAt: null,
    settings: () => settings,
  });
  try {
    const draft = controller.state.getState().draft;
    draft.edit("text for later");
    await draft.flush();
    await controller.sendAudio({ data: "UklGRg==", format: "wav" });
    assert.deepEqual(
      (await savedChats(store)).map((chat) => chat.id),
      [draft.chatId],
    );
    assert.equal(draft.value.text, "text for later");
    assert.equal(await store.readDraft(draft.chatId), "text for later");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("failed navigation keeps the current composer and its persisted text", async () => {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  const controller = await coordinator({
    store,
    openAt: null,
    settings: () => settings,
  });
  try {
    const draft = controller.state.getState().draft;
    draft.edit("still here");
    failRead();
    assert.equal(await controller.select(null), false);
    assert.ok(controller.state.getState().openFailure.error instanceof Error);
    assert.equal(controller.state.getState().draft, draft);
    assert.equal(draft.suspended, false);
    assert.equal(await store.readDraft(draft.chatId), "still here");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a draft whose save fails is kept across navigation and reused on return", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await appendTurn(store, "existing", "hello", "hi", 1);
  const controller = await coordinator({
    store,
    openAt: null,
    settings: () => settings,
  });
  const save = store.saveDraft.bind(store);
  try {
    const draft = controller.state.getState().draft;
    draft.edit("unsaved scratch");
    store.saveDraft = async () => {
      throw new Error("disk");
    };
    assert.equal(await controller.select("existing"), true);
    let state = controller.state.getState();
    assert.match(state.error, /typing in that chat/);
    assert.equal(state.history.activeId, "existing");
    store.saveDraft = save;
    assert.equal(await controller.select(null), true);
    state = controller.state.getState();
    assert.equal(state.draft, draft, "returning reuses the kept draft");
    assert.equal(state.draft.value.text, "unsaved scratch");
    state.draft.edit("unsaved scratch, edited");
    await controller.flushDraft();
    assert.equal(
      await store.readDraft(draft.chatId),
      "unsaved scratch, edited",
    );
  } finally {
    store.saveDraft = save;
    await controller.dispose();
    sqlite.close();
  }
});
