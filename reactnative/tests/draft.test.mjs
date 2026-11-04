import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDraft, submitDraft } from '../src/chat/draft.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const draft = { text: '  First message  ', version: 1 };
  let native = draft.text;
  return { draft, clear: () => { native = ''; }, restore: text => { native = text; }, read: () => native };
}

test('submit clears immediately and successful save cannot erase the next draft', async () => {
  const f = fixture(), save = deferred();
  const task = submitDraft(f.draft, text => { assert.equal(text, 'First message'); return save.promise; }, f.clear, f.restore);
  assert.equal(f.read(), '');
  assert.equal(f.draft.text, '');
  editDraft(f.draft, 'Next message');
  save.resolve(true);
  assert.equal(await task, true);
  assert.equal(f.draft.text, 'Next message');
});

for (const failure of ['rejected', 'thrown']) {
  test(`a ${failure} save restores the original text, including whitespace`, async () => {
    const f = fixture(), save = deferred();
    const task = submitDraft(f.draft, () => save.promise, f.clear, f.restore);
    if (failure === 'thrown') {
      save.reject(new Error('Disk full'));
      await assert.rejects(task, /Disk full/);
    } else { save.resolve(false); assert.equal(await task, false); }
    assert.equal(f.read(), '  First message  ');
    assert.equal(f.draft.text, f.read());
  });
}

test('failed save preserves a new draft, even if it was typed and deleted', async () => {
  const f = fixture(), save = deferred();
  const task = submitDraft(f.draft, () => save.promise, f.clear, f.restore);
  editDraft(f.draft, 'Next');
  editDraft(f.draft, '');
  save.resolve(false);
  await task;
  assert.equal(f.draft.text, '');
  assert.equal(f.read(), '');
});

test('duplicate native change notifications do not count as user edits', async () => {
  const f = fixture(), save = deferred();
  const task = submitDraft(f.draft, () => save.promise, f.clear, f.restore);
  editDraft(f.draft, '');
  save.resolve(false);
  await task;
  assert.equal(f.read(), '  First message  ');
});
