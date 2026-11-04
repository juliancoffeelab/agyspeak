import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../src/chat/ChatController.ts';
import { connect } from './sqlite-helper.mjs';

const settings = { apiKey: 'sk-or-v1-dummy-never-sent', model: 'test/model' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function waitFor(controller, predicate) {
  if (predicate(controller.getSnapshot())) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = controller.subscribe(() => {
      if (predicate(controller.getSnapshot())) { unsubscribe(); resolve(); }
    });
  });
}
async function setup(reply) {
  const { store, sqlite } = connect();
  await store.initialize();
  let next = 0;
  const controller = new ChatController(store, await store.read(), reply, () => `chat-${++next}`);
  return { store, sqlite, controller };
}

test('send saves the user message before inference; failure and retry reuse the same rows', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const { controller, store, sqlite } = await setup(() => (++calls === 1 ? first.promise : second.promise));
  try {
    assert.equal(await controller.send('Hello', settings), true);
    let saved = await store.read();
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[0].text, 'Hello');
    assert.equal(saved.messages[1].status, 'pending');
    const ids = saved.messages.map(m => m.id);
    first.reject(new Error('Offline'));
    await waitFor(controller, s => !s.pending);
    assert.equal(controller.getSnapshot().history.messages[1].status, 'failed');
    assert.equal(calls, 1, 'there is no automatic retry');
    await controller.retryReply(ids[1], settings);
    second.resolve({ text: 'Hi!', model: 'actual/model', cost: 0 });
    await waitFor(controller, s => !s.pending);
    saved = await store.read();
    assert.deepEqual(saved.messages.map(m => m.id), ids);
    assert.equal(saved.messages[1].text, 'Hi!');
    assert.equal(saved.messages[1].model, 'actual/model');
    assert.equal(calls, 2);
  } finally { await controller.dispose(); sqlite.close(); }
});

test('stop aborts; late completion cannot overwrite stopped status; navigation stays available', async () => {
  const request = deferred();
  let signal;
  const { controller, store, sqlite } = await setup((_messages, _settings, requestSignal) => { signal = requestSignal; return request.promise; });
  try {
    await controller.send('Wait', settings);
    const chatId = controller.getSnapshot().history.activeId;
    assert.equal(await controller.select(null), true);
    assert.equal(controller.getSnapshot().history.activeId, null);
    await controller.stop();
    assert.equal(signal.aborted, true);
    request.resolve({ text: 'Too late', model: 'test', cost: 0 });
    await Promise.resolve();
    await controller.select(chatId);
    const saved = await store.read();
    assert.equal(saved.messages.at(-1).status, 'cancelled');
    assert.equal(saved.messages.at(-1).text, '');
  } finally { await controller.dispose(); sqlite.close(); }
});

test('deleting a generating chat cannot resurrect it when the response arrives', async () => {
  const request = deferred();
  const { controller, store, sqlite } = await setup(() => request.promise);
  try {
    await controller.send('Wait', settings);
    await controller.remove(controller.getSnapshot().history.activeId);
    request.resolve({ text: 'Too late', model: 'test', cost: 0 });
    await Promise.resolve();
    assert.deepEqual(await store.read(), { chats: [], activeId: null, messages: [] });
  } finally { await controller.dispose(); sqlite.close(); }
});

test('blocked or failed save never starts inference', async () => {
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => { calls++; return { text: 'No', model: 'test', cost: 0 }; });
  try {
    assert.equal(await controller.send('Hello', { ...settings, apiKey: '' }), false);
    sqlite.exec(`CREATE TRIGGER fail_pending BEFORE INSERT ON messages WHEN NEW.role='assistant'
      BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;`);
    assert.equal(await controller.send('Hello', settings), false);
    assert.equal(calls, 0);
    assert.equal((await store.read()).chats.length, 0);
  } finally { await controller.dispose(); sqlite.close(); }
});

test('completion in another chat updates its history without changing current selection', async () => {
  const request = deferred();
  const { controller, store, sqlite } = await setup(() => request.promise);
  try {
    await controller.send('Wait', settings);
    const chatId = controller.getSnapshot().history.activeId;
    await controller.select(null);
    request.resolve({ text: 'Done', model: 'test', cost: 0 });
    await waitFor(controller, s => !s.pending);
    assert.equal(controller.getSnapshot().history.activeId, null);
    await controller.select(chatId);
    assert.equal((await store.read()).messages.at(-1).text, 'Done');
  } finally { await controller.dispose(); sqlite.close(); }
});

test('disposing during the initial save cannot start a late model request', async () => {
  const gate = deferred();
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => { calls++; return { text: 'Late', model: 'test', cost: 0 }; });
  const original = store.beginReply.bind(store);
  const entered = deferred();
  store.beginReply = async (...args) => {
    const saved = await original(...args);
    entered.resolve();
    await gate.promise;
    return saved;
  };
  try {
    const sending = controller.send('Save first', settings);
    await entered.promise;
    const disposing = controller.dispose();
    gate.resolve();
    assert.equal(await sending, false);
    await disposing;
    assert.equal(calls, 0);
    await store.initialize();
    assert.equal((await store.read()).messages.at(-1).status, 'failed');
  } finally { sqlite.close(); }
});

test('voice audio and its level display survive failure, retry, and successful completion', async () => {
  const audio = { data: 'UklGRg==', format: 'm4a', durationMillis: 2300, levels: [0.1, 0.8, 0.2] };
  let calls = 0;
  const { controller, store, sqlite } = await setup(async (messages, selected) => {
    calls++;
    assert.equal(selected.model, settings.model);
    assert.deepEqual(messages[0].audio, { data: audio.data, format: audio.format });
    if (calls === 1) throw new Error('Offline');
    return { text: 'Hej!', model: selected.model, cost: 0 };
  });
  try {
    assert.equal(await controller.sendAudio(audio, settings), true);
    await waitFor(controller, s => !s.pending);
    await store.initialize();
    let saved = await store.read();
    assert.deepEqual(saved.messages[0].audio, { id: saved.messages[0].id, encodedLength: audio.data.length, format: audio.format, durationMillis: audio.durationMillis, levels: audio.levels });
    const ids = saved.messages.map(m => m.id);
    await controller.retryReply(ids[1], settings);
    await waitFor(controller, s => !s.pending);
    saved = await store.read();
    assert.deepEqual(saved.messages.map(m => m.id), ids);
    assert.equal(saved.messages[0].text, 'Voice message');
    assert.deepEqual(saved.messages[0].audio, { id: saved.messages[0].id, encodedLength: audio.data.length, format: audio.format, durationMillis: audio.durationMillis, levels: audio.levels });
    assert.equal(saved.chats[0].title, 'Voice message');
    assert.equal(saved.messages[1].text, 'Hej!');
  } finally { await controller.dispose(); sqlite.close(); }
});

test('stopping while lazy audio is loading cannot start a late model request', async () => {
  let calls = 0;
  const { controller, store, sqlite } = await setup(async () => { calls++; return { text: 'No', model: 'test/model', cost: 0 }; });
  const entered = deferred(), gate = deferred();
  const read = store.readContext.bind(store);
  store.readContext = async id => { entered.resolve(); await gate.promise; return read(id); };
  try {
    await controller.send('Wait for context', settings);
    await entered.promise;
    const stopping = controller.stop();
    gate.resolve();
    await stopping;
    assert.equal(calls, 0);
    assert.equal((await store.read()).messages.at(-1).status, 'cancelled');
  } finally { await controller.dispose(); sqlite.close(); }
});
