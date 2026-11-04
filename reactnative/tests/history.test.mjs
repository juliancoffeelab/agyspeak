import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, appendTurn } from './sqlite-helper.mjs';

test('history persists across reopening; switching and new chat preserve messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agyspeak-history-'));
  let connection = connect(join(dir, 'history.db'));
  try {
    await connection.store.initialize();
    assert.deepEqual(await connection.store.read(), { chats: [], activeId: null, messages: [] });
    await appendTurn(connection.store, 'first', "What's up?\n你好", 'A reply', 1000);
    await connection.store.select(null);
    assert.equal((await connection.store.read()).chats.length, 1);
    await appendTurn(connection.store, 'second', 'Another chat', 'Second reply', 2000);
    connection.sqlite.close();
    connection = connect(join(dir, 'history.db'));
    await connection.store.initialize();
    let saved = await connection.store.read();
    assert.equal(saved.activeId, 'second');
    assert.deepEqual(saved.chats.map(chat => chat.id), ['second', 'first']);
    saved = await connection.store.select('first');
    assert.deepEqual(saved.messages.map(message => message.text), ["What's up?\n你好", 'A reply']);
    saved = await appendTurn(connection.store, 'first', 'Follow up', 'More text', 3000);
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
    await appendTurn(store, 'first', 'Keep', 'Reply', 1);
    await appendTurn(store, 'second', 'Delete', 'Reply', 2);
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
    await appendTurn(store, 'existing', 'Keep me', 'Original', 1);
    const before = await store.read();
    sqlite.exec(`CREATE TRIGGER fail_reply BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END;`);
    await assert.rejects(appendTurn(store, 'new', 'Lost?', 'No', 2));
    assert.deepEqual(await store.read(), before);
    await assert.rejects(appendTurn(store, 'existing', 'More?', 'No', 3));
    assert.deepEqual(await store.read(), before);
  } finally { sqlite.close(); }
});

test('future database versions are rejected without resetting data', async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await appendTurn(store, 'existing', 'Keep me', 'Original', 1);
    sqlite.exec('PRAGMA user_version = 6');
    await assert.rejects(store.initialize(), /Unsupported/);
    assert.equal((await store.read()).messages.length, 2);
  } finally { sqlite.close(); }
});

for (const existingChat of [false, true]) {
  test(`snapshot failure rolls back a ${existingChat ? 'follow-up' : 'new chat'} and retry saves once`, async () => {
    const { store, sqlite, failRead } = connect();
    try {
      await store.initialize();
      if (existingChat) await appendTurn(store, 'chat', 'Original', 'First reply', 1);
      const before = await store.read();
      failRead();
      await assert.rejects(store.beginReply('chat', 'Hello', 'test/model', 2), /snapshot read failure/);
      assert.deepEqual(await store.read(), before);
      const saved = await appendTurn(store, 'chat', 'Hello', 'Reply', 2);
      assert.equal(saved.chats.length, 1);
      assert.deepEqual(saved.messages.map(message => message.text), [
        ...(existingChat ? ['Original', 'First reply'] : []), 'Hello', 'Reply',
      ]);
    } finally { sqlite.close(); }
  });
}

test('schema migration keeps v1 messages and recovers interrupted pending replies', async () => {
  const { store, sqlite } = connect();
  try {
    sqlite.exec(`CREATE TABLE chats(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL);
      CREATE TABLE app_state(id INTEGER PRIMARY KEY,active_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL);
      INSERT INTO chats VALUES ('old','Old chat',1);
      INSERT INTO messages(chat_id,role,text) VALUES ('old','user','Preserve me');
      INSERT INTO app_state VALUES (1,'old'); PRAGMA user_version=1;`);
    await store.initialize();
    let saved = await store.read();
    assert.equal(saved.messages[0].text, 'Preserve me');
    assert.equal(saved.messages[0].status, 'complete');
    await store.beginReply('old', 'Interrupted request', 'test/model', 2);
    await store.initialize();
    saved = await store.read();
    assert.equal(saved.messages.at(-1).status, 'failed');
    assert.match(saved.messages.at(-1).error, /app closed/);
  } finally { sqlite.close(); }
});

