import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "./sqlite-helper.mjs";
import { requestMessages, validatePhotos } from "../src/chat/openRouter.ts";
import { contextHasPhotos, selectContext } from "../src/chat/context.ts";
import { imageInputIssue } from "../src/chat/audioCapability.ts";
import { parseModels } from "../src/chat/routerMetadata.ts";
import { ChatController } from "../src/chat/ChatController.ts";

const photo = { data: "/9j/", thumbnail: "/9j/", width: 100, height: 80 };
const settings = { apiKey: "test-key", model: "text" };

test("photos and captions persist atomically, load lazily for requests, and are deleted with chat", async () => {
  const { store, sqlite, queries } = connect();
  try {
    await store.initialize();
    await store.saveDraft(null, "caption");
    const saved = await store.beginReply(
      "photos",
      "caption",
      "vision",
      1,
      undefined,
      [photo, photo],
    );
    assert.equal(await store.readDraft("photos"), "");
    assert.equal(saved.messages[0].photos.length, 2);
    assert.equal(saved.messages[0].photos[0].data, undefined);
    assert.equal(
      queries.some((q) => /SELECT id, data FROM photos/.test(q.sql)),
      false,
    );
    const context = await store.readContext("photos");
    assert.deepEqual(context[0].photos, [photo, photo]);
    assert.deepEqual(requestMessages(context), [
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
    await store.remove("photos");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM photos").get().n, 0);
  } finally {
    sqlite.close();
  }
});

test("version-six upgrade preserves existing messages and drafts", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await store.beginReply("old", "existing message", "text", 1);
    await store.saveDraft("old", "existing draft");
    sqlite.exec(
      "DROP TABLE draft_photos; DROP TABLE photos; PRAGMA user_version = 6",
    );
    await store.initialize();
    assert.equal((await store.read()).messages[0].text, "existing message");
    assert.equal(await store.readDraft("old"), "existing draft");
    assert.equal(sqlite.prepare("PRAGMA user_version").get().user_version, 8);
  } finally {
    sqlite.close();
  }
});

test("photo storage rolls back together with a failed message snapshot", async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    await store.saveDraft(null, "keep me");
    failRead();
    await assert.rejects(
      store.beginReply("failed", "caption", "vision", 1, undefined, [photo]),
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM photos").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM chats").get().n, 0);
    assert.equal(await store.readDraft(null), "keep me");
  } finally {
    sqlite.close();
  }
});

