import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connect,
  openChat,
  replies,
  savedChats,
  startAt,
  tick,
  workspace,
} from "./sqlite-helper.mjs";
import {
  COMPACT_AT_MEDIA_BYTES,
  CONTEXT_CAP,
  CONTEXT_FLOOR,
  CONTEXT_TOO_SMALL,
  MESSAGE_TOO_LONG,
  RECORDING_TOO_LONG,
  chatBudget,
  messageEstimate,
} from "../src/features/chat/runtime/compaction.ts";
import { MEDIA_BUDGET_BYTES } from "../src/features/chat/runtime/log.ts";
import { MAX_PHOTO_BYTES } from "../src/providers/openrouter/transport.ts";
import { RecordingSession } from "../src/device/recording/RecordingSession.ts";
import { createAudioArbiter } from "../src/device/audio.ts";

// What the machine's properties (machine.test.mjs) leave to these: the
// workspace around it, with real storage. Every size is read from the
// budget of the model asked, so the tests hold whatever the shares are.
const BUDGET = chatBudget(CONTEXT_FLOOR);
const SUMMARY_ASKED = "Stop here and don’t reply";
const isSummary = (request) =>
  request.messages.at(-1).text.startsWith(SUMMARY_ASKED);

// The words of a message the estimate takes as `tokens`.
function words(tokens) {
  // " w" is a token of the tokenizer: the fewest of them that reach it.
  const reaches = (count) =>
    messageEstimate({ text: " w".repeat(count) }) >= tokens;
  let high = 1;
  while (!reaches(high)) high *= 2;
  let low = Math.floor(high / 2);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (reaches(middle)) high = middle;
    else low = middle;
  }
  return `${" w".repeat(high)}`.trim();
}

async function setup(models = {}) {
  const { store, sqlite } = connect();
  await store.initialize();
  const port = replies();
  const controller = await workspace({
    store,
    openAt: null,
    reply: port.reply,
    models,
  });
  // The requests not yet answered.
  const open = () =>
    port.requests.filter((request) => request.settled !== true);
  // Answers the oldest open request with `text`.
  const answer = async (text) => {
    await tick();
    const [request] = open();
    assert.ok(request, "a request to answer");
    request.settled = true;
    request.answer(text);
    await tick();
    return request;
  };
  return { store, sqlite, controller, requests: port.requests, open, answer };
}

test("a model whose window the catalog doesn't give is sized within the cap", () => {
  assert.equal(chatBudget(null).limit, CONTEXT_CAP);
  assert.equal(chatBudget(CONTEXT_CAP * 2).limit, CONTEXT_CAP);
});

