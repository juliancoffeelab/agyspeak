import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connect,
  appendTurn,
  readHistory,
  readLatest,
  savedChats,
  startAt,
} from "./sqlite-helper.mjs";

const texts = (log) =>
  log.map((entry) => (entry.kind === "compaction" ? null : entry.text));
const reply = (text) => ({
  kind: "reply",
  status: "complete",
  text,
  ending: null,
  providerMessage: null,
  model: null,
  usage: null,
  maxTokens: null,
  compaction: null,
  postedAt: 2,
  elapsedMillis: null,
});
const voice = (key, audio) => ({
  kind: "user",
  text: "",
  audio: {
    key,
    format: audio.format,
    encodedLength: audio.data.length,
    durationMillis: 1000,
    levels: null,
  },
  photos: [],
  postedAt: 1,
});

test("history persists across reopening; switching and new chat preserve messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agyspeak-history-"));
  let connection = connect(join(dir, "history.db"));
  try {
    await connection.store.initialize();
    assert.deepEqual(await readHistory(connection.store), {
      chats: [],
      activeId: "chat",
      selectedModel: null,
      log: [],
    });
    await appendTurn(
      connection.store,
      "first",
      "What's up?\n你好",
      "A reply",
      1000,
    );
    await connection.store.activateNew();
    assert.equal((await readHistory(connection.store)).chats.length, 1);
    await appendTurn(
      connection.store,
      "second",
      "Another chat",
      "Second reply",
      2000,
    );
    connection.sqlite.close();
    connection = connect(join(dir, "history.db"));
    await connection.store.initialize();
    const saved = await readHistory(connection.store);
    assert.equal(saved.activeId, "chat", "startup opens the new chat");
    assert.deepEqual(
      saved.chats.map((chat) => chat.id),
      ["second", "first"],
    );
    assert.deepEqual(
      texts((await connection.store.activate("first")).chat.log),
      ["What's up?\n你好", "A reply"],
    );
    const list = await appendTurn(
      connection.store,
      "first",
      "Follow up",
      "More text",
      3000,
    );
    // The new chat is listed first, untitled; saved chats follow, newest first.
    assert.deepEqual(
      list.chats.map(({ id, title }) => [id, title]),
      [
        ["chat", null],
        ["first", "What's up? 你好"],
        ["second", "Another chat"],
      ],
    );
    assert.equal((await connection.store.activate("first")).chat.log.length, 4);
  } finally {
    connection.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a chat deletes its entries and media, and the new chat stays", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "first", "Keep", "Reply", 1);
    await appendTurn(store, "second", "Delete", "Reply", 2);
    await store.addRecording("first", "UklGRg==");
    await store.remove("first");
    assert.deepEqual(
      (await readHistory(store)).chats.map((chat) => chat.id),
      ["second"],
    );
    await store.remove("second");
    assert.deepEqual(await readHistory(store), {
      chats: [],
      activeId: "chat",
      selectedModel: null,
      log: [],
    });
    for (const table of ["entries", "media"])
      assert.equal(
        sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
        0,
      );
  } finally {
    sqlite.close();
  }
});

test("a failed entry insert rolls back the whole write", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "existing", "Keep me", "Original", 1);
    const before = await startAt(store, "existing");
    sqlite.exec(`CREATE TRIGGER fail_reply BEFORE INSERT ON entries
      WHEN json_extract(NEW.body, '$.kind') = 'reply' BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END;`);
    await assert.rejects(appendTurn(store, "fresh", "Lost?", "No", 2));
    assert.deepEqual(await savedChats(store), before.chats);
    await assert.rejects(appendTurn(store, "existing", "More?", "No", 3));
    assert.deepEqual(await startAt(store, "existing"), before);
    // A write that keeps less than the chat holds replaces what follows.
    await assert.rejects(
      store.writeLog("existing", 3, [], null, "test/model", 4),
      /shorter/,
    );
  } finally {
    sqlite.close();
  }
});

test("future database versions are rejected without resetting data", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "existing", "Keep me", "Original", 1);
    sqlite.exec("PRAGMA user_version = 17");
    await assert.rejects(store.initialize(), /Unsupported/);
    assert.equal((await readLatest(store)).log.length, 2);
  } finally {
    sqlite.close();
  }
});

