import type { SQLiteDatabase } from "expo-sqlite";
import { planHistory } from "../migrations/index.ts";

type Database = Pick<
  SQLiteDatabase,
  | "execAsync"
  | "getFirstAsync"
  | "getAllAsync"
  | "runAsync"
  | "withExclusiveTransactionAsync"
>;
type Source = { systemLanguage: string | null };

// The steps that bring this database to the current version, and whether it
// already holds anything. Rejects a version that can't be upgraded.
async function plan(
  db: Pick<Database, "getFirstAsync">,
  source: Source,
): Promise<{ steps: ReturnType<typeof planHistory>; populated: boolean }> {
  const version = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version",
  );
  const objects = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  const populated = (objects?.count ?? 0) > 0;
  return {
    steps: planHistory(
      { version: version?.user_version ?? 0, populated },
      source,
    ),
    populated,
  };
}

// Brings the history database to the current version before any other storage
// access, in one transaction: an empty database is created, a supported one is
// upgraded step by step, a current one is left alone, and any other is
// rejected unchanged. A step that fails, or leaves a dangling reference, rolls
// back every step and the version together.
//
// Before a populated database is upgraded, a complete copy of it is written to
// the path `backupPath` returns, which must be free. A copy that can't be
// written stops the upgrade.
export async function openHistory(
  db: Database,
  source: Source,
  backupPath: () => string,
) {
  await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const before = await plan(db, source);
  if (!before.steps.length) return;
  if (before.populated) await db.runAsync("VACUUM INTO ?", backupPath());
  await db.withExclusiveTransactionAsync(async (tx) => {
    const { steps } = await plan(tx, source);
    for (const step of steps) {
      for (const { sql, params } of step.statements)
        await tx.runAsync(sql, ...params);
      await tx.execAsync(`PRAGMA user_version = ${step.version}`);
    }
    const dangling = await tx.getAllAsync("PRAGMA foreign_key_check");
    if (dangling.length)
      throw new Error(
        `The history upgrade left dangling references: ${JSON.stringify(dangling)}`,
      );
  });
}
