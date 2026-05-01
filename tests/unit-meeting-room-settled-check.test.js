'use strict';
// FIX-E（2026-05-01）单测：锁住 _allParticipantsSettled 必须按 expectedSids 严格比对，
// 不能再用 partialBy 自身的 keys（会在某家 watcher 还没 settle 时误判全员 settled）。
//
// 因为 _allParticipantsSettled 定义在 meeting-room.js 的 IIFE 内部不导出，
// 我们用静态分析（grep + 行为验证）方式锁住契约：
// 1. 函数签名必须含 expectedSids 参数
// 2. 函数体必须用 expectedSids.every，不能再 Object.keys(partialBy).every
// 3. 调用方必须传 expectedSids（subs 派生）

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf-8');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running meeting-room settled-check tests...');

test('_allParticipantsSettled 签名必须接 expectedSids', () => {
  const m = src.match(/function\s+_allParticipantsSettled\s*\(\s*partialBy\s*,\s*expectedSids\s*\)/);
  assert.ok(m, '_allParticipantsSettled must have signature (partialBy, expectedSids)');
});

test('函数体必须用 expectedSids.every 而非 Object.keys(partialBy).every', () => {
  const start = src.indexOf('function _allParticipantsSettled');
  const end = src.indexOf('function _renderCmdBar', start);
  assert.ok(start >= 0 && end > start);
  const body = src.slice(start, end);
  assert.ok(/expectedSids\.every/.test(body), 'must call expectedSids.every');
  assert.ok(!/Object\.keys\(partialBy\)\.every/.test(body), 'must NOT use Object.keys(partialBy).every (legacy bug)');
});

test('_renderCmdBar 签名接 expectedSids', () => {
  const m = src.match(/function\s+_renderCmdBar\s*\(\s*turns\s*,\s*currentMode\s*,\s*partialBy\s*,\s*expectedSids\s*\)/);
  assert.ok(m, '_renderCmdBar must accept expectedSids');
});

test('调用方 _renderRtPanelHtml 必须从 subs 派生 expectedSids 并传入', () => {
  const m = src.match(/expectedSids\s*=\s*\[\s*'claude'\s*,\s*'gemini'\s*,\s*'codex'\s*\]\s*\.map[\s\S]*?\.filter\(Boolean\)/);
  assert.ok(m, '_renderRtPanelHtml must derive expectedSids from subs');
  assert.ok(/_renderCmdBar\([^)]*expectedSids[^)]*\)/.test(src), '_renderCmdBar must be called with expectedSids');
});

// 行为级模拟：用一个本地副本验证 settled 判定逻辑
const _SETTLED_STATUSES = new Set(['completed', 'manual_extracted', 'absent', 'errored', 'interrupted']);
function _allParticipantsSettled(partialBy, expectedSids) {
  if (!partialBy || !expectedSids || expectedSids.length === 0) return false;
  return expectedSids.every(sid => partialBy[sid] && _SETTLED_STATUSES.has(partialBy[sid].status));
}

test('行为：3 家期望，仅 2 家 partial → false', () => {
  const partialBy = {
    'sid-claude': { status: 'completed' },
    'sid-gemini': { status: 'completed' },
    // sid-codex 还没 partial（卡死中）
  };
  const expected = ['sid-claude', 'sid-gemini', 'sid-codex'];
  assert.strictEqual(_allParticipantsSettled(partialBy, expected), false);
});

test('行为：3 家全部 settled → true', () => {
  const partialBy = {
    'sid-claude': { status: 'completed' },
    'sid-gemini': { status: 'manual_extracted' },
    'sid-codex': { status: 'errored' },
  };
  const expected = ['sid-claude', 'sid-gemini', 'sid-codex'];
  assert.strictEqual(_allParticipantsSettled(partialBy, expected), true);
});

test('行为：partialBy 含 streaming 中间态 → false', () => {
  const partialBy = {
    'sid-claude': { status: 'completed' },
    'sid-gemini': { status: 'streaming' }, // 还在跑
    'sid-codex': { status: 'absent' },
  };
  const expected = ['sid-claude', 'sid-gemini', 'sid-codex'];
  assert.strictEqual(_allParticipantsSettled(partialBy, expected), false);
});

test('行为：partialBy 是 null → false', () => {
  const expected = ['sid-claude', 'sid-gemini', 'sid-codex'];
  assert.strictEqual(_allParticipantsSettled(null, expected), false);
});

test('行为：expectedSids 为空 → false（防卫）', () => {
  assert.strictEqual(_allParticipantsSettled({ x: { status: 'completed' } }, []), false);
  assert.strictEqual(_allParticipantsSettled({ x: { status: 'completed' } }, null), false);
});

console.log('All passed.');
