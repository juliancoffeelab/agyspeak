import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { logIssue } from "../src/features/chat/runtime/log.ts";
import * as v15 from "../src/migrations/history/v15.ts";
import { historyRows } from "../src/migrations/index.ts";
import { backups, connect, readHistory } from "./sqlite-helper.mjs";

// A database at version 15, frozen as the supported baseline.
const baseline = readFileSync(
  new URL("./fixtures/history/v15.sql", import.meta.url),
  "utf8",
);
const seeded = (setup) => {
  const connection = connect();
  connection.sqlite.exec(setup);
  return connection;
};

const version = (sqlite) =>
  sqlite.prepare("PRAGMA user_version").get().user_version;
const tables = (sqlite) =>
  sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
const cells = (sqlite) =>
  Object.fromEntries(
    tables(sqlite).map((name) => [
      name,
      sqlite
        .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
const schema = (sqlite) =>
  JSON.stringify(
    sqlite
      .prepare(
        "SELECT m.name AS tbl, p.* FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY m.name, p.cid",
      )
      .all()
      .concat(
        sqlite
          .prepare(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name",
          )
          .all(),
      ),
  );

// Every table has a row type, and every stored row matches it exactly.
function assertRowTypes(sqlite) {
  assert.deepEqual(tables(sqlite), Object.keys(historyRows).sort());
  for (const [table, rows] of Object.entries(cells(sqlite)))
    for (const row of rows)
      assert.deepEqual(historyRows[table].strict().parse(row), row, table);
}

// The baseline's tables after version 16's declared change: the messages
// and photos tables become a log of entries and the media they name. A
// failed reply with a message after it is dropped; the reply the app closed
// before finishing ends its chat, and is kept as failed.
function upgradedCells(before) {
  const kept = { ...before };
  delete kept.messages;
  delete kept.photos;
  const reply = {
    kind: "reply",
    ending: null,
    providerMessage: null,
    usage: null,
    maxTokens: null,
    compaction: null,
    postedAt: null,
  };
  const entries = [
    [
      "chat-a",
      {
        kind: "user",
        text: "Hello\nthere",
        postedAt: null,
        audio: {
          key: "2",
          format: "wav",
          encodedLength: 16,
          durationMillis: 1200,
          levels: null,
        },
        photos: [{ key: "1", width: 640, height: 480, encodedLength: 20 }],
      },
    ],
    [
      "chat-a",
      {
        ...reply,
        status: "complete",
        text: "Hi! ünïcode",
        model: "vendor/model-a",
        elapsedMillis: 2300,
      },
    ],
    [
      "chat-b",
      {
        kind: "user",
        text: "Second question",
        audio: null,
        photos: [],
        postedAt: null,
      },
    ],
    [
      "chat-b",
      {
        kind: "user",
        text: "Interrupted",
        audio: null,
        photos: [],
        postedAt: null,
      },
    ],
    [
      "chat-b",
      {
        ...reply,
        status: "failed",
        text: "partial",
        model: "vendor/model-b",
        elapsedMillis: null,
        ending: "closed",
      },
    ],
  ];
  return {
    ...kept,
    entries: entries.map(([chat_id, body], index) => ({
      chat_id,
      position: index - entries.findIndex(([chat]) => chat === chat_id),
      body,
    })),
    media: [
      {
        id: 1,
        chat_id: "chat-a",
        data: "/9j/4AAQSkZJRgABAQ==",
        thumbnail: "/9j/thumb",
      },
      { id: 2, chat_id: "chat-a", data: "UklGRiQAAABXQVZF", thumbnail: null },
    ],
  };
}

test("an empty database is created at the current version, with the upgraded baseline's schema", async () => {
  const { store, sqlite } = connect();
  await store.initialize({ systemLanguage: "uk" });
  assert.equal(version(sqlite), 16);
  // No chat is made until one is opened.
  assert.deepEqual(cells(sqlite).chats, []);
  const upgraded = seeded(baseline);
  await upgraded.store.initialize();
  assert.equal(schema(sqlite), schema(upgraded.sqlite));
  assert.deepEqual((await readHistory(store)).log, []);
  // A fresh installation reads aloud in the system language.
  assert.deepEqual(cells(sqlite).preferences, [
    { id: 1, default_model: "openrouter/free", speech_language: "uk" },
  ]);
  assertRowTypes(sqlite);
});

test("the baseline database upgrades with only the declared change, after a copy of it is written", async () => {
  const { store, sqlite } = seeded(baseline);
  const before = cells(sqlite);
  const copies = readdirSync(backups);
  await store.initialize();
  assert.equal(version(sqlite), 16);
  const after = cells(sqlite);
  after.entries = after.entries.map((row) => ({
    ...row,
    body: JSON.parse(row.body),
  }));
  assert.deepEqual(after, upgradedCells(before));
  assertRowTypes(sqlite);
  // The copy is the database as it was before the upgrade.
  const written = readdirSync(backups).filter((name) => !copies.includes(name));
  assert.equal(written.length, 1);
  const copy = connect(join(backups, written[0])).sqlite;
  assert.equal(version(copy), 15);
  assert.deepEqual(cells(copy), before);
  // Startup opens the chat nothing was sent in, with its model and draft.
  const stored = cells(sqlite);
  assert.deepEqual(await store.readNewChat(), {
    id: "d040f704c42df3fe7154f42b3a647daf",
    selectedModel: "draft/model",
    draft: { text: "  new chat draft\n", photos: [] },
  });
  assert.deepEqual(cells(sqlite), stored, "opening it creates nothing");
});

test("the current version opens unchanged, without a copy", async () => {
  const { store, sqlite } = seeded(baseline);
  await store.initialize();
  const before = cells(sqlite);
  const copies = readdirSync(backups);
  await store.initialize();
  assert.equal(version(sqlite), 16);
  assert.deepEqual(cells(sqlite), before);
  assert.deepEqual(readdirSync(backups), copies);
});

test("other versions, unversioned tables and failed upgrades are rejected unchanged", async () => {
  for (const [setup, error] of [
    [baseline.replace(/user_version = 15/, "user_version = 14"), /version 14/],
    [baseline.replace(/user_version = 15/, "user_version = 17"), /version 17/],
    [baseline.replace(/PRAGMA user_version = 15;/, ""), /no version/],
    // A failing statement rolls back the statements before it.
    [`${baseline}\nCREATE TABLE media (id INTEGER);`, /already exists/],
    // The integrity gate rejects a dangling reference foreign keys let through.
    [
      `PRAGMA foreign_keys = OFF;\n${baseline}\nINSERT INTO messages (chat_id, role, text) VALUES ('gone', 'user', 'orphan');`,
      /dangling references/,
    ],
  ]) {
    const { store, sqlite } = seeded(setup);
    const before = JSON.stringify([
      version(sqlite),
      schema(sqlite),
      cells(sqlite),
    ]);
    await assert.rejects(store.initialize(), error);
    assert.equal(
      JSON.stringify([version(sqlite), schema(sqlite), cells(sqlite)]),
      before,
    );
  }
});

// The pending version's undo, for development: it takes a version-16
// database back to version 15, with the losses it declares.
const undo = readFileSync(
  new URL("../src/migrations/history/v16.down.sql", import.meta.url),
  "utf8",
);
// Every schema object's statement, as SQLite keeps it.
const statements = (sqlite) =>
  sqlite
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
    )
    .all()
    .map((row) => ({ ...row }));

test("the undo takes the upgraded baseline back to it, but for the failed reply the upgrade dropped", async () => {
  const fixture = seeded(baseline).sqlite;
  const { store, sqlite } = seeded(baseline);
  await store.initialize();
  sqlite.exec(undo);
  assert.equal(version(sqlite), 15);
  assert.equal(schema(sqlite), schema(fixture));
  // The tables it makes again are, statement for statement, as version 15
  // creates them; the others keep theirs.
  const created = new DatabaseSync(":memory:");
  for (const { sql, params } of v15.create({ systemLanguage: null }))
    created.prepare(sql).run(...params);
  const remade = (sqlite) =>
    statements(sqlite).filter(({ tbl_name }) =>
      ["messages", "photos"].includes(tbl_name),
    );
  assert.deepEqual(remade(sqlite), remade(created));
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  // The declared losses: chat-b's failed reply 4 stays dropped, and the
  // messages after it are renumbered, the reply to 5 with them.
  const expected = cells(fixture);
  expected.messages = expected.messages
    .filter((message) => message.id !== 4)
    .map((message) =>
      message.id < 4
        ? message
        : {
            ...message,
            id: message.id - 1,
            reply_to: message.reply_to === null ? null : message.reply_to - 1,
          },
    );
  assert.deepEqual(cells(sqlite), expected);
});

test("a log the app wrote with a cut reply and a compaction goes back to version 15 and upgrades again", async () => {
  const { store, sqlite } = connect();
  await store.initialize();
  await store.seedChat("cut");
  const recording = await store.addRecording("cut", "UklGRg==");
  await store.addPhotoDraft("cut", [
    { data: "/9j/photo", thumbnail: "/9j/thumb", width: 3, height: 4 },
  ]);
  const { photos } = await store.stagePhotoDraft("cut");
  const reply = {
    kind: "reply",
    ending: null,
    providerMessage: null,
    model: "vendor/model-a",
    usage: null,
    maxTokens: 100,
    compaction: null,
    postedAt: 2,
    elapsedMillis: 1000,
  };
  const user = (text) => ({
    kind: "user",
    text,
    audio: null,
    photos: [],
    postedAt: 1,
  });
  const log = [
    {
      ...user("Long one"),
      audio: {
        key: recording,
        format: "wav",
        encodedLength: 8,
        durationMillis: 900,
        levels: [0.25, 0.5],
      },
      photos,
    },
    { ...reply, status: "cut", text: "First half, " },
    {
      kind: "compaction",
      summary: { text: "Summary", tokens: 3, model: "vendor/model-a" },
      kept: [[{ entry: 0, from: 0, to: 8 }]],
      pass: "final",
      instruction: "Continue.",
    },
    {
      ...reply,
      status: "complete",
      text: "second half.",
      model: "vendor/model-b",
      compaction: 2,
      elapsedMillis: 500,
    },
    user("Next"),
    { ...reply, status: "stopped", text: "partial", ending: "stopped" },
    user("Last"),
    {
      ...reply,
      status: "failed",
      text: "",
      ending: "closed",
      elapsedMillis: null,
    },
  ];
  assert.equal(logIssue(log), null);
  await store.writeLog("cut", 0, log, null, "vendor/model-a", 1);
  sqlite.exec(undo);
  assert.equal(version(sqlite), 15);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  const none = {
    reply_to: null,
    error: null,
    model: null,
    audio_data: null,
    audio_format: null,
    audio_metadata: null,
    audio_length: null,
    elapsed_millis: null,
  };
  const message = (id, role, text, status, fields) => ({
    id,
    chat_id: "cut",
    role,
    text,
    status,
    ...none,
    ...fields,
  });
  // The compaction is gone, and the cut reply's parts are one message.
  assert.deepEqual(cells(sqlite).messages, [
    message(1, "user", "Long one", "complete", {
      audio_data: "UklGRg==",
      audio_format: "wav",
      audio_metadata: '{"durationMillis":900,"levels":[0.25,0.5]}',
      audio_length: 8,
    }),
    message(2, "assistant", "First half, second half.", "complete", {
      reply_to: 1,
      model: "vendor/model-b",
      elapsed_millis: 1500,
    }),
    message(3, "user", "Next", "complete", {}),
    message(4, "assistant", "partial", "cancelled", {
      reply_to: 3,
      error: "Stopped.",
      model: "vendor/model-a",
      elapsed_millis: 1000,
    }),
    message(5, "user", "Last", "complete", {}),
    message(6, "assistant", "", "pending", {
      reply_to: 5,
      model: "vendor/model-a",
    }),
  ]);
  assert.deepEqual(cells(sqlite).photos, [
    {
      id: 1,
      message_id: 1,
      data: "/9j/photo",
      thumbnail: "/9j/thumb",
      width: 3,
      height: 4,
      encoded_length: 9,
    },
  ]);
  await store.initialize();
  assert.equal(version(sqlite), 16);
  const again = sqlite
    .prepare("SELECT body FROM entries WHERE chat_id = 'cut' ORDER BY position")
    .all()
    .map(({ body }) => JSON.parse(body));
  assert.equal(logIssue(again), null);
  assert.deepEqual(
    again.map((entry) => [entry.kind, entry.status ?? null, entry.text]),
    [
      ["user", null, "Long one"],
      ["reply", "complete", "First half, second half."],
      ["user", null, "Next"],
      ["reply", "stopped", "partial"],
      ["user", null, "Last"],
      ["reply", "failed", ""],
    ],
  );
  assertRowTypes(sqlite);
});

// Every sentence the app saved as a reply's error before version 16, as
// git history holds them, a template's up to its first value; and what the
// undo writes.
const APP_SENTENCES = [
  "The app closed before this reply finished.",
  "The app closed before this reply finished. You can retry it.",
  "Stopped.",
  "Stopped. You can retry this reply.",
  "Reply cancelled.",
  "Reply stopped.",
  "Reply failed.",
  "Reached the length limit.",
  "Cut off at this conversation’s length limit.",
  "Cut off: the conversation couldn’t be compacted.",
  "Couldn’t compact this conversation. Retry the compaction to continue.",
  "Couldn’t make room for that message.",
  "The conversation couldn’t be compacted: compact it again or choose another model.",
  "One message in this conversation is too large for this model to summarize. A model with a larger context window can continue it.",
  "The summary reached its length limit.",
  "The summary timed out.",
  "The model wrote an empty summary.",
  "That message doesn’t fit in what’s left of this conversation.",
  "That message is too long for this model.",
  "That recording is too long for this model.",
  "That message is too long. Please keep it under ",
  "This model’s context window is too small for a conversation.",
  "Timed out.",
  "The request timed out.",
  "The request timed out. You can retry it.",
  "The model returned no text.",
  "The model returned no text. You can retry or choose another model.",
  "The model wrote nothing.",
  "The request failed.",
  "The request failed. You can retry it.",
  "Unknown failure.",
  "Couldn’t reach OpenRouter. Check your connection and retry.",
  "OpenRouter returned no response stream.",
  "OpenRouter returned an invalid response stream.",
  "OpenRouter returned an invalid response.",
  "The response stream ended early.",
  "The response stream ended early. You can retry it.",
  "OpenRouter is not connected.",
  "Connect OpenRouter in Settings first.",
  "Choose a model first.",
  "OpenRouter rejected the key. Check it in Settings.",
  "OpenRouter rejected this key.",
  "OpenRouter reports insufficient credits for this model.",
  "The request was rate limited. Try again later.",
  "The model provider is rate limited. Try again later.",
  "No provider is available for this model right now. Try again later.",
  "OpenRouter request failed (HTTP ",
  "OpenRouter answered with an error.",
  "Couldn’t verify ",
  "Audio must be nonempty and under ",
  "Choose an M4A, MP3, WAV, AAC, OGG, FLAC, AIFF, or WebM audio file.",
  "Choose a nonempty audio file under ",
  "Choose a supported audio file under ",
  "Choose a smaller photo (under ",
  "Choose between 1 and ",
  "Choose between one and four photos.",
  "Choose up to ",
  "Keep photos under ",
  "Couldn’t read that photo. Choose it again.",
  "Couldn’t read audio. Please try again.",
  "Invalid audio.",
  "Invalid photos.",
  "Unsupported input.",
  "A photo is missing from this conversation.",
  "A recording is missing from this conversation.",
  "A photo or recording is no longer saved.",
  "Media ",
  "The tokenizer couldn’t be loaded.",
  "The tokenizer isn't loaded.",
  "Gemini returned an invalid voice reply. You can retry it.",
  "No speech or reply was recognized. Try a clearer recording.",
  "Cannot reach your Mac. Check its address, the companion server, and your Wi-Fi or VPN connection.",
  "The Mac did not respond in time. Check that it is awake and reachable. Your message may still be processing.",
  "The Mac returned HTTP ",
  "This address did not return an AGSpeak response. Check your Mac address.",
  "This server version is not compatible with the app.",
];

// Each way version 15 saved how a reply ended: its status, text and error;
// the part the upgrade makes of it, as its status, ending and provider
// message; what the undo gives back, as its status and error; and the
// ending and provider message upgrading that again gives. The last rows
// are a real phone's.
const HTTP_400 = "OpenRouter request failed (HTTP 400).";
const DESERIALIZE =
  "Provider returned error Failed to deserialize the JSON body into the target type";
const REASONING =
  "Reasoning is mandatory for this endpoint and cannot be disabled.";
const PROVIDER = "OpenRouter answered with an error.";
const ENDED = [
  [
    ["cancelled", "part", "Stopped."],
    ["stopped", "stopped", null],
    ["cancelled", "Stopped."],
    ["stopped", null],
  ],
  [
    ["cancelled", "part", null],
    ["stopped", "stopped", null],
    ["cancelled", "Stopped."],
    ["stopped", null],
  ],
  [
    ["cancelled", "part", "Reached the length limit."],
    ["stopped", "length", null],
    ["cancelled", "Reached the length limit."],
    ["length", null],
  ],
  [
    ["cancelled", "part", "Cut off at this conversation’s length limit."],
    ["stopped", "cut-off", null],
    ["cancelled", "Cut off at this conversation’s length limit."],
    ["cut-off", null],
  ],
  [
    ["cancelled", "part", "Timed out."],
    ["stopped", "timeout", null],
    ["cancelled", "Timed out."],
    ["timeout", null],
  ],
  [
    ["cancelled", "", "Timed out."],
    ["failed", "timeout", null],
    ["cancelled", "Timed out."],
    ["timeout", null],
  ],
  [
    ["cancelled", "part", "Cut off: the conversation couldn’t be compacted."],
    ["stopped", "no-compaction", null],
    ["cancelled", "Cut off: the conversation couldn’t be compacted."],
    ["no-compaction", null],
  ],
  [
    ["cancelled", "part", "Something an older version said."],
    ["stopped", "stopped", null],
    ["cancelled", "Stopped."],
    ["stopped", null],
  ],
  [
    ["cancelled", "part", "OpenRouter rejected the key. Check it in Settings."],
    ["stopped", "stopped", null],
    ["cancelled", "Stopped."],
    ["stopped", null],
  ],
  [
    ["complete", "", null],
    ["failed", "empty", null],
    ["complete", null],
    ["empty", null],
  ],
  [
    ["failed", "", "The model returned no text."],
    ["failed", "empty", null],
    ["complete", null],
    ["empty", null],
  ],
  [
    ["pending", "partial", null],
    ["failed", "closed", null],
    ["pending", null],
    ["closed", null],
  ],
  [
    [
      "failed",
      "",
      "The app closed before this reply finished. You can retry it.",
    ],
    ["failed", "closed", null],
    ["pending", null],
    ["closed", null],
  ],
  [
    ["failed", "", null],
    ["failed", "request-failed", null],
    ["failed", "The request failed."],
    ["request-failed", null],
  ],
  [
    [
      "failed",
      "",
      "Couldn’t reach OpenRouter. Check your connection and retry.",
    ],
    ["failed", "request-failed", null],
    ["failed", "The request failed."],
    ["request-failed", null],
  ],
  [
    ["failed", "", "Choose between 1 and 5 photos."],
    ["failed", "request-failed", null],
    ["failed", "The request failed."],
    ["request-failed", null],
  ],
  [
    ["failed", "some", "Rate limited"],
    ["failed", "request-failed", null],
    ["failed", "The request failed."],
    ["request-failed", null],
  ],
  [
    [
      "failed",
      "",
      "Model A doesn’t support audio input. Choose an audio-capable model in Settings.",
    ],
    ["failed", "unsupported-input", null],
    ["failed", "The request failed."],
    ["request-failed", null],
  ],
  [
    [
      "failed",
      "",
      "That message doesn’t fit in what’s left of this conversation.",
    ],
    ["failed", "no-room", null],
    ["failed", "That message doesn’t fit in what’s left of this conversation."],
    ["no-room", null],
  ],
  [
    [
      "failed",
      "",
      "This model’s context window is too small for a conversation.",
    ],
    ["failed", "too-small", null],
    ["failed", "This model’s context window is too small for a conversation."],
    ["too-small", null],
  ],
  [
    ["failed", "", "Couldn’t make room for that message."],
    ["failed", "not-compacted", null],
    ["failed", "Couldn’t make room for that message."],
    ["not-compacted", null],
  ],
  [
    ["failed", "", "The request was rate limited. Try again later. Slow down"],
    ["failed", "provider-error", "Slow down"],
    ["failed", `${PROVIDER} Slow down`],
    ["provider-error", "Slow down"],
  ],
  [
    [
      "failed",
      "",
      "The model provider is rate limited. Try again later. Upstream busy",
    ],
    ["failed", "provider-error", "Upstream busy"],
    ["failed", `${PROVIDER} Upstream busy`],
    ["provider-error", "Upstream busy"],
  ],
  [
    ["failed", "", "OpenRouter request failed (HTTP 500)."],
    ["failed", "provider-error", null],
    ["failed", PROVIDER],
    ["provider-error", null],
  ],
  [
    ["cancelled", "", "Stopped. You can retry this reply."],
    ["failed", "stopped", null],
    ["cancelled", "Stopped."],
    ["stopped", null],
  ],
  [
    [
      "cancelled",
      "",
      "Couldn’t compact this conversation. Retry the compaction to continue.",
    ],
    ["failed", "no-compaction", null],
    ["cancelled", "Cut off: the conversation couldn’t be compacted."],
    ["no-compaction", null],
  ],
  [
    ["failed", "", `${HTTP_400} ${DESERIALIZE}`],
    ["failed", "provider-error", DESERIALIZE],
    ["failed", `${PROVIDER} ${DESERIALIZE}`],
    ["provider-error", DESERIALIZE],
  ],
  [
    ["failed", "", `${HTTP_400} ${REASONING}`],
    ["failed", "provider-error", REASONING],
    ["failed", `${PROVIDER} ${REASONING}`],
    ["provider-error", REASONING],
  ],
];

test("the app's old sentences become endings, and the undo gives them back", async () => {
  const { store, sqlite } = seeded(baseline);
  const insert = (sql, ...values) => sqlite.prepare(sql).run(...values);
  ENDED.forEach(([[status, text, error]], index) => {
    const chat = `ended-${index}`;
    insert(
      "INSERT INTO chats (id, title, updated_at) VALUES (?, 't', 0)",
      chat,
    );
    const asked = insert(
      "INSERT INTO messages (chat_id, role, text) VALUES (?, 'user', 'Q')",
      chat,
    ).lastInsertRowid;
    insert(
      "INSERT INTO messages (chat_id, role, text, status, reply_to, error) VALUES (?, 'assistant', ?, ?, ?, ?)",
      chat,
      text,
      status,
      asked,
      error,
    );
  });
  const replies = () =>
    ENDED.map((_, index) => {
      const { body } = sqlite
        .prepare(
          "SELECT body FROM entries WHERE chat_id = ? ORDER BY position DESC LIMIT 1",
        )
        .get(`ended-${index}`);
      return JSON.parse(body);
    });
  // Every chat's log is one this version writes, and no reply in it, the
  // baseline's included, saves the app's words as the provider's.
  const assertSaved = () => {
    const chats = sqlite.prepare("SELECT id FROM chats").all();
    for (const { id } of chats) {
      const log = sqlite
        .prepare("SELECT body FROM entries WHERE chat_id = ? ORDER BY position")
        .all(id)
        .map(({ body }) => JSON.parse(body));
      assert.equal(logIssue(log), null, id);
      for (const entry of log)
        if (entry.kind === "reply" && entry.providerMessage !== null)
          for (const sentence of APP_SENTENCES)
            assert.ok(
              !entry.providerMessage.startsWith(sentence),
              entry.providerMessage,
            );
    }
  };
  await store.initialize();
  assert.deepEqual(
    replies().map((entry) => [
      entry.status,
      entry.ending,
      entry.providerMessage,
    ]),
    ENDED.map(([, upgraded]) => upgraded),
  );
  assertSaved();
  assertRowTypes(sqlite);
  sqlite.exec(undo);
  assert.deepEqual(
    ENDED.map((_, index) => {
      const { status, error } = sqlite
        .prepare(
          "SELECT status, error FROM messages WHERE chat_id = ? AND role = 'assistant'",
        )
        .get(`ended-${index}`);
      return [status, error];
    }),
    ENDED.map(([, , undone]) => undone),
  );
  await store.initialize();
  assert.deepEqual(
    replies().map((entry) => [entry.ending, entry.providerMessage]),
    ENDED.map(([, , , again]) => again),
  );
  assertSaved();
});