for (const existingChat of [false, true]) {
  test(`a failed list read rolls back a ${existingChat ? "follow-up" : "new chat"} and a retry saves once`, async () => {
    const { store, sqlite, failRead } = connect();
    try {
      await store.initialize();
      if (existingChat)
        await appendTurn(store, "chat", "Original", "First reply", 1);
      else await store.seedChat("chat");
      const before = await savedChats(store);
      const { log } = await startAt(store, "chat");
      failRead();
      await assert.rejects(
        store.writeLog(
          "chat",
          log.length,
          [
            {
              kind: "user",
              text: "Hello",
              audio: null,
              photos: [],
              postedAt: 2,
            },
            reply("Reply"),
          ],
          null,
          "test/model",
          2,
        ),
        /snapshot read failure/,
      );
      assert.deepEqual(await savedChats(store), before);
      assert.deepEqual((await startAt(store, "chat")).log, log);
      await appendTurn(store, "chat", "Hello", "Reply", 2);
      assert.deepEqual(
        (await savedChats(store)).map((chat) => chat.id),
        ["chat"],
      );
      assert.deepEqual(texts((await startAt(store, "chat")).log), [
        ...(existingChat ? ["Original", "First reply"] : []),
        "Hello",
        "Reply",
      ]);
    } finally {
      sqlite.close();
    }
  });
}

test("a recording is kept by the entry that names it; one no entry names is deleted at startup", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    const audio = { data: "UklGRg==", format: "wav" };
    await store.seedChat("voice");
    const key = await store.addRecording("voice", audio.data);
    const unsent = await store.addRecording("voice", "AAAA");
    await store.writeLog(
      "voice",
      0,
      [voice(key, audio), reply("Hello")],
      null,
      "google/gemini-3.8-flash",
      2,
    );
    const { chats } = await startAt(store, "voice");
    assert.equal(chats[0].title, "Voice message");
    await store.initialize();
    assert.deepEqual(
      await store.readMedia([key]),
      new Map([[key, audio.data]]),
    );
    await assert.rejects(store.readMedia([unsent]), /no longer saved/);
  } finally {
    sqlite.close();
  }
});

test("opening a chat never reads recording bytes; a request reads only the media it names", async () => {
  const { store, sqlite, queries } = connect();
  try {
    await store.initialize();
    const audio = { data: "A".repeat(6 * 1024 * 1024), format: "m4a" };
    await store.seedChat("voice");
    const keys = [];
    for (let i = 0; i < 4; i++) {
      const key = await store.addRecording("voice", audio.data);
      keys.push(key);
      await store.writeLog(
        "voice",
        i * 2,
        [voice(key, audio), reply("Reply")],
        null,
        "selected/model",
        1,
      );
    }
    const saved = await readLatest(store);
    assert.equal(saved.log.filter((entry) => entry.audio).length, 4);
    assert.ok(
      JSON.stringify(saved).length < 10_000,
      "UI state contains metadata only",
    );
    assert.ok(
      !queries.some((query) =>
        /\bdata\b/.test(query.sql.replace(/draft_photos/g, "")),
      ),
      "opening and writing a chat never select media bytes",
    );
    const media = await store.readMedia(keys.slice(2));
    assert.deepEqual([...media.keys()], keys.slice(2));
    assert.ok([...media.values()].every((data) => data === audio.data));
  } finally {
    sqlite.close();
  }
});

test("drafts survive reopening alongside existing conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agyspeak-drafts-"));
  const path = join(directory, "history.db");
  try {
    const first = connect(path);
    await first.store.initialize();
    await appendTurn(first.store, "chat", "Hello", "Hi", 1);
    first.sqlite.close();
    const second = connect(path);
    await second.store.initialize();
    assert.equal((await readLatest(second.store)).log.length, 2);
    await second.store.saveDraft("chat", "  unfinished\n");
    const fresh = (await second.store.readNewChat()).id;
    assert.notEqual(fresh, "chat");
    await second.store.saveDraft(fresh, "new unfinished");
    second.sqlite.close();
    const third = connect(path);
    await third.store.initialize();
    assert.equal(await third.store.readDraft("chat"), "  unfinished\n");
    assert.deepEqual(await third.store.readNewChat(), {
      id: fresh,
      selectedModel: null,
      draft: { text: "new unfinished", photos: [] },
    });
    assert.equal((await readLatest(third.store)).log.length, 2);
    third.sqlite.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
