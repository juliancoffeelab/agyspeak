import assert from "node:assert/strict";
import test from "node:test";
import {
  connect,
  coordinator,
  latestId,
  readLatest,
  savedChats,
} from "./sqlite-helper.mjs";
import { requestMessages } from "../src/providers/openrouter/transport.ts";
import { validatePhotos } from "../src/features/chat/runtime/inputLimits.ts";
import {
  selectContext,
  toProviderContext,
} from "../src/features/chat/runtime/context.ts";
import {
  imageInputIssue,
  inputIssue,
} from "../src/features/chat/runtime/capability.ts";
import { parseModels } from "../src/providers/openrouter/metadata.ts";

// Usage a mocked reply reports: none.
const MOCK_USAGE = {
  costUSD: null,
  promptTokens: null,
  completionTokens: null,
  cachedPromptTokens: null,
  cacheWritePromptTokens: null,
};
const photo = { data: "/9j/", thumbnail: "/9j/", width: 100, height: 80 };
let settings = { apiKey: "test-key", model: "text" };
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

test("photos and captions persist atomically, load lazily for requests, and are deleted with chat", async () => {
  const { store, sqlite, queries } = connect();
  try {
    await store.initialize();
    const { id } = await store.readNewChat();
    await store.saveDraft(id, "caption");
    const saved = await store.beginReply(
      id,
      { kind: "text", text: "caption", photos: [photo, photo] },
      "vision",
      1,
    );
    assert.equal(await store.readDraft(id), "");
    assert.equal(saved.chat.messages[0].photos.length, 2);
    assert.equal(saved.chat.messages[0].photos[0].data, undefined);
    assert.equal(
      queries.some((q) => /SELECT id, data FROM photos/.test(q.sql)),
      false,
    );
    const context = await store.readContext(id);
    assert.deepEqual(context[0].photos, [photo, photo]);
    assert.deepEqual(requestMessages(toProviderContext(context)), [
      {
        role: "user",
        content: [
          { type: "text", text: "caption" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/" },
          },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/" },
          },
        ],
      },
    ]);
    await store.remove(id);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM photos").get().n, 0);
  } finally {
    sqlite.close();
  }
});

test("photo storage rolls back together with a failed message snapshot", async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    const { id } = await store.readNewChat();
    await store.saveDraft(id, "keep me");
    failRead();
    await assert.rejects(
      store.beginReply(
        id,
        { kind: "text", text: "caption", photos: [photo] },
        "vision",
        1,
      ),
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM photos").get().n, 0);
    assert.deepEqual(await savedChats(store), []);
    assert.equal(await store.readDraft(id), "keep me");
  } finally {
    sqlite.close();
  }
});

test("image-only turns are included and images share the bounded media budget", () => {
  const image = { role: "user", status: "complete", text: "", photos: [photo] };
  const needsImages = (messages, draft) =>
    inputIssue(
      messages,
      { kind: "text", text: draft, photos: [] },
      { audio: null, image: "no images" },
    ) === "no images";
  assert.equal(needsImages([image], ""), true);
  assert.equal(
    requestMessages(toProviderContext([image]))[0].content.length,
    1,
  );
  const bigAudio = {
    role: "user",
    status: "complete",
    text: "",
    audio: { encodedLength: 16 * 1024 * 1024, format: "wav" },
  };
  assert.deepEqual(selectContext([bigAudio, image]), [image]);
  assert.equal(
    needsImages(
      [image, { role: "user", status: "complete", text: "x".repeat(24000) }],
      "x",
    ),
    false,
  );
});

test("photo validation rejects excessive counts, bytes and invalid metadata", () => {
  validatePhotos([photo]);
  for (const input of [
    [],
    Array(5).fill(photo),
    [{ ...photo, width: 0 }],
    [{ ...photo, data: "bad!" }],
    [{ ...photo, data: "a".repeat(12 * 1024 * 1024) }],
  ]) {
    assert.throws(() => validatePhotos(input));
  }
});

