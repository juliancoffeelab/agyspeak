import assert from 'node:assert/strict';
import test from 'node:test';
import { API_KEY_STORAGE_KEY, MODEL_STORAGE_KEY, LEGACY_SETTINGS_KEY, createModelSettingsStorage } from '../src/chat/modelSettingsStorage.ts';

const key = 'sk-or-1111111111111111';
function stores() {
  const secrets = new Map(), prefs = new Map();
  const secure = { get: async k => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); }, remove: async k => { secrets.delete(k); } };
  const preferences = { get: async k => prefs.get(k) ?? null, set: async (k, v) => { prefs.set(k, v); } };
  return { secrets, prefs, secure, preferences };
}

test('migration preserves credentials and model, then removes the combined secure record', async () => {
  const stores_ = stores();
  stores_.secrets.set(LEGACY_SETTINGS_KEY, JSON.stringify({ apiKey: key, model: 'selected/model' }));
  const storage = createModelSettingsStorage(stores_.secure, stores_.preferences);
  assert.deepEqual(await storage.read(), { apiKey: key, model: 'selected/model' });
  assert.deepEqual([...stores_.secrets], [[API_KEY_STORAGE_KEY, key]]);
  assert.deepEqual([...stores_.prefs], [[MODEL_STORAGE_KEY, 'selected/model']]);
  assert.deepEqual(await storage.read(), { apiKey: key, model: 'selected/model' });
});

test('failed migration keeps its source and retries without losing newer preferences', async () => {
  const stores_ = stores();
  stores_.secrets.set(LEGACY_SETTINGS_KEY, JSON.stringify({ apiKey: key, model: 'old/model' }));
  stores_.prefs.set(MODEL_STORAGE_KEY, 'new/model');
  let fail = true;
  const storage = createModelSettingsStorage({ ...stores_.secure, set: async (k, v) => { if (fail) throw new Error('locked'); await stores_.secure.set(k, v); } }, stores_.preferences);
  await assert.rejects(storage.read(), /locked/);
  assert.ok(stores_.secrets.has(LEGACY_SETTINGS_KEY));
  assert.equal(stores_.prefs.get(MODEL_STORAGE_KEY), 'new/model');
  fail = false;
  assert.deepEqual(await storage.read(), { apiKey: key, model: 'new/model' });
  assert.equal(stores_.secrets.has(LEGACY_SETTINGS_KEY), false);
});

test('model saves never touch secure storage; key removal stays removed on reopening', async () => {
  const stores_ = stores();
  const storage = createModelSettingsStorage(stores_.secure, stores_.preferences);
  await storage.saveKey(key);
  await storage.saveModel('custom/model');
  assert.deepEqual([...stores_.secrets], [[API_KEY_STORAGE_KEY, key]]);
  assert.deepEqual([...stores_.prefs], [[MODEL_STORAGE_KEY, 'custom/model']]);
  await storage.saveModel(' ');
  await storage.saveKey('');
  assert.deepEqual(await storage.read(), { apiKey: '', model: 'openrouter/free' });
});

test('rapid writes remain ordered and a failed write does not block later saves', async () => {
  const stores_ = stores();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const writes = [];
  const storage = createModelSettingsStorage(stores_.secure, { ...stores_.preferences, set: async (k, v) => {
    writes.push(v);
    if (v === 'first') { await pending; throw new Error('disk'); }
    await stores_.preferences.set(k, v);
  } });
  const first = storage.saveModel('first');
  const failed = assert.rejects(first, /disk/);
  const second = storage.saveModel('second');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['first']);
  release();
  await failed;
  await second;
  assert.deepEqual(writes, ['first', 'second']);
  assert.equal((await storage.read()).model, 'second');
});
