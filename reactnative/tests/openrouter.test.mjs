import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeReply, requestMessages } from '../src/chat/openRouter.ts';
import { parseKeyInput, decodeSettings } from '../src/chat/settings.ts';

const settings = { apiKey: 'sk-or-v1-dummy-never-sent', model: 'openrouter/free' };
const user = { id: 1, role: 'user', text: 'Hello', status: 'complete' };
const signal = () => new AbortController().signal;

test('request is bounded, authenticated, and parsed without a live API call', async () => {
  const result = await completeReply([user], settings, signal(), async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${settings.apiKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openrouter/free');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
    return Response.json({ model: 'chosen/free-model', choices: [{ message: { content: 'Hi!' } }], usage: { cost: 0 } });
  });
  assert.deepEqual(result, { text: 'Hi!', model: 'chosen/free-model', cost: 0 });
});

test('authentication/rate-limit and malformed responses fail without automatic retries', async () => {
  for (const status of [401, 402, 429, 503]) {
    let calls = 0;
    await assert.rejects(completeReply([user], settings, signal(), async () => { calls++; return new Response('', { status }); }));
    assert.equal(calls, 1);
  }
  await assert.rejects(completeReply([user], settings, signal(), async () => Response.json({ choices: [] })), /no text/);
});

test('context excludes unfinished replies and is limited to recent text', () => {
  const history = [
    { ...user, text: 'old'.repeat(9000) },
    user,
    { ...user, role: 'assistant', text: 'Failure', status: 'failed' },
    { ...user, role: 'assistant', text: '', status: 'pending' },
  ];
  assert.deepEqual(requestMessages(history), [{ role: 'user', content: 'Hello' }]);
});

test('aborting propagates to the transport', async () => {
  const controller = new AbortController();
  const task = completeReply([user], settings, controller.signal, (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
});

test('QR and clipboard key formats are validated without executing links or accepting arbitrary QR data', () => {
  const key = 'sk-or-v1-dummy-valid-key-for-tests';
  assert.equal(parseKeyInput(`  ${key}\n`), key);
  assert.equal(parseKeyInput(`Bearer ${key}`), key);
  assert.equal(parseKeyInput(JSON.stringify({ type: 'agyspeak.openrouter-key', version: 1, key })), key);
  assert.throws(() => parseKeyInput('https://example.com'));
  assert.throws(() => parseKeyInput('{"type":"unrelated","key":"secret"}'));
  assert.equal(decodeSettings(null).model, 'openrouter/free');
  assert.throws(() => decodeSettings('{"apiKey":123}'));
});

test('provider errors retain actionable details and redact credentials', async () => {
  await assert.rejects(completeReply([user], settings, signal(), async () => Response.json({
    error: { message: 'Provider rejected request', metadata: { raw: JSON.stringify({ error: { message: `Unsupported parameter; key ${settings.apiKey}` } }) } },
  }, { status: 400 })), error => {
    assert.match(error.message, /Unsupported parameter/);
    assert.ok(!error.message.includes(settings.apiKey));
    assert.match(error.message, /redacted/);
    return true;
  });
});

test('429 errors distinguish upstream provider limits from unspecified rate limits', async () => {
  await assert.rejects(completeReply([user], settings, signal(), async () => Response.json({
    error: { message: 'Provider returned error', metadata: { raw: JSON.stringify({ error: { message: 'temporarily rate-limited upstream' } }) } },
  }, { status: 429 })), /model provider is rate limited/);
  await assert.rejects(completeReply([user], settings, signal(), async () => new Response('', { status: 429 })), /request was rate limited/);
});
