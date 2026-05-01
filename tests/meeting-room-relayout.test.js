'use strict';
// Task 10（2026-05-01）单测：动态重排兜底契约（静态分析）。
// 真实重排效果走 E2E（Task 12）；这里只锁住关键代码存在和合理调用。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running meeting-room relayout tests...');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-room.js'), 'utf-8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-room.css'), 'utf-8');

test('_relayoutMeetingRoom 函数定义', () => {
  assert.match(SRC, /function\s+_relayoutMeetingRoom\s*\(/);
});

test('使用 ResizeObserver', () => {
  assert.match(SRC, /new\s+ResizeObserver\s*\(/);
});

test('监听 window resize', () => {
  assert.match(SRC, /window\.addEventListener\s*\(\s*['"]resize['"]/);
});

test('debounce 100ms', () => {
  assert.match(SRC, /_debounce\s*\([\s\S]*?,\s*100\s*\)/);
});

test('_setupMeetingResizeObserver / _teardownMeetingResizeObserver 都存在', () => {
  assert.match(SRC, /function\s+_setupMeetingResizeObserver\s*\(/);
  assert.match(SRC, /function\s+_teardownMeetingResizeObserver\s*\(/);
});

test('openMeeting 调 _setupMeetingResizeObserver', () => {
  const start = SRC.indexOf('function openMeeting');
  const end = SRC.indexOf('function closeMeetingPanel', start);
  assert.ok(start >= 0 && end > start);
  const body = SRC.slice(start, end);
  assert.match(body, /_setupMeetingResizeObserver\s*\(\s*\)/);
});

test('closeMeetingPanel 调 _teardownMeetingResizeObserver', () => {
  const start = SRC.indexOf('function closeMeetingPanel');
  // 找下一个函数定义边界
  const cands = [
    '\n  function _toggleMeetingMode',
    '\n  function getActiveMeetingId',
    '\n  function ',
  ];
  let end = SRC.length;
  for (const c of cands) {
    const i = SRC.indexOf(c, start + 30);
    if (i > 0 && i < end) end = i;
  }
  const body = SRC.slice(start, end);
  assert.match(body, /_teardownMeetingResizeObserver\s*\(\s*\)/);
});

test('CSS 含防溢出 .mr-ft-strip min-height:0 + .mr-ft overflow:hidden', () => {
  // 找到 Task 10 注释段（避免误命中既有 .mr-ft-strip / .mr-ft 早期定义）
  const taskBlock = CSS.match(/Card optimization Task 10[\s\S]+/);
  assert.ok(taskBlock, 'Task 10 CSS 注释段必须存在');
  const block = taskBlock[0];
  assert.match(block, /\.mr-ft-strip\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(block, /\.mr-ft\s*\{[\s\S]*?overflow:\s*hidden/);
});

test('xterm fit 调用（subTerminals 路径）', () => {
  const start = SRC.indexOf('function _relayoutMeetingRoom');
  const end = SRC.indexOf('function _setupMeetingResizeObserver');
  assert.ok(start >= 0 && end > start);
  const body = SRC.slice(start, end);
  assert.match(body, /\.fit\s*\(\s*\)/, '_relayoutMeetingRoom 体内调用 fit()');
  assert.match(body, /subTerminals/, '_relayoutMeetingRoom 体内引用 subTerminals');
});

test('抖动过滤 <4px 跳过 relayout', () => {
  const start = SRC.indexOf('_setupMeetingResizeObserver');
  const end = SRC.indexOf('function _teardownMeetingResizeObserver');
  const body = SRC.slice(start, end);
  assert.match(body, /Math\.abs\(width\s*-\s*_lastLayoutW\)\s*<\s*4/);
});

console.log('All passed.');
