import assert from "node:assert/strict";
import test from "node:test";
import {
  API_KEY_STORAGE_KEY,
  createOpenRouterConnection,
  readSavedKey,
} from "../src/connections/openrouter.ts";
import {
  createPreferences,
  readPreferences,
} from "../src/preferences/preferences.ts";
import { connect } from "./sqlite-helper.mjs";

const key = "sk-or-1111111111111111";
function stores() {
  const secrets = new Map();
  const secure = {
    get: async (k) => secrets.get(k) ?? null,
    set: async (k, v) => {
      secrets.set(k, v);
    },
    remove: async (k) => secrets.delete(k),
  };
  return { secrets, secure };
}

// One startup up to the point where preferences are read: the order of
// `openResources`, against real SQLite.
async function start(stores_, database, systemLanguage = "uk") {
  const apiKey = await readSavedKey(stores_.secure);
  await database.store.initialize({ systemLanguage });
  return {
    apiKey,
    ...(await readPreferences(database.database)),
  };
}
test("a fresh installation starts from the system language; an explicit device default is kept", async () => {
  const stores_ = stores();
  const database = connect();
  assert.deepEqual(await start(stores_, database, "sv"), {
    apiKey: "",
    defaultModel: "openrouter/free",
    speechLanguage: "sv",
  });
  const preferences = createPreferences(database.database, {
    defaultModel: "openrouter/free",
    speechLanguage: "sv",
  });
  await preferences.saveSpeechLanguage(null);
  assert.equal(preferences.state.getState().speechLanguage, null);
  assert.equal((await start(stores_, database, "sv")).speechLanguage, null);
});

test("model saves never touch secure storage; key removal stays removed on reopening", async () => {
  const stores_ = stores();
  const database = connect();
  const initial = await start(stores_, database);
  const connection = createOpenRouterConnection(stores_.secure);
  await connection.read();
  const preferences = createPreferences(database.database, initial);
  await connection.save(key);
  await preferences.saveDefaultModel("custom/model");
  assert.deepEqual([...stores_.secrets], [[API_KEY_STORAGE_KEY, key]]);
  assert.equal((await start(stores_, database)).defaultModel, "custom/model");
  await preferences.saveDefaultModel(" ");
  await connection.save("");
  assert.deepEqual(await start(stores_, database), {
    apiKey: "",
    defaultModel: "openrouter/free",
    speechLanguage: "uk",
  });
});

test("connection state publishes presence and revision, never the key", async () => {
  const stores_ = stores();
  stores_.secrets.set(API_KEY_STORAGE_KEY, key);
  const connection = createOpenRouterConnection(stores_.secure);
  assert.deepEqual(connection.state.getState(), {
    status: "reading",
    revision: 0,
  });
  assert.equal(connection.capture(), null, "an unread key isn't sent");
  await connection.read();
  assert.deepEqual(connection.state.getState(), {
    status: "ready",
    connected: true,
    revision: 0,
  });
  const captured = connection.capture();
  await connection.save("");
  assert.deepEqual(connection.state.getState(), {
    status: "ready",
    connected: false,
    revision: 1,
  });
  assert.equal(captured.apiKey, key, "an admitted request keeps its key");
  assert.equal(connection.capture(), null);
  assert.equal(
    JSON.stringify(connection.state.getState()).includes(key),
    false,
  );
});

test("an unreadable saved key is a failure, kept unchanged until read again", async () => {
  const stores_ = stores();
  stores_.secrets.set(API_KEY_STORAGE_KEY, ` ${key}`);
  const connection = createOpenRouterConnection(stores_.secure);
  await connection.read();
  const failed = connection.state.getState();
  assert.equal(failed.status, "failed");
  assert.match(failed.failure.message, /invalid/);
  assert.equal(connection.capture(), null);
  await assert.rejects(connection.save(key), /isn’t read yet/);
  assert.equal(stores_.secrets.get(API_KEY_STORAGE_KEY), ` ${key}`);
  stores_.secrets.set(API_KEY_STORAGE_KEY, key);
  await connection.reload();
  assert.deepEqual(connection.state.getState(), {
    status: "ready",
    connected: true,
    revision: 0,
  });
  assert.equal(connection.capture().apiKey, key);
});

test("rapid writes remain ordered and a failed write does not block later saves", async () => {
  const database = connect();
  const initial = await start(stores(), database);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const writes = [];
  const preferences = createPreferences(
    {
      run: async (operation) =>
        database.database.run(async (db) => {
          const result = await operation(db);
          const { defaultModel } = await readPreferences({
            run: (read) => read(db),
          });
          writes.push(defaultModel);
          if (defaultModel === "first") {
            await pending;
            throw new Error("disk");
          }
          return result;
        }),
    },
    initial,
  );
  const first = preferences.saveDefaultModel("first");
  const failed = assert.rejects(first, /disk/);
  const second = preferences.saveDefaultModel("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["first"]);
  release();
  await failed;
  await second;
  assert.deepEqual(writes, ["first", "second"]);
  assert.equal(preferences.state.getState().defaultModel, "second");
  assert.equal(
    (await readPreferences(database.database)).defaultModel,
    "second",
  );
});

test("invalid saved keys and preference rows block startup with their data kept", async () => {
  const invalid = stores();
  invalid.secrets.set(API_KEY_STORAGE_KEY, ` ${key}`);
  await assert.rejects(start(invalid, connect()), /invalid/);
  assert.equal(invalid.secrets.get(API_KEY_STORAGE_KEY), ` ${key}`);

  const damaged = connect();
  await start(stores(), damaged);
  damaged.sqlite.exec("UPDATE preferences SET default_model = ' padded'");
  await assert.rejects(start(stores(), damaged), /invalid/);
});

test("closing storage finishes accepted preference saves before a replacement reads, then refuses writes", async () => {
  const stores_ = stores();
  const database = connect();
  const old = createPreferences(
    database.database,
    await start(stores_, database),
  );
  const oldConnection = createOpenRouterConnection(stores_.secure);
  const accepted = old.saveDefaultModel("accepted/model");
  const closed = Promise.all([
    oldConnection.retire(),
    database.database.close(),
  ]);
  await assert.rejects(old.saveDefaultModel("late/model"), /closed/);
  await assert.rejects(oldConnection.save(key), /closed/);
  await Promise.all([accepted, closed]);
  assert.equal(old.state.getState().defaultModel, "accepted/model");
  assert.equal(
    database.sqlite
      .prepare("SELECT default_model AS model FROM preferences")
      .get().model,
    "accepted/model",
  );
});
