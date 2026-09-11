'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const start = source.indexOf('function formatTime(ts) {');
const end = source.indexOf('\nfunction escapeHtml', start);
const now = 1800000000000;
const context = vm.createContext({ Date: { now: () => now }, formatBeijingClock: () => '08:47' });
vm.runInContext(source.slice(start, end), context);

test('侧栏全程相对时间，覆盖分钟、小时、天及边界', () => {
  for (const [age, expected] of [[0, '刚刚'], [59999, '刚刚'], [60000, '1分钟前'],
    [7 * 60000, '7分钟前'], [3600000, '1小时前'], [3 * 3600000, '3小时前'],
    [86400000, '1天前'], [8 * 86400000, '8天前'], [-1000, '刚刚']]) {
    assert.equal(context.formatTime(now - age), expected, `age=${age}`);
  }
  assert.equal(context.formatTime(undefined), '—');
  assert.equal(context.formatTime(0), '—');
});
