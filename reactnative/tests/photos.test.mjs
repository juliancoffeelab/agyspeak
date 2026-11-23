import assert from "node:assert/strict";
import test from "node:test";
import {
  connect,
  openChat,
  readLatest,
  replies,
  savedChats,
  startAt,
  tick,
  workspace,
} from "./sqlite-helper.mjs";
import { requestMessages } from "../src/providers/openrouter/transport.ts";
import { validatePhotos } from "../src/features/chat/runtime/inputLimits.ts";
import {
  RECORDING_LEFT_OUT,
  replyRequest,
} from "../src/features/chat/runtime/log.ts";
import { providerMessages } from "../src/features/chat/runtime/chatRuntime.ts";
import {
  imageInputIssue,
  requestIssue,
} from "../src/features/chat/runtime/capability.ts";
import { parseModels } from "../src/providers/openrouter/metadata.ts";

const MOCK_JPEG_PHOTO = {
  data: "/9j/",
  thumbnail: "/9j/",
  width: 100,
  height: 80,
};
const imageIssue = (model) => (model === "vision" ? null : "No image support");
// A workspace on the new chat, its photos taken by "vision" only.
async function setup() {
  const { store, sqlite, failRead, queries } = connect();
  await store.initialize();
  const port = replies();
  const controller = await workspace({
    store,
    openAt: null,
    reply: port.reply,
    models: { imageIssue },
  });
  return { store, sqlite, failRead, queries, controller, ...port };
}
// Sends `text` with the draft's photos, as the composer does.
async function sendWithPhotos(controller, text) {
  const draft = controller.state.getState().draft;
  const photos = await draft.readPhotos();
  return draft.submit(
    () => controller.send(text, photos),
    () => {},
    () => {},
    true,
  );
}

