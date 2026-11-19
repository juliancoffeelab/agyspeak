// The only module application code imports from the migration boundary.
import * as v15 from "./history/v15.ts";

export const HISTORY_VERSION = v15.version;
// The rows each history table holds at the current version.
export type HistoryRows = v15.Rows;
export const historyRows = v15.rows;
export type HistoryStatement = v15.Statement;
// Statements that bring the database to `version`, applied together with it.
export type HistoryStep = {
  version: number;
  statements: readonly HistoryStatement[];
};

// Each supported version's step to the next one, in order. None yet: the
// baseline is the current version.
const upgrades: HistoryStep[] = [];

// What a database needs before the app may use it: nothing at the current
// version, the remaining steps from a supported one, and creation at the v15
// baseline followed by every step when it is empty. Every other version is
// unsupported and rejected unchanged; version 0 counts as empty only without
// any schema.
export function planHistory(
  database: { version: number; populated: boolean },
  source: { systemLanguage: string | null },
): readonly HistoryStep[] {
  const { version, populated } = database;
  if (version === HISTORY_VERSION) return [];
  if (version === 0 && populated)
    throw new Error("The history database has tables but no version.");
  if (version === 0)
    return [
      { version: v15.version, statements: v15.create(source) },
      ...upgrades,
    ];
  if (version < v15.version || version > HISTORY_VERSION)
    throw new Error(`Unsupported history database version ${version}.`);
  return upgrades.filter((step) => step.version > version);
}
