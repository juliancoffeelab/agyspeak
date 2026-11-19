import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { historyRows } from "../src/migrations/index.ts";
import { connect, readHistory } from "./sqlite-helper.mjs";

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

test("an empty database is created at the current version, with the baseline's schema", async () => {
  const { store, sqlite } = connect();
  await store.initialize({ systemLanguage: "uk" });
  assert.equal(version(sqlite), 15);
  // No chat is made until one is opened.
  assert.deepEqual(cells(sqlite).chats, []);
  assert.equal(schema(sqlite), schema(seeded(baseline).sqlite));
  assert.deepEqual((await readHistory(store)).messages, []);
  // A fresh installation reads aloud in the system language.
  assert.deepEqual(cells(sqlite).preferences, [
    { id: 1, default_model: "openrouter/free", speech_language: "uk" },
  ]);
  assertRowTypes(sqlite);
});

test("the baseline database opens with every row kept and its new chat found", async () => {
  const { store, sqlite } = seeded(baseline);
  const before = cells(sqlite);
  await store.initialize();
  assert.equal(version(sqlite), 15);
  const after = cells(sqlite);
  // Recovery fails the reply the app closed before finishing.
  assert.match(after.messages[5].error, /app closed/);
  after.messages[5] = before.messages[5];
  assert.deepEqual(after, before);
  assertRowTypes(sqlite);
  // Startup opens the chat nothing was sent in, with its model and draft.
  const stored = cells(sqlite);
  assert.deepEqual(await store.readNewChat(), {
    id: "d040f704c42df3fe7154f42b3a647daf",
    selectedModel: "draft/model",
    draft: { text: "  new chat draft\n", photos: [] },
  });
  assert.deepEqual(cells(sqlite), stored, "opening it creates nothing");
});

test("other versions and unversioned tables are rejected unchanged", async () => {
  for (const [setup, error] of [
    [baseline.replace(/user_version = 15/, "user_version = 14"), /version 14/],
    [baseline.replace(/user_version = 15/, "user_version = 16"), /version 16/],
    [baseline.replace(/PRAGMA user_version = 15;/, ""), /no version/],
  ]) {
    const { store, sqlite } = seeded(setup);
    const before = JSON.stringify([version(sqlite), cells(sqlite)]);
    await assert.rejects(store.initialize(), error);
    assert.equal(JSON.stringify([version(sqlite), cells(sqlite)]), before);
  }
});
