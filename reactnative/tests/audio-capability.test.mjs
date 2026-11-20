import assert from "node:assert/strict";
import test from "node:test";
import {
  audioInputIssue,
  inputIssue,
} from "../src/features/chat/runtime/capability.ts";
import {
  connect,
  coordinator,
  latestId,
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
let settings = { apiKey: "fake-never-sent", model: "text" };
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
  const needsAudio = (messages, draft) =>
    inputIssue(
      messages,
      { kind: "text", text: draft, photos: [] },
      { audio: "no audio", image: null },
    ) === "no audio";
  assert.equal(needsAudio([audio], "hello"), true);
  assert.equal(needsAudio([audio, text], "a".repeat(500)), true);
  assert.equal(needsAudio([audio, text], "a".repeat(1_100)), false);
  assert.equal(needsAudio([{ ...text, text: "plain" }], "hello"), false);
});

test("unsupported text/audio sends and retries are blocked before changing saved messages or draft", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await store.seedChat("chat");
  const pending = await store.beginReply(
    "chat",
    { kind: "audio", audio: recording },
    "audio",
    1,
  );
  const replyId = pending.replyId;
  await store.finishReply(replyId, {
    status: "failed",
    text: "",
    error: "test failure",
    model: null,
    elapsedMillis: null,
  });
  let requests = 0;
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: () => {
      requests++;
      return new Promise(() => {});
    },
    audioIssue: (model) => audioInputIssue(model, models),
    settings: () => settings,
  });
  try {
    const draft = controller.state.getState().draft;
    draft.edit("Keep this draft");
    await controller.flushDraft();
    await controller.chooseModel("text");
    const before = await readLatest(store);
    assert.equal(await controller.send("Follow-up", []), false);
    assert.equal(await controller.sendAudio(recording), false);
    assert.equal(await controller.retryReply(replyId), false);
    assert.equal(requests, 0);
    assert.deepEqual(await readLatest(store), before);
    assert.equal(draft.value.text, "Keep this draft");
    assert.equal(await store.readDraft("chat"), "Keep this draft");
    assert.match(controller.state.getState().error, /doesn’t support audio/);
    await controller.chooseModel("audio");
    assert.equal(
      await withSettings({ model: "audio" }, () =>
        controller.retryReply(replyId),
      ),
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
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: async () => {
      requests++;
      return { text: "Reply", model: "text", usage: MOCK_USAGE, stopped: null };
    },
    audioIssue: (model) => audioInputIssue(model, models),
    settings: () => settings,
  });
  try {
    assert.equal(await controller.send("Hello", []), true);
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
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: async () => {
      requests++;
      return {
        text: "Unexpected",
        model: "audio",
        usage: MOCK_USAGE,
        stopped: null,
      };
    },
    audioIssue: () => (allowed ? null : "Audio unavailable"),
    settings: () => settings,
  });
  try {
    assert.equal(
      await withSettings({ model: "audio" }, () =>
        controller.sendAudio(recording),
      ),
      true,
    );
    allowed = false;
    for (let i = 0; i < 10 && controller.state.getState().pending.length; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    assert.equal(
      controller.state.getState().history.messages.at(-1).status,
      "failed",
    );
    assert.match(
      controller.state.getState().history.messages.at(-1).error,
      /Audio unavailable/,
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
