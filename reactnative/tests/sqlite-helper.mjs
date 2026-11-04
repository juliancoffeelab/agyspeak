import { DatabaseSync } from "node:sqlite";
import { HistoryStore } from "../src/chat/history.ts";

// Run the production queries against real SQLite without an Android runtime.
export function connect(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  let failNextRead = false;
  const queries = [];
  const db = {
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
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        await action(db);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    store: new HistoryStore(db),
    sqlite,
    queries,
    failRead: () => {
      failNextRead = true;
    },
  };
}

export async function appendTurn(store, id, text, reply, now) {
  const pending = await store.beginReply(id, text, "test/model", now);
  return store.finishReply(pending.messages.at(-1).id, "complete", reply, null);
}
