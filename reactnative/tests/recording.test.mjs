import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingSession } from '../src/chat/RecordingSession.ts';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(overrides = {}) {
  const native = { recording: false, duration: 0, starts: 0, stops: 0, removed: [] };
  const port = {
    permission: async () => true, prepare: async () => {},
    record: () => { native.recording = true; native.starts++; },
    stop: async () => { native.recording = false; native.duration = 0; native.stops++; },
    status: () => ({ isRecording: native.recording, durationMillis: native.duration, metering: -20 }),
    uri: () => 'cache/recording.m4a', remove: uri => native.removed.push(uri), ...overrides,
  };
  return { native, session: new RecordingSession(port) };
}

for (const stage of ['permission', 'prepare']) {
  test(`navigation during ${stage} invalidates the pending start, including rapid reactivation`, async () => {
    const entered = deferred(), gate = deferred();
    const { native, session } = setup({ [stage]: async () => { entered.resolve(); await gate.promise; return true; } });
    const starting = session.start();
    await entered.promise;
    session.setActive(false);
    session.setActive(true);
    gate.resolve();
    assert.equal(await starting, false);
    await session.discard();
    assert.equal(native.starts, 0);
    assert.equal(session.getSnapshot().phase, 'idle');
  });
}

test('backgrounding stops capture and preserves duration, levels, and a ready clip', async () => {
  const { native, session } = setup();
  await session.start();
  native.duration = 2300;
  session.sample();
  const ready = deferred();
  const unsubscribe = session.subscribe(() => { if (session.getSnapshot().phase === 'ready') ready.resolve(); });
  session.setActive(false);
  await ready.promise;
  unsubscribe();
  assert.equal(native.stops, 1);
  assert.equal(session.getSnapshot().durationMillis, 2300);
  assert.equal(session.getSnapshot().clip.levels.length, 1);
  session.setActive(true);
  const accepted = await session.send(async (clip, signal) => {
    assert.equal(clip.durationMillis, 2300);
    assert.equal(signal.aborted, false);
    return true;
  });
  assert.equal(accepted, true);
  assert.equal(session.getSnapshot().phase, 'idle');
  assert.deepEqual(native.removed, ['cache/recording.m4a']);
});

test('hiding during audio reading aborts submission and retains the unsent clip', async () => {
  const { session } = setup();
  await session.start();
  const entered = deferred(), gate = deferred();
  let signal;
  const sending = session.send(async (_clip, abort) => { signal = abort; entered.resolve(); await gate.promise; return !abort.aborted; });
  await entered.promise;
  session.setActive(false);
  assert.equal(signal.aborted, true);
  gate.resolve();
  assert.equal(await sending, false);
  assert.equal(session.getSnapshot().phase, 'ready');
  await session.discard();
  assert.equal(session.getSnapshot().clip, null);
});

test('a picker result arriving after navigation is discarded without sending', async () => {
  const { native, session } = setup();
  const entered = deferred(), gate = deferred();
  const picking = session.pick(async () => { entered.resolve(); await gate.promise; return { uri: 'cache/picked.wav', format: 'wav' }; });
  await entered.promise;
  session.setActive(false);
  gate.resolve();
  assert.equal(await picking, false);
  assert.deepEqual(native.removed, ['cache/picked.wav']);
  assert.equal(session.getSnapshot().phase, 'idle');
});

test('failed submission keeps the recording available for an explicit retry', async () => {
  const { native, session } = setup();
  await session.start();
  assert.equal(await session.send(async () => false), false);
  assert.equal(session.getSnapshot().phase, 'ready');
  assert.deepEqual(native.removed, []);
  assert.equal(await session.send(async () => true), true);
  assert.equal(native.stops, 1);
});

test('automatic native stop retains the last measured duration when the SDK resets it', async () => {
  const { native, session } = setup();
  await session.start();
  native.duration = 119900;
  session.sample();
  native.recording = false;
  native.duration = 0;
  const ready = deferred();
  const unsubscribe = session.subscribe(() => { if (session.getSnapshot().phase === 'ready') ready.resolve(); });
  session.sample();
  await ready.promise;
  unsubscribe();
  assert.equal(session.getSnapshot().clip.durationMillis, 119900);
  await session.discard();
});

test('discard during preparation prevents capture and cleans the prepared file', async () => {
  const entered = deferred(), gate = deferred();
  const { native, session } = setup({ prepare: async () => { entered.resolve(); await gate.promise; } });
  const starting = session.start();
  await entered.promise;
  const discarding = session.discard();
  gate.resolve();
  assert.equal(await starting, false);
  await discarding;
  assert.equal(native.starts, 0);
  assert.deepEqual(native.removed, ['cache/recording.m4a']);
  assert.equal(session.getSnapshot().phase, 'idle');
});

test('navigation during native stop prevents the pending send', async () => {
  const entered = deferred(), gate = deferred();
  let native;
  const setupResult = setup({ stop: async () => { entered.resolve(); await gate.promise; native.recording = false; } });
  native = setupResult.native;
  const { session } = setupResult;
  await session.start();
  let submissions = 0;
  const sending = session.send(async () => { submissions++; return true; });
  await entered.promise;
  session.setActive(false);
  gate.resolve();
  assert.equal(await sending, false);
  assert.equal(submissions, 0);
  assert.equal(session.getSnapshot().phase, 'ready');
  await session.discard();
});
