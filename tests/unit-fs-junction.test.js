'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../core/fs-junction.js'), 'utf8');
function harness({ fail, stat, platform = 'win32' } = {}) {
  let calls = 0, elapsed = 0; const options = [];
  const io = {
    symlinkSync(target, link, kind) { calls++; options.push([target, link, kind]); const error = fail?.(calls); if (error) throw error; },
    lstatSync() { if (stat) return stat(); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  const context = { require: name => { assert.equal(name, 'node:fs'); return io; }, process: { platform },
    module: { exports: {} }, Date: { now: () => elapsed }, Int32Array, SharedArrayBuffer,
    Atomics: { wait: (_array, _index, _value, ms) => { elapsed += ms; } } };
  vm.runInNewContext(source, context);
  return { run: () => context.module.exports.createJunctionSync('target', 'link'), state: () => ({ calls, elapsed, options }) };
}
const error = code => Object.assign(new Error(code), { code });
test('successful junction preserves the exact target and path', () => {
  const h = harness(); h.run(); assert.deepEqual(h.state(), { calls: 1, elapsed: 0, options: [['target', 'link', 'junction']] });
});
test('transient busy retries only creation, then returns actual success', () => {
  const busy = error('EBUSY'), h = harness({ fail: n => n < 3 ? busy : null }); h.run();
  assert.equal(h.state().calls, 3); assert.equal(h.state().elapsed, 40);
});
test('persistent busy remains an error within the readiness budget', () => {
  const busy = error('EBUSY'), h = harness({ fail: () => busy }); assert.throws(h.run, e => e === busy);
  assert.equal(h.state().elapsed, 2000); assert.equal(h.state().calls, 101);
});
test('existing paths and dangling links are never overwritten or retried', () => {
  const busy = error('EBUSY'), h = harness({ fail: () => busy, stat: () => ({ isSymbolicLink: () => true }) });
  assert.throws(h.run, e => e === busy); assert.equal(h.state().calls, 1);
});
test('permissions, unrelated errors and non-Windows busy fail immediately', () => {
  for (const [platform, code] of [['win32', 'EPERM'], ['win32', 'EEXIST'], ['linux', 'EBUSY']]) {
    const failure = error(code), h = harness({ platform, fail: () => failure });
    assert.throws(h.run, e => e === failure); assert.equal(h.state().calls, 1);
  }
  const busy = error('EBUSY'), h = harness({ fail: () => busy, stat: () => { throw error('EACCES'); } });
  assert.throws(h.run, e => e === busy); assert.equal(h.state().calls, 1);
});
