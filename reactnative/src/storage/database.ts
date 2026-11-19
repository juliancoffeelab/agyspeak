import type { SQLiteDatabase } from "expo-sqlite";

export type Connection = Pick<
  SQLiteDatabase,
  | "execAsync"
  | "getFirstAsync"
  | "getAllAsync"
  | "runAsync"
  | "withExclusiveTransactionAsync"
  | "closeAsync"
>;

// The one ordering authority for a connection. Every operation whose order
// matters runs through `run`, one at a time. Code inside an operation uses the
// connection it receives and never calls `run` again: awaiting the queue it
// holds would deadlock.
export type OrderedDatabase = {
  run<T>(operation: (db: Connection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function orderedDatabase(db: Connection): OrderedDatabase {
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;
  return {
    run(operation) {
      if (closing) return Promise.reject(new Error("Storage is closed."));
      const result = tail.then(() => operation(db));
      tail = result.catch(() => undefined);
      return result;
    },
    close() {
      closing ??= tail.then(() => db.closeAsync());
      return closing;
    },
  };
}
