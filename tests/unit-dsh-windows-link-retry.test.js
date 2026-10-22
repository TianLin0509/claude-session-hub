'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const preload = require.resolve('../core/dsh-windows-link-retry.cjs');

for (const [code, failures, expected] of [['EBUSY', 2, 3], ['EPERM', 9, 5], ['ENOENT', 1, 1]]) {
  test(`DSH native module links: ${code}, bounded attempts and original error`, t => {
    let attempts = 0;
    const error = Object.assign(new Error(code), { code });
    const waits = [];
    t.mock.method(fs, 'symlinkSync', () => { if (++attempts <= failures) throw error; });
    t.mock.method(Atomics, 'wait', (_a, _b, _c, ms) => waits.push(ms));
    delete require.cache[preload];
    const { installLinkRetry } = require(preload);
    if (process.platform !== 'win32') installLinkRetry('win32');
    try {
      if (failures < expected) fs.symlinkSync('target', 'link', 'junction');
      else assert.throws(() => fs.symlinkSync('target', 'link', 'junction'), e => e === error);
      assert.equal(attempts, expected);
      assert.deepEqual(waits, Array.from({ length: expected - 1 }, (_, i) => (i + 1) * 100));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); delete require.cache[preload]; }
  });
}

test('assistant defaults offer DSH and retain legacy backend recovery', () => {
  const { SELECTABLE_BACKENDS, backendKind } = require('../core/hub-assistant/backends');
  assert(SELECTABLE_BACKENDS.includes('deepseek-acp'));
  assert(!SELECTABLE_BACKENDS.includes('deepseek'));
  assert.equal(backendKind('deepseek'), 'deepseek');
});
