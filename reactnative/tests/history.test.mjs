import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HistoryStore } from '../src/chat/history.ts';

// Run the production queries against real SQLite without an Android runtime.
function connect(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  let failNextRead = false;
  const db = {
    execAsync: async sql => sqlite.exec(sql),
    getFirstAsync: async (sql, ...args) => sqlite.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => {
      if (failNextRead) { failNextRead = false; throw new Error('Simulated snapshot read failure'); }
      return sqlite.prepare(sql).all(...args);
    },
    runAsync: async (sql, ...args) => sqlite.prepare(sql).run(...args),
    withExclusiveTransactionAsync: async action => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { await action(db); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { store: new HistoryStore(db), sqlite, failRead: () => { failNextRead = true; } };
}

test('history persists across reopening; switching and new chat preserve messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agyspeak-history-'));
  let connection = connect(join(dir, 'history.db'));
  try {
    await connection.store.initialize();
    assert.deepEqual(await connection.store.read(), { chats: [], activeId: null, messages: [] });
    await connection.store.appendTurn('first', "What's up?\n你好", 'A reply', 1000);
    await connection.store.select(null);
    assert.equal((await connection.store.read()).chats.length, 1);
    await connection.store.appendTurn('second', 'Another chat', 'Second reply', 2000);
    connection.sqlite.close();
    connection = connect(join(dir, 'history.db'));
    await connection.store.initialize();
    let saved = await connection.store.read();
    assert.equal(saved.activeId, 'second');
    assert.deepEqual(saved.chats.map(chat => chat.id), ['second', 'first']);
    saved = await connection.store.select('first');
    assert.deepEqual(saved.messages.map(message => message.text), ["What's up?\n你好", 'A reply']);
    saved = await connection.store.appendTurn('first', 'Follow up', 'More text', 3000);
    assert.equal(saved.chats[0].title, "What's up? 你好");
    assert.equal(saved.chats[0].id, 'first');
    assert.equal(saved.messages.length, 4);
  } finally {
    connection.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleting a chat cascades to its messages and clears active selection only when needed', async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await store.appendTurn('first', 'Keep', 'Reply', 1);
    await store.appendTurn('second', 'Delete', 'Reply', 2);
    await store.remove('first');
    assert.equal((await store.read()).activeId, 'second');
    await store.remove('second');
    assert.deepEqual(await store.read(), { chats: [], activeId: null, messages: [] });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  } finally { sqlite.close(); }
});

test('a failed reply insert rolls back the entire turn and selection', async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await store.appendTurn('existing', 'Keep me', 'Original', 1);
    const before = await store.read();
    sqlite.exec(`CREATE TRIGGER fail_reply BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END;`);
    await assert.rejects(store.appendTurn('new', 'Lost?', 'No', 2));
    assert.deepEqual(await store.read(), before);
    await assert.rejects(store.appendTurn('existing', 'More?', 'No', 3));
    assert.deepEqual(await store.read(), before);
  } finally { sqlite.close(); }
});

test('future database versions are rejected without resetting data', async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await store.appendTurn('existing', 'Keep me', 'Original', 1);
    sqlite.exec('PRAGMA user_version = 2');
    await assert.rejects(store.initialize(), /Unsupported/);
    assert.equal((await store.read()).messages.length, 2);
  } finally { sqlite.close(); }
});

for (const existingChat of [false, true]) {
  test(`snapshot failure rolls back a ${existingChat ? 'follow-up' : 'new chat'} and retry saves once`, async () => {
    const { store, sqlite, failRead } = connect();
    try {
      await store.initialize();
      if (existingChat) await store.appendTurn('chat', 'Original', 'First reply', 1);
      const before = await store.read();
      failRead();
      await assert.rejects(store.appendTurn('chat', 'Hello', 'Reply', 2), /snapshot read failure/);
      assert.deepEqual(await store.read(), before);
      const saved = await store.appendTurn('chat', 'Hello', 'Reply', 2);
      assert.equal(saved.chats.length, 1);
      assert.deepEqual(saved.messages.map(message => message.text), [
        ...(existingChat ? ['Original', 'First reply'] : []), 'Hello', 'Reply',
      ]);
    } finally { sqlite.close(); }
  });
}