test("catalog distinguishes image-capable models and unknown metadata", () => {
  const models = parseModels({
    data: [
      {
        id: "vision",
        name: "Vision",
        endpoints: ["/api/v1/chat/completions"],
        architecture: { input_modalities: ["text", "image"] },
      },
      {
        id: "text",
        name: "Text",
        endpoints: ["/api/v1/chat/completions"],
        architecture: { input_modalities: ["text"] },
      },
    ],
  });
  assert.equal(imageInputIssue("vision", models), null);
  assert.match(imageInputIssue("text", models), /doesn’t support image/);
  assert.match(imageInputIssue("unknown", models), /verify photo support/);
});

test("unsupported photo sends and follow-ups preserve drafts without inference", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await store.saveDraft((await store.readNewChat()).id, "draft");
  let calls = 0;
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: async () => {
      calls++;
      return {
        text: "reply",
        model: "vision",
        usage: MOCK_USAGE,
        stopped: null,
      };
    },
    imageIssue: (model) => (model === "vision" ? null : "No image support"),
    settings: () => settings,
  });
  try {
    const draft = controller.state.getState().draft;
    assert.equal(await controller.send("caption", [photo]), false);
    assert.equal(controller.state.getState().history.messages.length, 0);
    assert.equal(draft.value.text, "draft");
    assert.equal(
      await withSettings({ model: "vision" }, () =>
        controller.send("", [photo]),
      ),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    await controller.chooseModel("text");
    assert.equal(await controller.send("follow-up", []), false);
    assert.equal(calls, 1);
    assert.equal(controller.state.getState().history.messages.length, 2);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("photo retry keeps the original attachment and blocks incompatible models before mutation", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await store.seedChat("chat");
  const pending = await store.beginReply(
    "chat",
    { kind: "text", text: "caption", photos: [photo] },
    "vision",
    1,
  );
  const replyId = pending.replyId;
  await store.finishReply(replyId, {
    status: "failed",
    text: "",
    error: "offline",
    model: null,
    elapsedMillis: null,
  });
  let received;
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: async (messages) => {
      received = messages;
      return { text: "ok", model: "vision", usage: MOCK_USAGE, stopped: null };
    },
    imageIssue: (model) => (model === "vision" ? null : "No image support"),
    settings: () => settings,
  });
  try {
    await controller.chooseModel("text");
    assert.equal(await controller.retryReply(replyId), false);
    assert.equal((await readLatest(store)).messages.at(-1).status, "failed");
    assert.equal(received, undefined);
    await controller.chooseModel("vision");
    assert.equal(
      await withSettings({ model: "vision" }, () =>
        controller.retryReply(replyId),
      ),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received[0].photos, [{ data: photo.data }]);
    assert.equal((await readLatest(store)).messages.length, 2);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("actual image context is checked again before calling inference", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  let allowed = true,
    calls = 0;
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: async () => {
      calls++;
      return {
        text: "unexpected",
        model: "vision",
        usage: MOCK_USAGE,
        stopped: null,
      };
    },
    imageIssue: () => (allowed ? null : "Images unavailable"),
    settings: () => settings,
  });
  try {
    assert.equal(
      await withSettings({ model: "vision" }, () =>
        controller.send("", [photo]),
      ),
      true,
    );
    allowed = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 0);
    const saved = await readLatest(store);
    assert.equal(saved.messages.at(-1).status, "failed");
    assert.equal(saved.messages[0].photos.length, 1);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("photo drafts survive reopening, remain isolated per chat, and consume with the sent turn", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "agyspeak-photos-"));
  let connection = connect(join(dir, "drafts.db"));
  try {
    await connection.store.initialize();
    const { id } = await connection.store.readNewChat();
    await connection.store.saveDraft(id, "caption");
    const metadata = await connection.store.addPhotoDraft(id, [photo]);
    assert.equal(metadata[0].data, undefined);
    connection.sqlite.close();
    connection = connect(join(dir, "drafts.db"));
    const { store } = connection;
    await store.initialize();
    assert.deepEqual(await store.readNewChat(), {
      id,
      selectedModel: null,
      draft: { text: "caption", photos: metadata },
    });
    assert.deepEqual(await store.readPhotoDraftData(id), [photo]);
    // A voice message saves the chat and leaves its draft with it.
    await store.beginReply(
      id,
      { kind: "audio", audio: { data: "UklGRg==", format: "wav" } },
      "vision",
      1,
    );
    assert.deepEqual(await store.readPhotoDraftData(id), [photo]);
    // The next new chat starts empty and keeps its own photos.
    const fresh = (await store.activateNew()).chat.id;
    assert.notEqual(fresh, id);
    assert.deepEqual(await store.readPhotoDraftData(fresh), []);
    await store.addPhotoDraft(fresh, [{ ...photo, width: 200 }]);
    assert.equal((await store.readPhotoDraft(fresh))[0].width, 200);
    assert.equal((await store.readPhotoDraft(id))[0].width, 100);
    const saved = await store.beginReply(
      fresh,
      {
        kind: "text",
        text: "caption",
        photos: await store.readPhotoDraftData(fresh),
      },
      "vision",
      2,
    );
    assert.equal(saved.chat.messages[0].photos.length, 1);
    assert.equal((await store.readPhotoDraft(fresh)).length, 0);
    assert.equal((await store.readPhotoDraftData(id)).length, 1);
    await store.remove(id);
    assert.equal((await store.readPhotoDraft(id)).length, 0);
    await assert.rejects(store.addPhotoDraft(id, [photo]), /no longer exists/);
  } finally {
    connection.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("draft photo add/remove and send roll back without losing attachments", async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    const { id } = await store.readNewChat();
    failRead();
    await assert.rejects(store.addPhotoDraft(id, [photo]));
    assert.equal((await store.readPhotoDraft(id)).length, 0);
    const [saved] = await store.addPhotoDraft(id, [photo]);
    failRead();
    await assert.rejects(store.removePhotoDraft(id, saved.id));
    assert.equal((await store.readPhotoDraft(id)).length, 1);
    failRead();
    await assert.rejects(
      store.beginReply(
        id,
        { kind: "text", text: "", photos: [photo] },
        "vision",
        1,
      ),
    );
    assert.deepEqual(await store.readPhotoDraftData(id), [photo]);
    assert.deepEqual(
      await store.readPhoto({ id: saved.id, draft: true }),
      photo,
    );
    await store.removePhotoDraft(id, saved.id);
    assert.equal((await store.readPhotoDraft(id)).length, 0);
  } finally {
    sqlite.close();
  }
});

test("controller restores photo draft metadata on chat switch without publishing history on attachment edits", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    settings: () => settings,
  });
  try {
    const snapshot = controller.state.getState(),
      draft = snapshot.draft;
    await draft.addPhotos([photo]);
    assert.equal(controller.state.getState(), snapshot);
    assert.equal(draft.getPhotos().length, 1);
    await controller.select(null);
    assert.equal(controller.state.getState().draft.getPhotos().length, 1);
    const restored = controller.state.getState().draft;
    const photos = await restored.readPhotos();
    assert.equal(
      await restored.submit(
        (text) =>
          withSettings({ model: "vision" }, () =>
            controller.send(text, photos),
          ),
        () => {},
        () => {},
        true,
      ),
      true,
    );
    assert.equal(restored.getPhotos().length, 0);
    assert.equal((await store.readPhotoDraft("chat")).length, 0);
    const message = controller.state.getState().history.messages[0];
    assert.deepEqual(
      await controller.readPhoto({ id: message.photos[0].id, draft: false }),
      photo,
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
