import assert from "node:assert/strict";
import test from "node:test";
import { audioInputIssue } from "../src/chat/audioCapability.ts";
import { contextHasAudio } from "../src/chat/context.ts";
import { ChatController } from "../src/chat/ChatController.ts";
import { connect } from "./sqlite-helper.mjs";

const models = [
  {
    id: "text",
    name: "Text model",
    audio: false,
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: "audio",
    name: "Audio model",
    audio: true,
    inputPrice: null,
    outputPrice: null,
  },
];
const settings = { apiKey: "fake-never-sent", model: "text" };
const recording = { data: "UklGRg==", format: "wav" };

test("audio capability distinguishes supported, unsupported, and unknown models", () => {
  assert.equal(audioInputIssue("audio", models), null);
  assert.match(
    audioInputIssue("text", models),
    /Text model doesn’t support audio/,
  );
  assert.match(audioInputIssue("custom", models), /verify audio support/);
  assert.match(audioInputIssue("audio", undefined), /verify audio support/);
});

test("audio eligibility matches bounded context, including the prospective text", () => {
  const audio = {
    role: "user",
    text: "Voice message",
    status: "complete",
    audio: { encodedLength: 8 },
  };
  const text = { role: "user", text: "a".repeat(23_000), status: "complete" };
  assert.equal(contextHasAudio([audio], "hello"), true);
  assert.equal(contextHasAudio([audio, text], "a".repeat(500)), true);
  assert.equal(contextHasAudio([audio, text], "a".repeat(1_100)), false);
  assert.equal(contextHasAudio([{ ...text, text: "plain" }], "hello"), false);
});

test("unsupported text/audio sends and retries are blocked before changing saved messages or draft", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const pending = await store.beginReply(
    "chat",
    "Voice message",
    "audio",
    1,
    recording,
  );
  const replyId = pending.messages.at(-1).id;
  await store.finishReply(replyId, "failed", "", "test failure");
  let requests = 0;
  const controller = new ChatController(
    store,
    await store.read(),
    () => {
      requests++;
      return new Promise(() => {});
    },
    () => "unused",
    "",
    (model) => audioInputIssue(model, models),
    () => null,
  );
  try {
    const draft = controller.getSnapshot().draft;
    draft.edit("Keep this draft");
    await controller.flushDraft();
    await controller.chooseModel("text");
    const before = await store.read();
    assert.equal(await controller.send("Follow-up", settings), false);
    assert.equal(await controller.sendAudio(recording, settings), false);
    assert.equal(await controller.retryReply(replyId, settings), false);
    assert.equal(requests, 0);
    assert.deepEqual(await store.read(), before);
    assert.equal(draft.value.text, "Keep this draft");
    assert.equal(await store.readDraft("chat"), "Keep this draft");
    assert.match(controller.getSnapshot().error, /doesn’t support audio/);
    await controller.chooseModel("audio");
    assert.equal(
      await controller.retryReply(replyId, { ...settings, model: "audio" }),
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a text model can still send plain text in a conversation without audio", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  let requests = 0;
  const controller = new ChatController(
    store,
    await store.read(),
    async () => {
      requests++;
      return { text: "Reply", model: "text", cost: 0 };
    },
    () => "text-chat",
    "",
    (model) => audioInputIssue(model, models),
    () => null,
  );
  try {
    assert.equal(await controller.send("Hello", settings), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("the final context is checked again before starting inference", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  let allowed = true,
    requests = 0;
  const controller = new ChatController(
    store,
    await store.read(),
    async () => {
      requests++;
      return { text: "Unexpected", model: "audio", cost: 0 };
    },
    () => "changed",
    "",
    () => (allowed ? null : "Audio unavailable"),
    () => null,
  );
  try {
    assert.equal(
      await controller.sendAudio(recording, { ...settings, model: "audio" }),
      true,
    );
    allowed = false;
    for (let i = 0; i < 10 && controller.getSnapshot().pending; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    assert.equal(
      controller.getSnapshot().history.messages.at(-1).status,
      "failed",
    );
    assert.match(
      controller.getSnapshot().history.messages.at(-1).error,
      /Audio unavailable/,
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
