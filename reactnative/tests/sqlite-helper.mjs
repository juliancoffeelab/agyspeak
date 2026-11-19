import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatCoordinator } from "../src/features/chat/runtime/coordinator.ts";
import { ChatRepository } from "../src/features/chat/storage/repository.ts";
import { orderedDatabase } from "../src/storage/database.ts";
import { openHistory } from "../src/storage/historyMigration.ts";

// Where the copies made before upgrades go; removed when the tests exit.
const backups = mkdtempSync(join(tmpdir(), "agyspeak-backups-"));
process.on("exit", () => rmSync(backups, { recursive: true, force: true }));
let made = 0;
const backupPath = () => join(backups, `${made++}.db`);

// A new chat gets the next of "chat", "chat-2", "chat-3" and so on that no
// chat has, or had while this connection was open: an id is never reused.
class StartedRepository extends ChatRepository {
  constructor(database, sqlite) {
    let issued = 0;
    super(database, () => {
      const taken = sqlite.prepare("SELECT 1 FROM chats WHERE id = ?");
      for (;;) {
        const id = ++issued === 1 ? "chat" : `chat-${issued}`;
        if (!taken.get(id)) return id;
      }
    });
    this.database = database;
  }
  // Seeds a chat under a chosen id, as if it had been opened as a new chat.
  seedChat(id) {
    return this.database.run((db) =>
      db.runAsync(
        "INSERT OR IGNORE INTO chats (id, title, updated_at, selected_model) VALUES (?, '', 0, NULL)",
        id,
      ),
    );
  }
  // Startup's order: opening the database at its version, then chat recovery.
  async initialize(source = { systemLanguage: null }) {
    await this.database.run((db) => openHistory(db, source, backupPath));
    await super.initialize();
  }
}

// Run the production queries against real SQLite without an Android runtime.
// Expo runs each exclusive transaction on a fresh connection, where foreign
// keys are off; the helper reproduces that on its single connection.
export function connect(
  filename = ":memory:",
  { transactionForeignKeys = 0 } = {},
) {
  const sqlite = new DatabaseSync(filename);
  let failNextRead = false;
  const queries = [];
  const db = {
    closeAsync: async () => {},
    execAsync: async (sql) => sqlite.exec(sql),
    getFirstAsync: async (sql, ...args) =>
      sqlite.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => {
      queries.push({ sql, args });
      if (failNextRead) {
        failNextRead = false;
        throw new Error("Simulated snapshot read failure");
      }
      return sqlite.prepare(sql).all(...args);
    },
    runAsync: async (sql, ...args) => {
      const result = sqlite.prepare(sql).run(...args);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    withExclusiveTransactionAsync: async (action) => {
      const enforced = sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys;
      sqlite.exec(
        `PRAGMA foreign_keys = ${transactionForeignKeys}; BEGIN IMMEDIATE`,
      );
      try {
        await action(db);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        sqlite.exec(`PRAGMA foreign_keys = ${enforced}`);
      }
    },
  };
  const database = orderedDatabase(db);
  return {
    store: new StartedRepository(database, sqlite),
    database,
    sqlite,
    queries,
    failRead: () => {
      failNextRead = true;
    },
  };
}

export async function appendTurn(store, id, text, reply, now) {
  await store.seedChat(id);
  const pending = await store.beginReply(
    id,
    { kind: "text", text: text, photos: [] },
    "test/model",
    now,
  );
  return store.finishReply(pending.replyId, {
    status: "complete",
    text: reply,
    error: null,
    model: null,
    elapsedMillis: null,
  });
}

// Startup history opened at an explicit chat, rather than at the new chat.
export async function startAt(store, id) {
  const { chats, chat } = await store.activate(id);
  return {
    chats: chats.filter((listed) => listed.title !== null),
    activeId: chat.id,
    messages: chat.messages,
    selectedModel: chat.selectedModel,
  };
}

// The saved chats, newest first: those a first message has titled.
export async function savedChats(store) {
  return (await store.readChats()).chats.filter((chat) => chat.title !== null);
}

// What startup opens, the new chat, with the saved chats.
export async function readHistory(store) {
  const { id, selectedModel } = await store.readNewChat();
  return {
    chats: await savedChats(store),
    activeId: id,
    messages: [],
    selectedModel,
  };
}

// The most recently updated saved chat, as `startAt` opens it; the new chat
// when none is saved.
export async function readLatest(store) {
  const id = await latestId(store);
  return id === null ? readHistory(store) : startAt(store, id);
}

// The most recently updated saved chat's id; null when none is saved.
export async function latestId(store) {
  return (await savedChats(store))[0]?.id ?? null;
}

// A coordinator started as the app starts it, on the new chat with the saved
// chats listed, then opened at `openAt`. A test names only what it is about.
export async function coordinator({ openAt, ...options }) {
  const controller = new ChatCoordinator({
    newChat: await options.store.readNewChat(),
    reply: () => new Promise(() => {}),
    audioIssue: () => null,
    imageIssue: () => null,
    now: () => performance.now(),
    ...options,
  });
  await controller.loadChats();
  if (openAt !== null) await controller.select(openAt);
  return controller;
}
