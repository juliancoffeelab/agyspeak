import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connect,
  coordinator,
  latestId,
  readLatest,
} from "./sqlite-helper.mjs";
import { StreamingText } from "../src/features/chat/runtime/StreamingText.ts";

let settings = { apiKey: "sk-or-v1-dummy-never-sent", model: "test/model" };
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function waitFor(controller, predicate) {
  if (predicate(controller.state.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = controller.state.subscribe((state) => {
      if (predicate(state)) {
        unsubscribe();
        resolve();
      }
    });
  });
}
async function setup(reply) {
  const { store, sqlite, failRead } = connect();
  await store.initialize();
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply,
    settings: () => settings,
  });
  return { store, sqlite, controller, failRead };
}

test("send saves the user message before inference; failure and retry reuse the same rows", async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const { controller, store, sqlite } = await setup(() =>
    ++calls === 1 ? first.promise : second.promise,
  );
  try {
    assert.equal(await controller.send("Hello", []), true);
    let saved = await readLatest(store);
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[0].text, "Hello");
    assert.equal(saved.messages[1].status, "pending");
    const ids = saved.messages.map((m) => m.id);
    first.reject(new Error("Offline"));
    await waitFor(controller, (s) => !s.pending.length);
    assert.equal(
      controller.state.getState().history.messages[1].status,
      "failed",
    );
    assert.equal(calls, 1, "there is no automatic retry");
    await controller.retryReply(ids[1]);
    second.resolve({
      text: "Hi!",
      model: "actual/model",
      cost: 0,
      stopped: null,
    });
    await waitFor(controller, (s) => !s.pending.length);
    saved = await readLatest(store);
    assert.deepEqual(
      saved.messages.map((m) => m.id),
      ids,
    );
    assert.equal(saved.messages[1].text, "Hi!");
    assert.equal(saved.messages[1].model, "actual/model");
    assert.equal(calls, 2);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("stop aborts; late completion cannot overwrite stopped status; navigation stays available", async () => {
  const request = deferred();
  let signal;
  const { controller, store, sqlite } = await setup(
    (_messages, _settings, requestSignal) => {
      signal = requestSignal;
      return request.promise;
    },
  );
  try {
    await controller.send("Wait", []);
    const chatId = controller.state.getState().history.activeId;
    assert.equal(await controller.select(null), true);
    assert.notEqual(controller.state.getState().history.activeId, chatId);
    // Stop reaches only the open chat's reply.
    await controller.stop();
    assert.equal(signal.aborted, false);
    await controller.select(chatId);
    await controller.stop();
    assert.equal(signal.aborted, true);
    request.resolve({
      text: "Too late",
      model: "test",
      cost: 0,
      stopped: null,
    });
    await Promise.resolve();
    const saved = await readLatest(store);
    assert.equal(saved.messages.at(-1).status, "cancelled");
    assert.equal(saved.messages.at(-1).text, "");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("deleting a generating chat cannot resurrect it when the response arrives", async () => {
  const request = deferred();
  const { controller, store, sqlite } = await setup(() => request.promise);
  try {
    await controller.send("Wait", []);
    const chatId = controller.state.getState().history.activeId;
    await controller.remove(chatId);
    request.resolve({
      text: "Too late",
      model: "test",
      cost: 0,
      stopped: null,
    });
    await Promise.resolve();
    assert.deepEqual(await readLatest(store), {
      chats: [],
      activeId: controller.state.getState().history.activeId,
      selectedModel: null,
      messages: [],
    });
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      0,
    );
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("blocked or failed save never starts inference", async () => {
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => {
    calls++;
    return { text: "No", model: "test", cost: 0, stopped: null };
  });
  try {
    assert.equal(
      await withSettings({ apiKey: null }, () => controller.send("Hello", [])),
      false,
    );
    sqlite.exec(`CREATE TRIGGER fail_pending BEFORE INSERT ON messages WHEN NEW.role='assistant'
      BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;`);
    assert.equal(await controller.send("Hello", []), false);
    assert.equal(calls, 0);
    assert.equal((await readLatest(store)).chats.length, 0);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("completion in another chat updates its history without changing current selection", async () => {
  const request = deferred();
  const { controller, store, sqlite } = await setup(() => request.promise);
  try {
    await controller.send("Wait", []);
    const chatId = controller.state.getState().history.activeId;
    await controller.select(null);
    const fresh = controller.state.getState().history.activeId;
    assert.notEqual(fresh, chatId);
    request.resolve({ text: "Done", model: "test", cost: 0, stopped: null });
    await waitFor(controller, (s) => !s.pending.length);
    assert.equal(controller.state.getState().history.activeId, fresh);
    assert.deepEqual(controller.state.getState().history.messages, []);
    await controller.select(chatId);
    assert.equal((await readLatest(store)).messages.at(-1).text, "Done");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("disposing during the initial save cannot start a late model request", async () => {
  const gate = deferred();
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => {
    calls++;
    return { text: "Late", model: "test", cost: 0, stopped: null };
  });
  const original = store.beginReply.bind(store);
  const entered = deferred();
  store.beginReply = async (...args) => {
    const saved = await original(...args);
    entered.resolve();
    await gate.promise;
    return saved;
  };
  try {
    const sending = controller.send("Save first", []);
    await entered.promise;
    const disposing = controller.dispose();
    gate.resolve();
    assert.equal(await sending, false);
    await disposing;
    assert.equal(calls, 0);
    await store.initialize();
    assert.equal((await readLatest(store)).messages.at(-1).status, "failed");
  } finally {
    sqlite.close();
  }
});

test("voice audio and its level display survive failure, retry, and successful completion", async () => {
  const audio = {
    data: "UklGRg==",
    format: "m4a",
    durationMillis: 2300,
    levels: [0.1, 0.8, 0.2],
  };
  let calls = 0;
  const { controller, store, sqlite } = await setup(
    async (messages, selected) => {
      calls++;
      assert.equal(selected.model, settings.model);
      assert.deepEqual(messages[0].audio, {
        data: audio.data,
        format: audio.format,
      });
      if (calls === 1) throw new Error("Offline");
      return { text: "Hej!", model: selected.model, cost: 0, stopped: null };
    },
  );
  try {
    assert.equal(await controller.sendAudio(audio), true);
    await waitFor(controller, (s) => !s.pending.length);
    await store.initialize();
    let saved = await readLatest(store);
    assert.deepEqual(saved.messages[0].audio, {
      id: saved.messages[0].id,
      encodedLength: audio.data.length,
      format: audio.format,
      durationMillis: audio.durationMillis,
      levels: audio.levels,
    });
    const ids = saved.messages.map((m) => m.id);
    await controller.retryReply(ids[1]);
    await waitFor(controller, (s) => !s.pending.length);
    saved = await readLatest(store);
    assert.deepEqual(
      saved.messages.map((m) => m.id),
      ids,
    );
    assert.equal(saved.messages[0].text, "Voice message");
    assert.deepEqual(saved.messages[0].audio, {
      id: saved.messages[0].id,
      encodedLength: audio.data.length,
      format: audio.format,
      durationMillis: audio.durationMillis,
      levels: audio.levels,
    });
    assert.equal(saved.chats[0].title, "Voice message");
    assert.equal(saved.messages[1].text, "Hej!");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("stopping while lazy audio is loading cannot start a late model request", async () => {
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => {
    calls++;
    return { text: "No", model: "test/model", cost: 0, stopped: null };
  });
  const entered = deferred(),
    gate = deferred();
  const read = store.readContext.bind(store);
  store.readContext = async (id) => {
    entered.resolve();
    await gate.promise;
    return read(id);
  };
  try {
    await controller.send("Wait for context", []);
    await entered.promise;
    const stopping = controller.stop();
    gate.resolve();
    await stopping;
    assert.equal(calls, 0);
    assert.equal((await readLatest(store)).messages.at(-1).status, "cancelled");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("stream updates only the reply store; Stop persists partial text and ignores late chunks", async () => {
  const request = deferred(),
    started = deferred();
  let update;
  // The frames the reply store asked for, run by hand.
  const frames = [];
  const requestFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (run) => frames.push(run);
  const { store, sqlite } = connect();
  await store.initialize();
  const controller = await coordinator({
    store,
    openAt: await latestId(store),
    reply: (_messages, _settings, _signal, onText) => {
      update = onText;
      started.resolve();
      return request.promise;
    },
    settings: () => settings,
  });
  try {
    await controller.send("Stream", []);
    await started.promise;
    const snapshot = controller.state.getState();
    const stream = snapshot.pending[0].stream;
    let notifications = 0;
    const unsubscribe = stream.subscribe(() => {
      notifications++;
    });
    update("First");
    update("First second");
    update("First second\n| third");
    assert.equal(
      controller.state.getState(),
      snapshot,
      "chunks never publish the whole chat state",
    );
    assert.equal(
      (await readLatest(store)).messages.at(-1).text,
      "",
      "chunks never write SQLite",
    );
    assert.equal(frames.length, 1, "rapid chunks share one frame");
    assert.equal(notifications, 0, "nothing is shown between frames");
    frames.shift()();
    assert.equal(notifications, 1, "a frame shows the words that are whole");
    assert.equal(
      stream.getSnapshot(),
      "First second\n",
      "an unfinished table row waits for its end",
    );
    update("First second\n| third |\nfour");
    frames.shift()();
    assert.equal(
      stream.getSnapshot(),
      "First second\n| third |\n",
      "an unfinished word waits for its end",
    );
    await controller.stop();
    assert.equal(notifications, 3, "the end shows the rest");
    const saved = (await readLatest(store)).messages.at(-1);
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.text, "First second\n| third |\nfour");
    update("Late chunk");
    request.resolve({
      text: "Late completion",
      model: "test",
      cost: 0,
      stopped: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await readLatest(store)).messages.at(-1).text, saved.text);
    assert.equal(stream.getSnapshot(), saved.text);
    unsubscribe();
  } finally {
    globalThis.requestAnimationFrame = requestFrame;
    await controller.dispose();
    sqlite.close();
  }
});

test("failed streams retain partial text and retry starts with an empty reply store", async () => {
  const requests = [deferred(), deferred()],
    started = [deferred(), deferred()];
  const updates = [];
  let calls = 0;
  const { controller, store, sqlite } = await setup(
    (_messages, _settings, _signal, onText) => {
      const index = calls++;
      updates[index] = onText;
      started[index].resolve();
      return requests[index].promise;
    },
  );
  try {
    await controller.send("Stream", []);
    await started[0].promise;
    updates[0]("Partial reply");
    requests[0].reject(new Error("Stream disconnected"));
    await waitFor(controller, (state) => !state.pending.length);
    const failed = (await readLatest(store)).messages.at(-1);
    assert.equal(failed.status, "failed");
    assert.equal(failed.text, "Partial reply");
    await controller.retryReply(failed.id);
    await started[1].promise;
    const stream = controller.state.getState().pending[0].stream;
    assert.equal(stream.getSnapshot(), "");
    updates[0]("Stale retry text");
    assert.equal(stream.latest, "");
    updates[1]("Complete reply");
    requests[1].resolve({
      text: "Complete reply",
      model: "actual",
      cost: 0,
      stopped: null,
    });
    await waitFor(controller, (state) => !state.pending.length);
    const final = (await readLatest(store)).messages.at(-1);
    assert.equal(final.id, failed.id);
    assert.equal(final.text, "Complete reply");
    assert.equal(final.status, "complete");
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("concurrent sends in one chat admit one reply; the second is refused before persistence", async () => {
  const request = deferred();
  const { controller, store, sqlite } = await setup(() => request.promise);
  try {
    const results = await Promise.all([
      controller.send("First", []),
      controller.send("Second", []),
    ]);
    assert.deepEqual(results, [true, false]);
    assert.deepEqual(
      (await readLatest(store)).messages.map((m) => m.text),
      ["First", ""],
    );
    // Another chat replies meanwhile, and Stop reaches only the open chat.
    assert.equal(await controller.select(null), true);
    assert.equal(await controller.send("Elsewhere", []), true);
    assert.deepEqual(
      controller.state.getState().pending.map((run) => run.chatId),
      ["chat", "chat-2"],
    );
    await controller.stop();
    assert.deepEqual(
      controller.state.getState().pending.map((run) => run.chatId),
      ["chat"],
    );
    assert.equal(await controller.send("Again", []), true);
  } finally {
    await controller.dispose();
    sqlite.close();
  }
});

test("a reply whose save fails is kept in memory and closes only its chat to new turns", async () => {
  const { controller, store, sqlite } = await setup(async () => ({
    text: "Kept reply",
    model: "test/model",
    cost: 0,
  }));
  const finish = store.finishReply.bind(store);
  store.finishReply = async () => {
    throw new Error("disk");
  };
  try {
    await controller.send("Hello", []);
    await waitFor(controller, (s) => s.unsavedReplies.length === 1);
    let state = controller.state.getState();
    assert.equal(state.unsavedReplies[0].outcome.text, "Kept reply");
    assert.deepEqual(state.pending, []);
    assert.match(state.unsavedReplies[0].cause.message, /disk/);
    assert.equal(state.error, null, "other chats hear nothing");
    store.finishReply = finish;
    assert.equal(await controller.send("Blocked?", []), false);
    assert.match(controller.state.getState().error, /can’t continue/);
    assert.equal((await readLatest(store)).messages.length, 2);
    assert.equal(await controller.select(null), true);
    assert.equal(await controller.send("Elsewhere", []), true);
    await waitFor(
      controller,
      (s) => !s.pending.length && s.history.messages.length === 2,
    );
    state = controller.state.getState();
    assert.equal(state.history.messages[1].text, "Kept reply");
    assert.equal(state.unsavedReplies.length, 1);
    assert.equal(await controller.remove("chat"), true);
    assert.deepEqual(controller.state.getState().unsavedReplies, []);
  } finally {
    store.finishReply = finish;
    await controller.dispose();
    sqlite.close();
  }
});

test("a reply cut short by a limit is saved as stopped, with its text and the reason", async () => {
  for (const [stopped, reason] of [
    ["length", "Reached the length limit."],
    ["timeout", "Timed out."],
  ]) {
    const { controller, store, sqlite } = await setup(async () => ({
      text: "Half an ans",
      model: "test/model",
      cost: 0,
      stopped,
    }));
    try {
      assert.equal(await controller.send("Question", []), true);
      await waitFor(controller, (state) => state.pending.length === 0);
      const reply = (await readLatest(store)).messages.at(-1);
      assert.equal(reply.status, "cancelled");
      assert.equal(reply.text, "Half an ans");
      assert.equal(reply.error, reason);
    } finally {
      await controller.dispose();
      sqlite.close();
    }
  }
});

test("retrying the latest finished reply replaces it in the same row", async () => {
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => ({
    text: `Answer ${++calls}`,
    model: "test/model",
    cost: 0,
    stopped: null,
  }));
  try {
    await controller.send("Question", []);
    await waitFor(controller, (state) => state.pending.length === 0);
    const first = (await readLatest(store)).messages.at(-1);
    assert.equal(first.text, "Answer 1");
    assert.equal(await controller.retryReply(first.id), true);
    await waitFor(controller, (state) => state.pending.length === 0);
    const { messages } = await readLatest(store);
    assert.equal(messages.length, 2);
    assert.equal(messages.at(-1).id, first.id);
    assert.equal(messages.at(-1).text, "Answer 2");
    assert.equal(messages.at(-1).status, "complete");
  } finally {
    await controller.dispose();
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
