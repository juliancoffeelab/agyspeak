import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONTEXT_FLOOR,
  loadTokenizer,
} from "../src/features/chat/runtime/compaction.ts";
import { ChatWorkspace } from "../src/features/chat/runtime/workspace.ts";
import { ChatRepository } from "../src/features/chat/storage/repository.ts";
import { orderedDatabase } from "../src/storage/database.ts";
import { openHistory } from "../src/storage/historyMigration.ts";

// The app loads it with a chat's resources.
await loadTokenizer();

// Where the copies made before upgrades go; removed when the tests exit.
export const backups = mkdtempSync(join(tmpdir(), "agyspeak-backups-"));
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
    // Rows are plain objects, as Expo's are.
    getFirstAsync: async (sql, ...args) => {
      const row = sqlite.prepare(sql).get(...args);
      return row ? { ...row } : null;
    },
    getAllAsync: async (sql, ...args) => {
      queries.push({ sql, args });
      if (failNextRead) {
        failNextRead = false;
        throw new Error("Simulated snapshot read failure");
      }
      return sqlite
        .prepare(sql)
        .all(...args)
        .map((row) => ({ ...row }));
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

// Appends a sent message and its complete reply to chat `id`, made when
// it doesn't exist yet.
export async function appendTurn(store, id, text, reply, now) {
  await store.seedChat(id);
  const { chat } = await store.activate(id);
  return store.writeLog(
    id,
    chat.log.length,
    [
      { kind: "user", text, audio: null, photos: [], postedAt: now },
      {
        kind: "reply",
        status: "complete",
        text: reply,
        ending: null,
        providerMessage: null,
        model: null,
        usage: null,
        maxTokens: null,
        compaction: null,
        postedAt: now,
        elapsedMillis: null,
      },
    ],
    null,
    "test/model",
    now,
  );
}

// Startup history opened at an explicit chat, rather than at the new chat.
export async function startAt(store, id) {
  const { chats, chat } = await store.activate(id);
  return {
    chats: chats.filter((listed) => listed.title !== null),
    activeId: chat.id,
    log: chat.log,
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
    log: [],
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

// Node has no display: a frame is the next turn of its event loop.
globalThis.requestAnimationFrame = (run) => setTimeout(run, 0);

// A workspace started as the app starts it, on the new chat with the saved
// chats listed, then opened at `openAt`. A test names only what it is about.
export async function workspace({ openAt, store, models, ...options }) {
  const opened = new ChatWorkspace({
    store,
    newChat: await store.readNewChat(),
    reply: () => new Promise(() => {}),
    apiKey: () => "test-key",
    defaultModel: () => "test/model",
    now: Date.now,
    ...options,
    models: {
      // A model with the smallest window a chat works within, so a test runs
      // at the size it was written for whatever the cap is.
      contextLength: () => CONTEXT_FLOOR,
      maxOutput: () => 1_000_000,
      // Nor an alias: it answers as itself.
      answering: (model) => model,
      audioIssue: () => null,
      imageIssue: () => null,
      ...models,
    },
  });
  await opened.loadChats();
  if (openAt !== null) await opened.select(openAt);
  return opened;
}

// Usage a mocked reply reports: none.
export const NO_USAGE = {
  costUSD: null,
  promptTokens: null,
  completionTokens: null,
  cachedPromptTokens: null,
  cacheWritePromptTokens: null,
};

// A reply port whose requests wait until a test answers or fails them. A
// stopped request is rejected as the transport rejects it.
export function replies() {
  const requests = [];
  const reply = (messages, settings, signal, onText) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      requests.push({
        messages,
        settings,
        signal,
        onText,
        answer: (text, model = settings.model, stopped = null) =>
          resolve({ text, model, usage: NO_USAGE, stopped }),
        fail: reject,
      });
    });
  return { reply, requests };
}

// What runs after a settled promise has.
export const tick = () => new Promise((resolve) => setImmediate(resolve));

// The open chat's machine state.
export const openChat = (workspace) =>
  workspace.state.getState().open.getState().chat;