test("photos are saved for their message, which names them; a request reads them, and they go with the chat", async () => {
  const { store, sqlite, queries, controller, requests } = await setup();
  try {
    await controller.chooseModel("vision");
    await controller.state
      .getState()
      .draft.addPhotos([MOCK_JPEG_PHOTO, MOCK_JPEG_PHOTO]);
    assert.equal(await sendWithPhotos(controller, "caption"), "saved");
    await tick();
    const [message] = (await startAt(store, "chat")).log;
    assert.equal(message.photos.length, 2);
    assert.equal(message.photos[0].data, undefined);
    assert.equal((await store.readPhotoDraft("chat")).length, 0);
    assert.ok(
      !queries.some((q) => /SELECT data FROM media/.test(q.sql)),
      "opening a chat never reads photo bytes",
    );
    assert.deepEqual(requestMessages(requests[0].messages), [
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
    assert.deepEqual(
      await controller.readPhoto({ draft: false, ...message.photos[0] }),
      MOCK_JPEG_PHOTO,
    );
    await controller.remove("chat");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("photos that fail to be saved for a message stay in the draft, and nothing is sent", async () => {
  const { store, sqlite, failRead, controller, requests } = await setup();
  try {
    await controller.chooseModel("vision");
    const draft = controller.state.getState().draft;
    await draft.addPhotos([MOCK_JPEG_PHOTO]);
    draft.edit("keep me");
    await draft.flush();
    const photos = await draft.readPhotos();
    failRead();
    assert.equal(await controller.send("keep me", photos), "refused");
    await tick();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
    assert.deepEqual(await savedChats(store), []);
    assert.equal(draft.value.text, "keep me");
    assert.equal(draft.getPhotos().length, 1);
    assert.equal(requests.length, 0);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("image-only messages are sent and photos share the bounded media budget", async () => {
  const ref = (key, encodedLength) => ({
    key,
    width: 1,
    height: 1,
    encodedLength,
  });
  const said = (text, media = {}) => ({
    kind: "user",
    text,
    audio: null,
    photos: [],
    postedAt: null,
    ...media,
  });
  const image = said("", { photos: [ref("1", 4)] });
  const needsImages = (log) =>
    requestIssue(replyRequest(log), { audio: null, image: "no images" })
      ?.reason === "no images";
  assert.equal(needsImages([image]), true);
  const sent = requestMessages(
    await providerMessages(
      replyRequest([image]),
      async (keys) => new Map(keys.map((key) => [key, "/9j/"])),
    ),
  );
  assert.equal(sent[0].content.length, 1);
  const bigAudio = said("", {
    audio: {
      key: "2",
      format: "wav",
      encodedLength: 16 * 1024 * 1024,
      durationMillis: null,
      levels: null,
    },
  });
  // Older media past the budget is replaced in its message, which stays.
  const [replaced, kept] = replyRequest([bigAudio, image]);
  assert.deepEqual(kept, { role: "user", text: "", photos: image.photos });
  assert.equal(replaced.audio, undefined);
  assert.equal(replaced.text, RECORDING_LEFT_OUT);
  // Text has no budget: a photo stays in the request behind any amount.
  assert.equal(needsImages([image, said("x".repeat(24000)), said("x")]), true);
});

test("photo validation rejects excessive counts, bytes and invalid metadata", () => {
  validatePhotos([MOCK_JPEG_PHOTO]);
  for (const input of [
    [],
    Array(5).fill(MOCK_JPEG_PHOTO),
    [{ ...MOCK_JPEG_PHOTO, width: 0 }],
    [{ ...MOCK_JPEG_PHOTO, data: "bad!" }],
    [{ ...MOCK_JPEG_PHOTO, data: "a".repeat(12 * 1024 * 1024) }],
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

test("photo sends a model can't take are refused with the draft kept; once photos are in the chat, so are follow-ups", async () => {
  const { store, sqlite, controller, requests } = await setup();
  try {
    await controller.chooseModel("text");
    const draft = controller.state.getState().draft;
    draft.edit("draft");
    await draft.addPhotos([MOCK_JPEG_PHOTO]);
    assert.equal(
      await controller.send("caption", [MOCK_JPEG_PHOTO]),
      "refused",
    );
    assert.equal(controller.state.getState().error, "No image support");
    assert.deepEqual(openChat(controller).log, []);
    assert.equal(draft.value.text, "draft");
    assert.equal(draft.getPhotos().length, 1);
    await controller.chooseModel("vision");
    assert.equal(await sendWithPhotos(controller, ""), "saved");
    await tick();
    requests[0].answer("reply");
    await tick();
    await controller.chooseModel("text");
    assert.equal(await controller.send("follow-up", []), "refused");
    assert.equal(requests.length, 1);
    assert.equal((await readLatest(store)).log.length, 2);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a photo message's retry keeps its photos, and is refused on a model that can't take them", async () => {
  const { store, sqlite, controller, requests } = await setup();
  try {
    await controller.chooseModel("vision");
    await controller.state.getState().draft.addPhotos([MOCK_JPEG_PHOTO]);
    await sendWithPhotos(controller, "caption");
    await tick();
    requests[0].fail(new Error("offline"));
    await tick();
    await controller.chooseModel("text");
    assert.equal(controller.command({ kind: "retry" }), "No image support");
    assert.equal((await readLatest(store)).log.at(-1).status, "failed");
    assert.equal(requests.length, 1);
    await controller.chooseModel("vision");
    assert.equal(controller.command({ kind: "retry" }), null);
    await tick();
    assert.deepEqual(requests[1].messages[0].photos, [
      { data: MOCK_JPEG_PHOTO.data },
    ]);
    assert.equal((await readLatest(store)).log.length, 1);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("photo drafts survive reopening, stay with their chat, and go with it", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "agyspeak-photos-"));
  let connection = connect(join(dir, "drafts.db"));
  try {
    await connection.store.initialize();
    const { id } = await connection.store.readNewChat();
    await connection.store.saveDraft(id, "caption");
    const metadata = await connection.store.addPhotoDraft(id, [
      MOCK_JPEG_PHOTO,
    ]);
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
    assert.deepEqual(await store.readPhotoDraftData(id), [MOCK_JPEG_PHOTO]);
    // A voice message saves the chat and leaves its draft with it.
    const key = await store.addRecording(id, "UklGRg==");
    await store.writeLog(
      id,
      0,
      [
        {
          kind: "user",
          text: "",
          audio: {
            key,
            format: "wav",
            encodedLength: 8,
            durationMillis: null,
            levels: null,
          },
          photos: [],
          postedAt: 1,
        },
      ],
      null,
      "vision",
      1,
    );
    assert.deepEqual(await store.readPhotoDraftData(id), [MOCK_JPEG_PHOTO]);
    // The next new chat starts empty and keeps its own photos.
    const fresh = (await store.activateNew()).chat.id;
    assert.notEqual(fresh, id);
    assert.deepEqual(await store.readPhotoDraftData(fresh), []);
    await store.addPhotoDraft(fresh, [{ ...MOCK_JPEG_PHOTO, width: 200 }]);
    assert.equal((await store.readPhotoDraft(fresh))[0].width, 200);
    assert.equal((await store.readPhotoDraft(id))[0].width, 100);
    await store.remove(id);
    assert.equal((await store.readPhotoDraft(id)).length, 0);
    await assert.rejects(
      store.addPhotoDraft(id, [MOCK_JPEG_PHOTO]),
      /no longer exists/,
    );
  } finally {
    connection.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("draft photo add/remove and staging roll back without losing attachments", async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    const { id } = await store.readNewChat();
    failRead();
    await assert.rejects(store.addPhotoDraft(id, [MOCK_JPEG_PHOTO]));
    assert.equal((await store.readPhotoDraft(id)).length, 0);
    const [saved] = await store.addPhotoDraft(id, [MOCK_JPEG_PHOTO]);
    failRead();
    await assert.rejects(store.removePhotoDraft(id, saved.id));
    assert.equal((await store.readPhotoDraft(id)).length, 1);
    failRead();
    await assert.rejects(store.stagePhotoDraft(id));
    assert.deepEqual(await store.readPhotoDraftData(id), [MOCK_JPEG_PHOTO]);
    assert.deepEqual(
      await store.readPhoto({ id: saved.id, draft: true }),
      MOCK_JPEG_PHOTO,
    );
    await store.removePhotoDraft(id, saved.id);
    assert.equal((await store.readPhotoDraft(id)).length, 0);
  } finally {
    sqlite.close();
  }
});

test("the workspace restores a photo draft on chat switch without publishing on attachment edits", async () => {
  const { store, sqlite, controller } = await setup();
  try {
    await controller.chooseModel("vision");
    const snapshot = controller.state.getState(),
      draft = snapshot.draft;
    await draft.addPhotos([MOCK_JPEG_PHOTO]);
    assert.equal(controller.state.getState(), snapshot);
    assert.equal(draft.getPhotos().length, 1);
    await controller.select(null);
    const restored = controller.state.getState().draft;
    assert.notEqual(restored, draft);
    assert.equal(restored.getPhotos().length, 1);
    assert.equal(await sendWithPhotos(controller, ""), "saved");
    assert.equal(restored.getPhotos().length, 0);
    await tick();
    assert.equal((await store.readPhotoDraft("chat")).length, 0);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a discarded message goes back to an empty draft with its photos; what was typed since is kept instead", async () => {
  const { store, sqlite, controller, requests } = await setup();
  const draftPhotos = () =>
    sqlite.prepare("SELECT COUNT(*) AS n FROM draft_photos").get().n;
  try {
    await controller.chooseModel("vision");
    const draft = controller.state.getState().draft;
    await draft.addPhotos([MOCK_JPEG_PHOTO]);
    draft.edit("caption");
    assert.equal(await sendWithPhotos(controller, "caption"), "saved");
    await tick();
    assert.equal(draft.value.text, "");
    assert.equal(draftPhotos(), 0);
    requests[0].fail(new Error("Offline"));
    await tick();
    assert.equal(controller.command({ kind: "discard" }), null);
    for (let turn = 0; turn < 5; turn++) await tick();
    assert.deepEqual((await startAt(store, "chat")).log, []);
    assert.equal(draft.value.text, "caption");
    assert.equal(draft.getPhotos().length, 1);
    assert.equal(await store.readDraft("chat"), "caption");
    assert.equal(draftPhotos(), 1);
    // Sent again, failed, and something typed meanwhile: that stays.
    assert.equal(await sendWithPhotos(controller, "caption"), "saved");
    await tick();
    requests[1].fail(new Error("Offline"));
    await tick();
    draft.edit("typed since");
    assert.equal(controller.command({ kind: "discard" }), null);
    for (let turn = 0; turn < 5; turn++) await tick();
    assert.equal(draft.value.text, "typed since");
    assert.equal(draft.getPhotos().length, 0);
    assert.equal(draftPhotos(), 0);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
