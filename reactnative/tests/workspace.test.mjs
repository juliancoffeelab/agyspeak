import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendTurn,
  connect,
  openChat,
  readLatest,
  replies,
  startAt,
  tick,
  workspace as startWorkspace,
} from "./sqlite-helper.mjs";
import { NOT_CONNECTED } from "../src/features/chat/runtime/chatRuntime.ts";
import {
  MODEL_IN_USE,
  NOTHING_RUNNING,
  UNSAVED,
  WRITING,
} from "../src/features/chat/runtime/machine.ts";
import { StreamingText } from "../src/features/chat/runtime/StreamingText.ts";
import { completeReply } from "../src/providers/openrouter/transport.ts";

// A chat's workspace against real SQLite, with a reply port the test
// answers by hand.
async function setup(options = {}) {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  const port = replies();
  const opened = await startWorkspace({
    store,
    openAt: null,
    reply: port.reply,
    ...options,
  });
  return { store, sqlite, failRead, ...port, workspace: opened };
}
const saved = async (store, id = "chat") => (await startAt(store, id)).log;
const shape = (log) =>
  log.map((entry) =>
    entry.kind === "reply"
      ? [entry.kind, entry.status, entry.text]
      : [entry.kind, entry.text ?? null],
  );

test("a message is saved before its request; a failed reply is last, and a retry replaces it", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  try {
    const sending = workspace.send("Hello", []);
    assert.equal(requests.length, 0, "the request waits for the write");
    assert.equal(await sending, "saved");
    await tick();
    assert.deepEqual(shape(await saved(store)), [["user", "Hello"]]);
    assert.equal(requests.length, 1);
    requests[0].onText("Hal");
    requests[0].fail(new Error("Offline"));
    await tick();
    assert.equal(openChat(workspace).phase.kind, "failed");
    assert.deepEqual(shape(await saved(store)), [
      ["user", "Hello"],
      ["reply", "failed", "Hal"],
    ]);
    // The entry keeps how it ended; what was thrown stays in the phase.
    const failed = (await saved(store))[1];
    assert.equal(failed.ending, "request-failed");
    assert.equal(failed.providerMessage, null);
    assert.equal(openChat(workspace).phase.fault.cause.message, "Offline");
    assert.equal(requests.length, 1, "there is no automatic retry");
    assert.equal(workspace.command({ kind: "retry" }), null);
    await tick();
    assert.deepEqual(shape(await saved(store)), [["user", "Hello"]]);
    requests[1].answer("Hi!", "actual/model");
    await tick();
    const log = await saved(store);
    assert.deepEqual(shape(log), [
      ["user", "Hello"],
      ["reply", "complete", "Hi!"],
    ]);
    assert.equal(log[1].model, "actual/model");
    // A finished reply is asked again in its place, too.
    assert.equal(workspace.command({ kind: "retry" }), null);
    await tick();
    requests[2].answer("Hi again!");
    await tick();
    assert.deepEqual(shape(await saved(store)), [
      ["user", "Hello"],
      ["reply", "complete", "Hi again!"],
    ]);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("Stop reaches only the open chat; a stopped reply keeps what it wrote and late results are ignored", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  try {
    await workspace.send("Wait", []);
    await tick();
    requests[0].onText("Part");
    assert.equal(await workspace.select(null), true);
    assert.deepEqual(workspace.state.getState().running, ["chat"]);
    assert.equal(workspace.command({ kind: "stop" }), NOTHING_RUNNING);
    assert.equal(requests[0].signal.aborted, false);
    await workspace.select("chat");
    assert.equal(workspace.command({ kind: "stop" }), null);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].onText("Part and late");
    requests[0].answer("Too late");
    await tick();
    const log = await saved(store);
    assert.deepEqual(shape(log), [
      ["user", "Wait"],
      ["reply", "stopped", "Part"],
    ]);
    assert.equal(log[1].ending, "stopped");
    assert.deepEqual(workspace.state.getState().running, []);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("deleting a chat that is writing stops it, and nothing it was doing writes it again", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  try {
    await workspace.send("Wait", []);
    await tick();
    assert.equal(await workspace.remove("chat"), true);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].answer("Too late");
    await tick();
    assert.deepEqual((await readLatest(store)).chats, []);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM entries").get().count,
      0,
    );
    assert.notEqual(workspace.state.getState().open.getState().id, "chat");
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("without a key nothing is saved or sent; a failed save sends nothing until it is saved again", async () => {
  let key = null;
  const { store, sqlite, requests, workspace } = await setup({
    apiKey: () => key,
  });
  try {
    assert.equal(await workspace.send("Hello", []), "refused");
    assert.equal(workspace.state.getState().error, NOT_CONNECTED);
    assert.equal((await readLatest(store)).chats.length, 0);
    key = "test-key";
    sqlite.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON entries
      BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
    const sending = workspace.send("Hello", []);
    await tick();
    assert.equal(openChat(workspace).phase.kind, "unsaved");
    assert.equal(workspace.refusal("send"), UNSAVED);
    assert.equal(requests.length, 0);
    assert.equal((await readLatest(store)).chats.length, 0);
    sqlite.exec("DROP TRIGGER fail_write");
    assert.equal(workspace.command({ kind: "save-again" }), null);
    assert.equal(await sending, "saved");
    await tick();
    assert.deepEqual(shape(await saved(store)), [["user", "Hello"]]);
    assert.equal(requests.length, 1);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("a reply whose save fails is kept and closes only its chat; saving it again writes it", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  try {
    await workspace.send("Hello", []);
    await tick();
    sqlite.exec(`CREATE TRIGGER fail_reply BEFORE INSERT ON entries
      WHEN json_extract(NEW.body, '$.kind') = 'reply'
      BEGIN SELECT RAISE(ABORT, 'disk'); END;`);
    requests[0].answer("Kept reply");
    await tick();
    const chat = openChat(workspace);
    assert.equal(chat.phase.kind, "unsaved");
    assert.equal(chat.log.at(-1).text, "Kept reply");
    assert.equal(workspace.state.getState().error, null);
    assert.equal(await workspace.send("Blocked?", []), "refused");
    assert.equal(workspace.state.getState().error, UNSAVED);
    // Another chat goes on meanwhile.
    assert.equal(await workspace.select(null), true);
    assert.equal(await workspace.send("Elsewhere", []), "saved");
    await tick();
    assert.equal(requests.length, 2);
    sqlite.exec("DROP TRIGGER fail_reply");
    await workspace.select("chat");
    assert.equal(openChat(workspace).log.at(-1).text, "Kept reply");
    assert.equal(workspace.command({ kind: "save-again" }), null);
    await tick();
    assert.deepEqual(shape(await saved(store)), [
      ["user", "Hello"],
      ["reply", "complete", "Kept reply"],
    ]);
    assert.equal(openChat(workspace).phase.kind, "ready");
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("two sends at once take one; a reply in another chat is saved while this one is open", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  try {
    const results = await Promise.all([
      workspace.send("First", []),
      workspace.send("Second", []),
    ]);
    assert.deepEqual(results, ["saved", "refused"]);
    assert.equal(workspace.state.getState().error, WRITING);
    await tick();
    await workspace.select(null);
    const fresh = workspace.state.getState().open.getState().id;
    assert.notEqual(fresh, "chat");
    requests[0].answer("Done");
    await tick();
    assert.equal(workspace.state.getState().open.getState().id, fresh);
    assert.deepEqual(openChat(workspace).log, []);
    assert.deepEqual(shape(await saved(store)), [
      ["user", "First"],
      ["reply", "complete", "Done"],
    ]);
    await workspace.select("chat");
    assert.equal(openChat(workspace).log.at(-1).text, "Done");
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("disposing while the message is written sends no request; it opens failed after", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  const write = store.writeLog.bind(store);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  store.writeLog = async (...args) => {
    const list = await write(...args);
    await gate;
    return list;
  };
  try {
    // Its send is answered by the write, which disposing stops waiting for.
    void workspace.send("Save first", []);
    const disposing = workspace.dispose();
    release();
    await disposing;
    await tick();
    assert.equal(requests.length, 0);
    store.writeLog = write;
    const again = await startWorkspace({
      store,
      openAt: "chat",
      reply: replies().reply,
    });
    assert.equal(openChat(again).phase.kind, "failed");
    await again.dispose();
  } finally {
    sqlite.close();
  }
});

test("a recording and its levels are sent and survive a failure and its retry", async () => {
  const audio = {
    data: "UklGRg==",
    format: "m4a",
    durationMillis: 2300,
    levels: [0.1, 0.8, 0.2],
  };
  const { store, sqlite, requests, workspace } = await setup();
  try {
    assert.equal(await workspace.sendAudio(audio), "saved");
    await tick();
    assert.deepEqual(requests[0].messages[0].audio, {
      data: audio.data,
      format: audio.format,
    });
    requests[0].fail(new Error("Offline"));
    await tick();
    workspace.command({ kind: "retry" });
    await tick();
    assert.deepEqual(requests[1].messages, requests[0].messages);
    requests[1].answer("Hej!");
    await tick();
    const { chats, log } = await startAt(store, "chat");
    assert.equal(chats[0].title, "Voice message");
    assert.deepEqual(
      { ...log[0].audio, key: null },
      {
        key: null,
        format: audio.format,
        encodedLength: audio.data.length,
        durationMillis: audio.durationMillis,
        levels: audio.levels,
      },
    );
    assert.deepEqual(shape(log).at(-1), ["reply", "complete", "Hej!"]);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("chunks publish only the reply's stream, never the chat or storage", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  try {
    await workspace.send("Stream", []);
    await tick();
    const view = workspace.state.getState().open;
    const before = view.getState();
    let published = 0;
    const unsubscribe = view.subscribe(() => {
      published++;
    });
    requests[0].onText("First");
    requests[0].onText("First second");
    assert.equal(published, 0, "chunks never publish the chat");
    assert.equal(view.getState(), before);
    assert.equal(before.stream.latest, "First second");
    assert.deepEqual(shape(await saved(store)), [["user", "Stream"]]);
    workspace.command({ kind: "stop" });
    await tick();
    assert.deepEqual(shape(await saved(store)).at(-1), [
      "reply",
      "stopped",
      "First second",
    ]);
    assert.equal(view.getState().stream, null);
    unsubscribe();
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("a reply cut short by the model's limit or a timeout ends with why", async () => {
  for (const ending of ["length", "timeout"]) {
    // The model's own limit is below the chat's room, so it is the one hit.
    const { store, sqlite, requests, workspace } = await setup({
      models: { contextLength: () => null, maxOutput: () => 1 },
    });
    try {
      await workspace.send("Question", []);
      await tick();
      requests[0].answer("Half an ans", "test/model", ending);
      await tick();
      const reply = (await saved(store)).at(-1);
      assert.equal(reply.status, "stopped");
      assert.equal(reply.text, "Half an ans");
      assert.equal(reply.ending, ending);
    } finally {
      await workspace.dispose();
      sqlite.close();
    }
  }
});

test("a reply's time is what its request took, on the runtime's monotonic clock", async (t) => {
  // The wall clock jumps about; a duration is read from the monotonic one.
  let now = 1000;
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const { store, sqlite, requests, workspace } = await setup({
    now: () => now,
  });
  try {
    await workspace.send("Hello", []);
    await tick();
    now = 900;
    clock = 1250;
    requests[0].answer("Complete");
    await tick();
    assert.equal((await saved(store)).at(-1).elapsedMillis, 1250);
    assert.equal((await saved(store)).at(-1).postedAt, 900);
    now = 50_000;
    await workspace.send("Again", []);
    await tick();
    now = 3400;
    clock = 1650;
    workspace.command({ kind: "stop" });
    await tick();
    assert.equal((await saved(store)).at(-1).elapsedMillis, 400);
    workspace.command({ kind: "retry" });
    await tick();
    clock = 2300;
    requests[2].fail(new Error("offline"));
    await tick();
    const failed = (await saved(store)).at(-1);
    assert.equal(failed.status, "failed");
    assert.equal(failed.elapsedMillis, 650);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("a chat keeps its model while it replies; a switch after it keeps the draft and the next send uses it", async () => {
  let defaultModel = "alpha";
  const { store, sqlite, requests, workspace } = await setup({
    defaultModel: () => defaultModel,
  });
  try {
    await workspace.chooseModel("alpha");
    assert.equal(await workspace.send("hello", []), "saved");
    await tick();
    const draft = workspace.state.getState().draft;
    draft.edit("next message");
    await draft.flush();
    await assert.rejects(workspace.chooseModel("beta"), {
      message: MODEL_IN_USE,
    });
    assert.equal(openChat(workspace).model.id, "alpha");
    requests[0].answer("done", "routed/model");
    await tick();
    await workspace.chooseModel("beta");
    assert.equal(workspace.state.getState().draft, draft);
    assert.equal(draft.value.text, "next message");
    assert.equal(openChat(workspace).model.id, "beta");
    assert.equal(openChat(workspace).log.at(-1).model, "routed/model");
    sqlite.exec(`CREATE TRIGGER fail_model BEFORE UPDATE OF selected_model ON chats
      BEGIN SELECT RAISE(ABORT, 'disk'); END;`);
    await assert.rejects(workspace.chooseModel("failed"), /disk/);
    sqlite.exec("DROP TRIGGER fail_model");
    assert.equal(openChat(workspace).model.id, "beta");
    assert.equal(workspace.state.getState().busy, false);
    assert.equal((await readLatest(store)).selectedModel, "beta");
    // The default model is for chats with nothing in them.
    defaultModel = "new-global-default";
    workspace.inputsChanged();
    assert.equal(await workspace.send("next", []), "saved");
    await tick();
    assert.deepEqual(
      requests.map((request) => request.settings.model),
      ["alpha", "beta"],
    );
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("a failed open keeps the open chat and its draft; deleting the open chat opens the new chat", async () => {
  const { store, sqlite, failRead, requests, workspace } = await setup();
  await appendTurn(store, "b", "B", "reply B", 1);
  try {
    await workspace.send("A", []);
    await tick();
    const draft = workspace.state.getState().draft;
    draft.edit("private A draft");
    await draft.flush();
    failRead();
    assert.equal(await workspace.select("b"), false);
    assert.equal(workspace.state.getState().openFailure.id, "b");
    requests[0].answer("reply A");
    await tick();
    assert.equal(workspace.state.getState().open.getState().id, "chat");
    assert.equal(workspace.state.getState().draft, draft);
    assert.equal(draft.value.text, "private A draft");
    assert.equal(openChat(workspace).log.at(-1).text, "reply A");
    assert.equal(await workspace.select("b"), true);
    assert.equal(workspace.state.getState().draft.value.text, "");
    assert.equal(await store.readDraft("chat"), "private A draft");
    assert.equal(await workspace.remove("b"), true);
    const opened = workspace.state.getState().open.getState();
    assert.equal(opened.id, "chat-2");
    assert.deepEqual(opened.chat.log, []);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("a reply without spaces between words, or with a very long word, is still shown as it arrives", () => {
  const frames = [];
  const requestFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (run) => frames.push(run);
  // What the store shows after `text` has arrived and a frame has run.
  const shownAfter = (stream, text) => {
    stream.update(text);
    frames.shift()();
    return stream.getSnapshot();
  };
  try {
    const japanese = new StreamingText();
    assert.equal(shownAfter(japanese, "洗濯機を止め"), "洗濯機を止め");
    assert.equal(
      shownAfter(japanese, "洗濯機を止めるには、ボタンを"),
      "洗濯機を止めるには、ボタンを",
    );
    const address = "https://example.com/" + "a".repeat(100);
    const long = new StreamingText();
    assert.equal(shownAfter(long, "See " + address.slice(0, 30)), "See ");
    assert.equal(shownAfter(long, "See " + address), "See " + address);
    assert.equal(
      shownAfter(long, "See " + address + "\n" + "😀".repeat(20) + "\ud83d"),
      "See " + address + "\n" + "😀".repeat(20),
      "a cut never splits a character",
    );
    const started = performance.now();
    shownAfter(new StreamingText(), "x".repeat(200_000) + " y");
    assert.ok(performance.now() - started < 100, "a long word costs no more");
  } finally {
    globalThis.requestAnimationFrame = requestFrame;
  }
});

const MOCK_PHOTO = { data: "/9j/", thumbnail: "/9j/", width: 100, height: 80 };
const count = (sqlite, table) =>
  sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const draftText = (sqlite) =>
  sqlite.prepare("SELECT text FROM drafts WHERE chat_key = 'chat'").get()
    ?.text ?? "";

// Sent as the composer sends it: the draft's photos read, then its text
// submitted.
async function submit(workspace, allowEmpty) {
  const draft = workspace.state.getState().draft;
  const photos = await draft.readPhotos();
  return draft.submit(
    (text) => workspace.send(text, photos),
    () => {},
    () => {},
    allowEmpty,
  );
}

test("a message whose write fails stays the draft until a write takes it, and what is typed after it is kept", async () => {
  const { store, sqlite, requests, workspace } = await setup();
  const write = store.writeLog.bind(store);
  store.writeLog = async () => {
    throw new Error("disk full");
  };
  try {
    const draft = workspace.state.getState().draft;
    await draft.addPhotos([MOCK_PHOTO]);
    draft.edit("Keep me");
    let result = null;
    const sending = submit(workspace, true);
    sending.then((value) => (result = value));
    for (let turn = 0; turn < 5; turn++) await tick();
    assert.equal(openChat(workspace).phase.kind, "unsaved");
    assert.equal(requests.length, 0);
    draft.edit("Typed after");
    await draft.flush().catch(() => {});
    // The database as the app would find it opened again now.
    assert.equal(count(sqlite, "entries"), 0);
    assert.equal(draftText(sqlite), "Keep me");
    assert.equal(count(sqlite, "draft_photos"), 1);
    assert.equal(result, null, "the send isn't done before its message is");
    store.writeLog = write;
    assert.equal(workspace.command({ kind: "save-again" }), null);
    assert.equal(await sending, "saved");
    const [message] = await saved(store);
    assert.equal(message.text, "Keep me");
    assert.equal(message.photos.length, 1);
    assert.equal(draftText(sqlite), "Typed after");
    assert.equal(count(sqlite, "draft_photos"), 0);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("the write of a message takes it from the draft in the same transaction", async () => {
  const { store, sqlite, workspace } = await setup();
  const write = store.writeLog.bind(store);
  const after = [];
  store.writeLog = async (...args) => {
    const list = await write(...args);
    after.push({
      entries: count(sqlite, "entries"),
      text: draftText(sqlite),
      photos: count(sqlite, "draft_photos"),
    });
    return list;
  };
  try {
    const draft = workspace.state.getState().draft;
    await draft.addPhotos([MOCK_PHOTO]);
    draft.edit("Hello");
    await draft.flush();
    assert.equal(
      await workspace.send("Hello", await draft.readPhotos()),
      "saved",
    );
    assert.deepEqual(after[0], { entries: 1, text: "", photos: 0 });
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

// Numbers a provider may send where a token count or a cost belongs.
const BAD_COUNTS = [-1, 2.5, "3", 1e300, 2 ** 60, null, {}, -0.01];
const BAD_COSTS = [-1, "3", null, {}, -0.01];

test("a reply whose usage the provider misreports is saved with those counts unknown, and the chat opens again", async () => {
  let turn = 0;
  const { store, sqlite, workspace } = await setup({
    reply: (messages, settings, signal, onText) =>
      completeReply(messages, settings, signal, onText, async () => {
        const count = BAD_COUNTS[turn % BAD_COUNTS.length];
        const cost = BAD_COSTS[turn % BAD_COSTS.length];
        turn++;
        // The latest report of each number counts; one left out keeps its
        // earlier report.
        const events = [
          {
            usage: {
              cost: 0.002,
              prompt_tokens: 7,
              completion_tokens: 3,
              prompt_tokens_details: {
                cached_tokens: 1,
                cache_write_tokens: 2,
              },
            },
          },
          {
            model: "m",
            choices: [{ delta: { content: "Hi!" } }],
            usage: {
              cost,
              completion_tokens: count,
              prompt_tokens_details: {
                cached_tokens: count,
                cache_write_tokens: count,
              },
            },
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
  });
  try {
    const turns = Math.max(BAD_COUNTS.length, BAD_COSTS.length);
    for (let sent = 0; sent < turns; sent++) {
      assert.equal(await workspace.send(`Hello ${sent}`, []), "saved");
      for (let step = 0; step < 5; step++) await tick();
      assert.equal(openChat(workspace).phase.kind, "ready");
    }
    const log = (await startAt(store, "chat")).log;
    const replies = log.filter((entry) => entry.kind === "reply");
    assert.equal(replies.length, turns);
    for (const reply of replies)
      assert.deepEqual(reply.usage, {
        costUSD: null,
        promptTokens: 7,
        completionTokens: null,
        cachedPromptTokens: null,
        cacheWritePromptTokens: null,
      });
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("an entry the app couldn't read back is never written: its write fails and the chat stays openable", async () => {
  const { store, sqlite, workspace } = await setup({
    reply: async () => ({
      text: "Hi!",
      model: "m",
      usage: {
        costUSD: null,
        promptTokens: null,
        completionTokens: null,
        cachedPromptTokens: -1,
        cacheWritePromptTokens: null,
      },
      stopped: null,
    }),
  });
  try {
    assert.equal(await workspace.send("Hello", []), "saved");
    for (let turn = 0; turn < 5; turn++) await tick();
    const { phase } = openChat(workspace);
    assert.equal(phase.kind, "unsaved");
    assert.match(phase.cause.message, /Entry 1 isn’t one this version saves/);
    assert.deepEqual(shape(await saved(store)), [["user", "Hello"]]);
  } finally {
    await workspace.dispose();
    sqlite.close();
  }
});

test("a stream shows whole words a frame at a time, and an unfinished table row waits", () => {
  const frames = [];
  const requestFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (run) => frames.push(run);
  try {
    const stream = new StreamingText();
    let notifications = 0;
    stream.subscribe(() => {
      notifications++;
    });
    stream.update("First");
    stream.update("First second");
    stream.update("First second\n| third");
    assert.equal(frames.length, 1, "rapid chunks share one frame");
    assert.equal(notifications, 0, "nothing is shown between frames");
    frames.shift()();
    assert.equal(notifications, 1);
    assert.equal(stream.getSnapshot(), "First second\n");
    stream.update("First second\n| third |\nfour");
    frames.shift()();
    assert.equal(stream.getSnapshot(), "First second\n| third |\n");
    stream.close();
    assert.equal(stream.getSnapshot(), "First second\n| third |\nfour");
  } finally {
    globalThis.requestAnimationFrame = requestFrame;
  }
});
