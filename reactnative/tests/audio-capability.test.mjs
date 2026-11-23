import assert from "node:assert/strict";
import test from "node:test";
import {
  audioInputIssue,
  requestIssue,
} from "../src/features/chat/runtime/capability.ts";
import { replyRequest } from "../src/features/chat/runtime/log.ts";
import {
  connect,
  openChat,
  readLatest,
  replies,
  tick,
  workspace,
} from "./sqlite-helper.mjs";

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
const recording = { data: "UklGRg==", format: "wav" };
const said = (text, audio = null) => ({
  kind: "user",
  text,
  audio,
  photos: [],
  postedAt: null,
});
const voice = {
  key: "1",
  format: "wav",
  encodedLength: 8,
  durationMillis: null,
  levels: null,
};

test("audio capability distinguishes supported, unsupported, and unknown models", () => {
  assert.equal(audioInputIssue("audio", models), null);
  assert.match(
    audioInputIssue("text", models),
    /Text model doesn’t support audio/,
  );
  assert.match(audioInputIssue("custom", models), /verify audio support/);
  assert.match(audioInputIssue("audio", undefined), /verify audio support/);
});

test("audio eligibility is read from the request, whatever text follows the recording", () => {
  const needsAudio = (log) =>
    requestIssue(replyRequest(log), { audio: "no audio", image: null })
      ?.reason === "no audio";
  // Text has no budget: a recording stays in the request behind any amount.
  const long = said("a".repeat(23_000));
  assert.equal(needsAudio([said("", voice), said("hello")]), true);
  assert.equal(needsAudio([said("", voice), long, said("a")]), true);
  assert.equal(needsAudio([said("plain"), said("hello")]), false);
});

test("a chat whose request carries audio refuses sends and retries on a text model, without changing it", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const port = replies();
  const controller = await workspace({
    store,
    openAt: null,
    reply: port.reply,
    models: { audioIssue: (model) => audioInputIssue(model, models) },
  });
  try {
    await controller.chooseModel("audio");
    assert.equal(await controller.sendAudio(recording), "saved");
    await tick();
    port.requests[0].answer("Heard you");
    await tick();
    const draft = controller.state.getState().draft;
    draft.edit("Keep this draft");
    await controller.flushDraft();
    await controller.chooseModel("text");
    const before = await readLatest(store);
    assert.equal(await controller.send("Follow-up", []), "refused");
    assert.match(controller.state.getState().error, /doesn’t support audio/);
    assert.equal(await controller.sendAudio(recording), "refused");
    assert.match(controller.command({ kind: "retry" }), /support audio/);
    assert.equal(port.requests.length, 1);
    assert.deepEqual(await readLatest(store), before);
    assert.equal(draft.value.text, "Keep this draft");
    assert.equal(await store.readDraft("chat"), "Keep this draft");
    await controller.chooseModel("audio");
    assert.equal(controller.command({ kind: "retry" }), null);
    await tick();
    assert.equal(port.requests.length, 2);
    assert.equal(openChat(controller).phase.kind, "writing");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a text model can still send plain text in a conversation without audio", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  const port = replies();
  const controller = await workspace({
    store,
    openAt: null,
    reply: port.reply,
    defaultModel: () => "text",
    models: { audioIssue: (model) => audioInputIssue(model, models) },
  });
  try {
    assert.equal(await controller.send("Hello", []), "saved");
    await tick();
    assert.equal(port.requests.length, 1);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
