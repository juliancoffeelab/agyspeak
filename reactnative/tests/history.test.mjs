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
} from "./sqlite-helper.mjs";

test("history persists across reopening; switching and new chat preserve messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agyspeak-history-"));
  let connection = connect(join(dir, "history.db"));
  try {
    await connection.store.initialize();
    assert.deepEqual(await readHistory(connection.store), {
      chats: [],
      activeId: "chat",
      selectedModel: null,
      messages: [],
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
    let saved = await readHistory(connection.store);
    assert.equal(saved.activeId, "chat", "startup opens the new chat");
    assert.deepEqual(
      saved.chats.map((chat) => chat.id),
      ["second", "first"],
    );
    saved = await connection.store.activate("first");
    assert.deepEqual(
      saved.chat.messages.map((message) => message.text),
      ["What's up?\n你好", "A reply"],
    );
    saved = await appendTurn(
      connection.store,
      "first",
      "Follow up",
      "More text",
      3000,
    );
    // The new chat is listed first, untitled; saved chats follow, newest first.
    assert.deepEqual(
      saved.chats.map(({ id, title }) => [id, title]),
      [
        ["chat", null],
        ["first", "What's up? 你好"],
        ["second", "Another chat"],
      ],
    );
    assert.equal(saved.chat.messages.length, 4);
  } finally {
    connection.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a chat cascades to its messages and clears active selection only when needed", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "first", "Keep", "Reply", 1);
    await appendTurn(store, "second", "Delete", "Reply", 2);
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
      messages: [],
    });
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("a failed reply insert rolls back the entire turn and selection", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "existing", "Keep me", "Original", 1);
    const before = await readHistory(store);
    sqlite.exec(`CREATE TRIGGER fail_reply BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END;`);
    await assert.rejects(appendTurn(store, before.activeId, "Lost?", "No", 2));
    assert.deepEqual(await readHistory(store), before);
    await assert.rejects(appendTurn(store, "existing", "More?", "No", 3));
    assert.deepEqual(await readHistory(store), before);
  } finally {
    sqlite.close();
  }
});

test("future database versions are rejected without resetting data", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, "existing", "Keep me", "Original", 1);
    sqlite.exec("PRAGMA user_version = 16");
    await assert.rejects(store.initialize(), /Unsupported/);
    assert.equal((await readLatest(store)).messages.length, 2);
  } finally {
    sqlite.close();
  }
});

for (const existingChat of [false, true]) {
  test(`snapshot failure rolls back a ${existingChat ? "follow-up" : "new chat"} and retry saves once`, async () => {
    const { store, sqlite, failRead } = connect();
    try {
      await store.initialize();
      if (existingChat)
        await appendTurn(store, "chat", "Original", "First reply", 1);
      else await store.seedChat("chat");
      const before = await savedChats(store);
      failRead();
      await assert.rejects(
        store.beginReply(
          "chat",
          { kind: "text", text: "Hello", photos: [] },
          "test/model",
          2,
        ),
        /snapshot read failure/,
      );
      assert.deepEqual(await savedChats(store), before);
      const saved = await appendTurn(store, "chat", "Hello", "Reply", 2);
      assert.deepEqual(
        (await savedChats(store)).map((chat) => chat.id),
        ["chat"],
      );
      assert.deepEqual(
        saved.chat.messages.map((message) => message.text),
        [
          ...(existingChat ? ["Original", "First reply"] : []),
          "Hello",
          "Reply",
        ],
      );
    } finally {
      sqlite.close();
    }
  });
}

test("startup marks replies the app closed before finishing as failed", async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await store.seedChat("chat");
    await store.beginReply(
      "chat",
      { kind: "text", text: "Interrupted request", photos: [] },
      "test/model",
      2,
    );
    await store.initialize();
    const saved = await readLatest(store);
    assert.equal(saved.messages.at(-1).status, "failed");
    assert.match(saved.messages.at(-1).error, /app closed/);
  } finally {
    sqlite.close();
  }
});

test("audio survives completion and failed snapshots", async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    const audio = { data: "UklGRg==", format: "wav" };
    await store.seedChat("voice");
    const pending = await store.beginReply(
      "voice",
      { kind: "audio", audio: audio },
      "google/gemini-3.8-flash",
      2,
    );
    const id = pending.replyId;
    failRead();
    await assert.rejects(
      store.finishReply(id, {
        status: "complete",
        text: "Hello",
        error: null,
        model: null,
        elapsedMillis: null,
      }),
      /snapshot/,
    );
    let saved = await readLatest(store);
    assert.deepEqual(saved.messages[0].audio, {
      id: saved.messages[0].id,
      encodedLength: audio.data.length,
      format: audio.format,
    });
    assert.equal(saved.messages[1].status, "pending");
    saved = await store.finishReply(id, {
      status: "complete",
      text: "Hello",
      error: null,
      model: null,
      elapsedMillis: null,
    });
    assert.deepEqual(saved.chat.messages[0].audio, {
      id: saved.chat.messages[0].id,
      encodedLength: audio.data.length,
      format: audio.format,
    });
    assert.equal(saved.chat.messages[0].text, "Voice message");
    assert.equal(saved.chat.messages[1].status, "complete");
  } finally {
    sqlite.close();
  }
});

test("display snapshots never read recording bytes; request context loads only selected audio", async () => {
  const { store, sqlite, queries } = connect();
  try {
    await store.initialize();
    const audio = {
      data: "A".repeat(6 * 1024 * 1024),
      format: "m4a",
      durationMillis: 1000,
      levels: Array.from({ length: 800 }, (_, i) => i / 800),
    };
    await store.seedChat("voice");
    for (let i = 0; i < 4; i++) await appendVoice();
    async function appendVoice() {
      const pending = await store.beginReply(
        "voice",
        { kind: "audio", audio: audio },
        "selected/model",
        1,
      );
      await store.finishReply(pending.replyId, {
        status: "complete",
        text: "Reply",
        error: null,
        model: null,
        elapsedMillis: null,
      });
    }
    const saved = await readLatest(store);
    assert.equal(saved.messages.filter((message) => message.audio).length, 4);
    assert.ok(
      JSON.stringify(saved).length < 10_000,
      "UI state contains metadata only",
    );
    assert.equal(saved.messages[0].audio.levels.length, 32);
    assert.ok(
      !queries.some((query) => /audio_data/.test(query.sql)),
      "display and mutation snapshots never select raw audio",
    );
    const context = await store.readContext("voice");
    assert.equal(context.filter((message) => message.audio).length, 2);
    assert.ok(
      context
        .filter((message) => message.audio)
        .every((message) => message.audio.data === audio.data),
    );
    const reads = queries.filter((query) => /audio_data/.test(query.sql));
    assert.equal(reads.length, 1);
    assert.equal(
      reads[0].args.length,
      3,
      "one chat ID and only two selected recording IDs",
    );
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
    assert.equal((await readLatest(second.store)).messages.length, 2);
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
    assert.equal((await readLatest(third.store)).messages.length, 2);
    third.sqlite.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