test("image-only turns are included and images share the bounded media budget", () => {
  const image = { role: "user", status: "complete", text: "", photos: [photo] };
  assert.equal(contextHasPhotos([image], ""), true);
  assert.equal(requestMessages([image])[0].content.length, 1);
  const bigAudio = {
    role: "user",
    status: "complete",
    text: "",
    audio: { encodedLength: 16 * 1024 * 1024, format: "wav" },
  };
  assert.deepEqual(selectContext([bigAudio, image]), [image]);
  assert.equal(
    contextHasPhotos(
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
        architecture: { input_modalities: ["text", "image"] },
      },
      {
        id: "text",
        name: "Text",
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
  let calls = 0;
  const controller = new ChatController(
    store,
    await store.read(),
    async () => {
      calls++;
      return { text: "reply", model: "vision", cost: 0 };
    },
    () => "chat",
    "draft",
    () => null,
    (model) => (model === "vision" ? null : "No image support"),
  );
  try {
    const draft = controller.getSnapshot().draft;
    assert.equal(await controller.send("caption", settings, [photo]), false);
    assert.equal(controller.getSnapshot().history.messages.length, 0);
    assert.equal(draft.value.text, "draft");
    assert.equal(
      await controller.send("", { ...settings, model: "vision" }, [photo]),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.equal(await controller.send("follow-up", settings), false);
    assert.equal(calls, 1);
    assert.equal(controller.getSnapshot().history.messages.length, 2);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("photo retry keeps the original attachment and blocks incompatible models before mutation", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const pending = await store.beginReply(
    "chat",
    "caption",
    "vision",
    1,
    undefined,
    [photo],
  );
  const replyId = pending.messages.at(-1).id;
  await store.finishReply(replyId, "failed", "", "offline");
  let received;
  const controller = new ChatController(
    store,
    await store.read(),
    async (messages) => {
      received = messages;
      return { text: "ok", model: "vision", cost: 0 };
    },
    () => "unused",
    "",
    () => null,
    (model) => (model === "vision" ? null : "No image support"),
  );
  try {
    assert.equal(await controller.retryReply(replyId, settings), false);
    assert.equal((await store.read()).messages.at(-1).status, "failed");
    assert.equal(received, undefined);
    assert.equal(
      await controller.retryReply(replyId, { ...settings, model: "vision" }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received[0].photos, [photo]);
    assert.equal((await store.read()).messages.length, 2);
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
  const controller = new ChatController(
    store,
    await store.read(),
    async () => {
      calls++;
      return { text: "unexpected", model: "vision", cost: 0 };
    },
    () => "race",
    "",
    () => null,
    () => (allowed ? null : "Images unavailable"),
  );
  try {
    assert.equal(
      await controller.send("", { ...settings, model: "vision" }, [photo]),
      true,
    );
    allowed = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 0);
    const saved = await store.read();
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
    await connection.store.saveDraft(null, "caption");
    const metadata = await connection.store.addPhotoDraft(null, [photo]);
    assert.equal(metadata[0].data, undefined);
    connection.sqlite.close();
    connection = connect(join(dir, "drafts.db"));
    const { store } = connection;
    await store.initialize();
    assert.equal(await store.readDraft(null), "caption");
    assert.deepEqual(await store.readPhotoDraftData(null), [photo]);
    await store.beginReply("other", "other chat", "vision", 1, {
      data: "UklGRg==",
      format: "wav",
    });
    assert.deepEqual(await store.readPhotoDraftData(null), []);
    assert.deepEqual(await store.readPhotoDraftData("other"), [photo]);
    await store.addPhotoDraft(null, [{ ...photo, width: 200 }]);
    assert.equal((await store.readPhotoDraft(null))[0].width, 200);
    assert.equal((await store.readPhotoDraft("other"))[0].width, 100);
    const saved = await store.beginReply(
      "scratch",
      "caption",
      "vision",
      2,
      undefined,
      await store.readPhotoDraftData(null),
    );
    assert.equal(saved.messages[0].photos.length, 1);
    assert.equal((await store.readPhotoDraft("scratch")).length, 0);
    assert.equal((await store.readPhotoDraftData("other")).length, 1);
    await store.remove("other");
    assert.equal((await store.readPhotoDraft("other")).length, 0);
    await assert.rejects(
      store.addPhotoDraft("other", [photo]),
      /no longer exists/,
    );
  } finally {
    connection.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("draft photo add/remove and send roll back without losing attachments", async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    failRead();
    await assert.rejects(store.addPhotoDraft(null, [photo]));
    assert.equal((await store.readPhotoDraft(null)).length, 0);
    const [saved] = await store.addPhotoDraft(null, [photo]);
    failRead();
    await assert.rejects(store.removePhotoDraft(null, saved.id));
    assert.equal((await store.readPhotoDraft(null)).length, 1);
    failRead();
    await assert.rejects(
      store.beginReply("fail", "", "vision", 1, undefined, [photo]),
    );
    assert.deepEqual(await store.readPhotoDraftData(null), [photo]);
    assert.deepEqual(
      await store.readPhoto({ id: saved.id, draft: true }),
      photo,
    );
    await store.removePhotoDraft(null, saved.id);
    assert.equal((await store.readPhotoDraft(null)).length, 0);
  } finally {
    sqlite.close();
  }
});

test("controller restores photo draft metadata on chat switch without publishing history on attachment edits", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const controller = new ChatController(
    store,
    await store.read(),
    () => new Promise(() => {}),
    () => "chat",
    "",
    () => null,
    () => null,
  );
  try {
    const snapshot = controller.getSnapshot(),
      draft = snapshot.draft;
    await draft.addPhotos([photo]);
    assert.equal(controller.getSnapshot(), snapshot);
    assert.equal(draft.getPhotos().length, 1);
    await controller.select(null);
    assert.equal(controller.getSnapshot().draft.getPhotos().length, 1);
    const restored = controller.getSnapshot().draft;
    const photos = await restored.readPhotos();
    assert.equal(
      await restored.submit(
        (text) =>
          controller.send(text, { ...settings, model: "vision" }, photos),
        () => {},
        () => {},
        true,
      ),
      true,
    );
    assert.equal(restored.getPhotos().length, 0);
    assert.equal((await store.readPhotoDraft("chat")).length, 0);
    const message = controller.getSnapshot().history.messages[0];
    assert.deepEqual(
      await controller.readPhoto({ id: message.photos[0].id, draft: false }),
      photo,
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