test('v2 history migrates without losing messages; audio survives completion and failed snapshots', async () => {
  const { store, sqlite, failRead } = connect();
  try {
    await store.initialize();
    await appendTurn(store, 'old', 'Keep this chat', 'Kept', 1);
    sqlite.exec('ALTER TABLE messages DROP COLUMN audio_length; ALTER TABLE messages DROP COLUMN audio_metadata; ALTER TABLE messages DROP COLUMN audio_data; ALTER TABLE messages DROP COLUMN audio_format; PRAGMA user_version=2;');
    await store.initialize();
    assert.equal((await store.read()).messages[0].text, 'Keep this chat');
    const audio = { data: 'UklGRg==', format: 'wav' };
    const pending = await store.beginReply('voice', 'Voice message', 'google/gemini-3.8-flash', 2, audio);
    const id = pending.messages.at(-1).id;
    failRead();
    await assert.rejects(store.finishReply(id, 'complete', 'Hello', null, null), /snapshot/);
    let saved = await store.read();
    assert.deepEqual(saved.messages[0].audio, { id: saved.messages[0].id, encodedLength: audio.data.length, format: audio.format });
    assert.equal(saved.messages[1].status, 'pending');
    saved = await store.finishReply(id, 'complete', 'Hello', null, null);
    assert.deepEqual(saved.messages[0].audio, { id: saved.messages[0].id, encodedLength: audio.data.length, format: audio.format });
    assert.equal(saved.messages[0].text, 'Voice message');
    assert.equal(saved.messages[1].status, 'complete');
  } finally { sqlite.close(); }
});


test('v3 retained recordings migrate without changing audio or old transcripts', async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    const audio = { data: 'UklGRg==', format: 'm4a' };
    await store.beginReply('voice', 'Voice message', 'google/gemini-3.8-flash', 1, audio);
    sqlite.exec('ALTER TABLE messages DROP COLUMN audio_length; ALTER TABLE messages DROP COLUMN audio_metadata; PRAGMA user_version=3;');
    await store.initialize();
    const saved = await store.read();
    assert.deepEqual(saved.messages[0].audio, { id: saved.messages[0].id, encodedLength: audio.data.length, format: audio.format });
    assert.equal(saved.messages[1].status, 'failed');
    assert.equal(sqlite.prepare('PRAGMA user_version').get().user_version, 5);
  } finally { sqlite.close(); }
});

test('display snapshots never read recording bytes; request context loads only selected audio', async () => {
  const { store, sqlite, queries } = connect();
  try {
    await store.initialize();
    const audio = { data: 'A'.repeat(6 * 1024 * 1024), format: 'm4a', durationMillis: 1000, levels: Array.from({ length: 800 }, (_, i) => i / 800) };
    for (let i = 0; i < 4; i++) await appendVoice();
    async function appendVoice() {
      const pending = await store.beginReply('voice', 'Voice message', 'selected/model', 1, audio);
      await store.finishReply(pending.messages.at(-1).id, 'complete', 'Reply', null);
    }
    const saved = await store.read();
    assert.equal(saved.messages.filter(message => message.audio).length, 4);
    assert.ok(JSON.stringify(saved).length < 10_000, 'UI state contains metadata only');
    assert.equal(saved.messages[0].audio.levels.length, 32);
    assert.ok(!queries.some(query => /audio_data/.test(query.sql)), 'display and mutation snapshots never select raw audio');
    const context = await store.readContext('voice');
    assert.equal(context.filter(message => message.audio).length, 2);
    assert.ok(context.filter(message => message.audio).every(message => message.audio.data === audio.data));
    const reads = queries.filter(query => /audio_data/.test(query.sql));
    assert.equal(reads.length, 1);
    assert.equal(reads[0].args.length, 3, 'one chat ID and only two selected recording IDs');
  } finally { sqlite.close(); }
});

test('v4 migration preserves recordings and populates lazy-loading metadata', async () => {
  const { store, sqlite } = connect();
  try {
    await store.initialize();
    await store.beginReply('old', 'Voice message', 'selected/model', 1, { data: 'UklGRg==', format: 'wav' });
    sqlite.exec('ALTER TABLE messages DROP COLUMN audio_length; PRAGMA user_version=4;');
    await store.initialize();
    const saved = await store.read();
    assert.equal(saved.messages[0].audio.encodedLength, 8);
    assert.equal(saved.messages[0].audio.data, undefined);
    assert.equal((await store.readContext('old'))[0].audio.data, 'UklGRg==');
  } finally { sqlite.close(); }
});
