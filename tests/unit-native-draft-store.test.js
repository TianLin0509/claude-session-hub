'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { NativeDraftStore } = require('../core/native-draft-store');
const { createNativeDraftController } = require('../renderer/native-draft-controller');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('two Main connections retain exact Unicode drafts across reopen and reject stale window writes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-draft-test-'));
  const a = new NativeDraftStore(root), b = new NativeDraftStore(root);
  t.after(() => { b.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const text = '  第一行 🧩\r\n' + '- 多行正文\r\n'.repeat(600) + '末行  ';
  assert.deepEqual(a.read('session-1'), { revision: 0, text: null });
  assert.deepEqual(a.save('session-1', text, 0), { revision: 1, text });
  assert.equal(b.read('session-1').text, text);
  assert.throws(() => b.save('session-1', 'old window', 0), error => error.code === 'NATIVE_DRAFT_CONFLICT');
  a.close();
  assert.equal(b.read('session-1').text, text);
  assert.deepEqual(b.save('session-1', '', 1), { revision: 2, text: '' });
  assert.throws(() => b.save('session-1', text, 1), /其他窗口/);
  assert.throws(() => b.read('../escape'), /Invalid/);
  assert.throws(() => b.save('session-1', {}, 2), /Invalid/);
});

test('typing before read and during save is serialized, including clear then a new draft', async () => {
  let finishRead, finishSave;
  const writes = [], statuses = [];
  const controller = createNativeDraftController({ sessionId: 'id', initialText: '', onStatus: error => statuses.push(error),
    onRestore() { throw new Error('must not overwrite typing'); },
    invoke: (method, request) => method.endsWith(':read') ? new Promise(resolve => { finishRead = resolve; })
      : new Promise(resolve => { writes.push(request); finishSave = resolve; }) });
  controller.change('first'); finishRead({ ok: true, record: { revision: 0, text: null } });
  await tick(); assert.equal(writes[0].text, 'first');
  controller.change(''); controller.change('next');
  let restored;
  controller.attach({ onRestore: text => { restored = text; }, onStatus: error => statuses.push(error) });
  assert.equal(restored, 'next');
  finishSave({ ok: true, record: { revision: 1, text: 'first' } });
  await tick(); assert.equal(writes.length, 2); assert.equal(writes[1].revision, 1); assert.equal(writes[1].text, 'next');
  finishSave({ ok: true, record: { revision: 2, text: 'next' } });
  await controller.ready;
  assert.equal(controller.state.current.text, 'next'); assert.equal(controller.state.saving, false);
  assert.ok(statuses.every(value => value === null));
});

test('save failure remains visible and never falls back to browser storage or silently retries', async () => {
  const statuses = []; let saves = 0;
  const controller = createNativeDraftController({ sessionId: 'id', initialText: 'retained',
    onStatus: error => statuses.push(error?.message || null),
    invoke: async method => method.endsWith(':read') ? { ok: true, record: { revision: 0, text: null } }
      : (saves++, { ok: false, error: 'disk full' }) });
  await controller.ready;
  assert.equal(statuses.at(-1), 'disk full');
  controller.change('new text'); await tick();
  assert.equal(saves, 1); assert.equal(statuses.at(-1), 'disk full');
});

test('a late read cannot replace new typing or overwrite a different stored draft', async () => {
  let finishRead, writes = 0, restored = false;
  const controller = createNativeDraftController({ sessionId: 'id',
    onRestore() { restored = true; }, onStatus() {},
    invoke: method => method.endsWith(':read') ? new Promise(resolve => { finishRead = resolve; }) : (writes++, {}) });
  controller.change('new typing'); finishRead({ ok: true, record: { revision: 8, text: 'other window' } });
  await controller.ready;
  assert.equal(writes, 0); assert.equal(restored, false); assert.ok(controller.state.failure);
});