test("a message or recording over its share is refused before it is saved, as is a chat below the floor", async () => {
  const { store, sqlite, controller, requests } = await setup({
    contextLength: (model) =>
      model === "small" ? CONTEXT_FLOOR - 1 : CONTEXT_FLOOR,
  });
  try {
    assert.equal(
      await controller.send(words(BUDGET.message + 1), []),
      "refused",
    );
    assert.equal(controller.state.getState().error, MESSAGE_TOO_LONG);
    // A recording's size is its duration's.
    let seconds = 1;
    const recording = (seconds) => ({
      data: "UklGRg==",
      format: "wav",
      durationMillis: seconds * 1000,
    });
    while (
      messageEstimate({ text: "", audio: recording(seconds) }) <= BUDGET.message
    )
      seconds++;
    assert.equal(await controller.sendAudio(recording(seconds)), "refused");
    assert.equal(controller.state.getState().error, RECORDING_TOO_LONG);
    await controller.chooseModel("small");
    assert.equal(await controller.send("hi", []), "refused");
    assert.equal(controller.state.getState().error, CONTEXT_TOO_SMALL);
    assert.deepEqual(await savedChats(store), []);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM media").get().n,
      0,
      "the refused recording isn't kept",
    );
    assert.equal(requests.length, 0);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a send that needs room waits for its compaction, which is written with it; Stop gives it back to the draft", async () => {
  const { store, sqlite, controller, requests, answer } = await setup();
  try {
    const big = words(BUDGET.message);
    assert.equal(await controller.send(big, []), "saved");
    assert.equal(isSummary(await answer("ok")), false);
    // The second message of its share needs the first compacted away. Its
    // send is answered once it is saved.
    const second = controller.send(big, []);
    await tick();
    assert.equal(openChat(controller).phase.kind, "making-room");
    assert.equal(requests.length, 2);
    assert.ok(isSummary(requests[1]));
    assert.equal(await controller.send("another", []), "refused");
    // Nothing of it is saved until its room is made.
    assert.equal((await startAt(store, "chat")).log.length, 2);
    await answer("the record");
    assert.equal(await second, "saved");
    const reply = await answer("ok");
    assert.equal(isSummary(reply), false);
    assert.equal(reply.messages[0].role, "system");
    assert.deepEqual(
      (await startAt(store, "chat")).log.map((entry) => entry.kind),
      // The compaction made room before the message, written with it.
      ["user", "reply", "compaction", "user", "reply"],
    );
    // Stopped while it waits, the message isn't saved but is the draft.
    const saved = (await startAt(store, "chat")).log;
    const third = controller.send(big, []);
    await tick();
    assert.equal(openChat(controller).phase.kind, "making-room");
    assert.equal(controller.command({ kind: "stop" }), null);
    assert.equal(await third, "refused");
    await tick();
    assert.equal(openChat(controller).phase.kind, "ready");
    assert.deepEqual((await startAt(store, "chat")).log, saved);
    assert.equal(requests.at(-1).signal.aborted, true);
    assert.equal(controller.state.getState().draft.value.text, big);
    assert.equal(await store.readDraft("chat"), big);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

// The composer's recording, picked as a file: its clip is removed only once
// a send of it is accepted.
function picked(uri) {
  const removed = [];
  const session = new RecordingSession({
    permission: async () => true,
    prepare: async () => {},
    record: () => {},
    stop: async () => {},
    status: () => ({ isRecording: false, durationMillis: 0 }),
    uri: () => uri,
    remove: (gone) => removed.push(gone),
    audio: createAudioArbiter(),
  });
  return { session, removed };
}
// The longest recording within a message's share.
function longest() {
  const recording = (seconds) => ({
    data: "UklGRg==",
    format: "m4a",
    durationMillis: seconds * 1000,
  });
  let seconds = 1;
  while (
    messageEstimate({ text: "", audio: recording(seconds + 1) }) <=
    BUDGET.message
  )
    seconds++;
  return recording(seconds);
}

for (const ending of ["stopped", "unsaved"])
  test(`a recording stays in the composer until its message is saved (${ending})`, async () => {
    const { store, sqlite, controller, answer } = await setup();
    try {
      const recording = longest();
      if (ending === "stopped") {
        assert.equal(await controller.send(words(BUDGET.message), []), "saved");
        await answer("ok");
      }
      const write = store.writeLog.bind(store);
      if (ending === "unsaved")
        store.writeLog = async () => {
          throw new Error("disk full");
        };
      const { session, removed } = picked("cache/voice.m4a");
      await session.pick(async () => ({
        uri: "cache/voice.m4a",
        format: "m4a",
        durationMillis: recording.durationMillis,
      }));
      let accepted = null;
      const sending = session.send(
        async () => (await controller.sendAudio(recording)) === "saved",
      );
      sending.then((value) => (accepted = value));
      for (let turn = 0; turn < 5; turn++) await tick();
      assert.equal(
        openChat(controller).phase.kind,
        ending === "stopped" ? "making-room" : "unsaved",
      );
      assert.equal(accepted, null);
      if (ending === "stopped") {
        assert.equal(controller.command({ kind: "stop" }), null);
        assert.equal(await sending, false);
        assert.equal(session.getSnapshot().phase, "ready");
        assert.equal(session.getSnapshot().clip.uri, "cache/voice.m4a");
        assert.deepEqual(removed, []);
      } else {
        assert.deepEqual(removed, []);
        store.writeLog = write;
        assert.equal(controller.command({ kind: "save-again" }), null);
        assert.equal(await sending, true);
        assert.deepEqual(removed, ["cache/voice.m4a"]);
        assert.ok((await startAt(store, "chat")).log[0].audio);
      }
    } finally {
      await controller.dispose();
      sqlite.close();
    }
  });

test("a message sent while the chat compacts waits for it and is sent after it", async () => {
  const { store, sqlite, controller, open, answer } = await setup();
  try {
    assert.equal(await controller.send("hello", []), "saved");
    await answer("ok");
    assert.equal(controller.command({ kind: "compact" }), null);
    await tick();
    const next = controller.send("next", []);
    assert.equal(openChat(controller).phase.kind, "making-room");
    assert.equal(open().length, 1, "no request of its own");
    assert.ok(isSummary(await answer("the record")));
    assert.equal(await next, "saved");
    const reply = await answer("ok");
    assert.equal(isSummary(reply), false);
    assert.equal(reply.messages.at(-1).text, "next");
    assert.deepEqual(
      (await startAt(store, "chat")).log.map((entry) => entry.kind),
      ["user", "reply", "compaction", "user", "reply"],
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a chat deleted while it is compacted gets no late summary", async () => {
  const { sqlite, controller, open, answer } = await setup();
  try {
    assert.equal(await controller.send("hello", []), "saved");
    await answer("ok");
    assert.equal(controller.command({ kind: "compact" }), null);
    await tick();
    const [summary] = open();
    assert.ok(isSummary(summary));
    assert.equal(await controller.remove("chat"), true);
    assert.equal(summary.signal.aborted, true);
    summary.answer("late");
    for (let turn = 0; turn < 10; turn++) await tick();
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM entries").get().n,
      0,
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM chats").get().n, 1);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("large photos start a compaction by their bytes, and the summariser is given them", async () => {
  // Two photos pass the byte trigger and fit the media budget.
  const bytes = Math.floor(MEDIA_BUDGET_BYTES / 2.5);
  assert.ok(
    bytes * 2 > COMPACT_AT_MEDIA_BYTES && bytes <= COMPACT_AT_MEDIA_BYTES,
  );
  assert.ok(bytes <= MAX_PHOTO_BYTES);
  const photo = {
    data: "A".repeat(Math.floor((bytes * 4) / 3)),
    thumbnail: "/9j/",
    width: 8,
    height: 8,
  };
  const { sqlite, controller, requests, answer } = await setup();
  const send = async (text) => {
    const draft = controller.state.getState().draft;
    await draft.addPhotos([photo]);
    return controller.send(text, await draft.readPhotos());
  };
  try {
    assert.equal(await send("one"), "saved");
    await answer("ok");
    assert.equal(await send("two"), "saved");
    // The text is far below its share: the photos' bytes start it.
    await answer("ok");
    await tick();
    const summary = requests.find(isSummary);
    assert.ok(summary, "a compaction by bytes");
    const users = summary.messages.filter(
      (message) => message.role === "user" && message.photos,
    );
    assert.deepEqual(
      users.map((message) => message.photos.length),
      [1, 1],
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});
