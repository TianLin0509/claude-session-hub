'use strict';
// meeting-create-modal Task 7（2026-05-01）— private store 去白名单单测：
//   1. 接受任意非空 string kind（包括 deepseek/glm）不抛
//   2. 拒绝空字符串 / null / undefined / 非字符串
//   3. listPrivateTurns 全量返回 / 按 kind 过滤
//   4. 老 store 文件（kind=claude/gemini/codex）向后兼容

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../core/general-roundtable-private-store.js');

let tmp;
function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'priv-test-'));
  return tmp;
}
function cleanup() {
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running private-store no-whitelist tests...');

test('appendPrivateTurn accepts deepseek + glm kinds', () => {
  setup();
  store.appendPrivateTurn(tmp, 'm1', 'deepseek', 'q1', 'a1');
  store.appendPrivateTurn(tmp, 'm1', 'glm', 'q2', 'a2');
  const all = store.listPrivateTurns(tmp, 'm1');
  assert.strictEqual(all.deepseek.length, 1);
  assert.strictEqual(all.glm.length, 1);
  assert.strictEqual(all.deepseek[0].userInput, 'q1');
  cleanup();
});

test('appendPrivateTurn still accepts legacy claude/gemini/codex', () => {
  setup();
  store.appendPrivateTurn(tmp, 'm2', 'claude', 'q', 'a');
  store.appendPrivateTurn(tmp, 'm2', 'gemini', 'q', 'a');
  store.appendPrivateTurn(tmp, 'm2', 'codex', 'q', 'a');
  const all = store.listPrivateTurns(tmp, 'm2');
  assert.strictEqual(all.claude.length, 1);
  assert.strictEqual(all.gemini.length, 1);
  assert.strictEqual(all.codex.length, 1);
  cleanup();
});

test('appendPrivateTurn rejects empty/null/non-string kind', () => {
  setup();
  assert.throws(() => store.appendPrivateTurn(tmp, 'm3', '',     'q', 'a'), /invalid kind/);
  assert.throws(() => store.appendPrivateTurn(tmp, 'm3', null,   'q', 'a'), /invalid kind/);
  assert.throws(() => store.appendPrivateTurn(tmp, 'm3', undefined, 'q', 'a'), /invalid kind/);
  assert.throws(() => store.appendPrivateTurn(tmp, 'm3', 123,    'q', 'a'), /invalid kind/);
  cleanup();
});

test('listPrivateTurns(meetingId, kind=deepseek) returns just deepseek list', () => {
  setup();
  store.appendPrivateTurn(tmp, 'm4', 'deepseek', 'q1', 'a1');
  store.appendPrivateTurn(tmp, 'm4', 'glm',      'q2', 'a2');
  const dsOnly = store.listPrivateTurns(tmp, 'm4', 'deepseek');
  assert.ok(Array.isArray(dsOnly));
  assert.strictEqual(dsOnly.length, 1);
  assert.strictEqual(dsOnly[0].userInput, 'q1');
});

test('readPrivateStore returns file contents as-is (no shape coercion to claude/gemini/codex)', () => {
  setup();
  store.appendPrivateTurn(tmp, 'm5', 'deepseek', 'q', 'a');
  const all = store.readPrivateStore(tmp, 'm5');
  assert.deepStrictEqual(Object.keys(all), ['deepseek']);
  cleanup();
});

// pilot-mode Task 4（2026-05-01）— sid 索引 API
test('appendPrivateTurnBySid + listPrivateTurnsBySid round-trip', () => {
  setup();
  store.appendPrivateTurnBySid(tmp, 'm-pilot-1', 'sid-abc-123', '问题1', '答案1');
  store.appendPrivateTurnBySid(tmp, 'm-pilot-1', 'sid-abc-123', '问题2', '答案2');
  const turns = store.listPrivateTurnsBySid(tmp, 'm-pilot-1', 'sid-abc-123');
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].userInput, '问题1');
  assert.strictEqual(turns[1].response, '答案2');
  cleanup();
});

test('sid-based and kind-based stores coexist with prefix isolation', () => {
  setup();
  store.appendPrivateTurn(tmp, 'm-mix', 'claude', 'kind-q', 'kind-a');
  store.appendPrivateTurnBySid(tmp, 'm-mix', 'sid-xyz', 'sid-q', 'sid-a');
  const all = store.readPrivateStore(tmp, 'm-mix');
  // 顶层 keys 同时含 'claude' 和 'sid:sid-xyz'，互不干扰
  assert.ok(Array.isArray(all.claude));
  assert.ok(Array.isArray(all['sid:sid-xyz']));
  assert.strictEqual(all.claude.length, 1);
  assert.strictEqual(all['sid:sid-xyz'].length, 1);
  // listPrivateTurnsBySid 不返回 kind 数据
  const sidOnly = store.listPrivateTurnsBySid(tmp, 'm-mix', 'sid-xyz');
  assert.strictEqual(sidOnly.length, 1);
  assert.strictEqual(sidOnly[0].userInput, 'sid-q');
  cleanup();
});

test('clearPrivateTurnsBySid wipes one sid window without touching others', () => {
  setup();
  store.appendPrivateTurnBySid(tmp, 'm-clear', 'sid-a', 'q', 'r');
  store.appendPrivateTurnBySid(tmp, 'm-clear', 'sid-b', 'q', 'r');
  store.appendPrivateTurn(tmp, 'm-clear', 'gemini', 'kq', 'kr');
  const cleared = store.clearPrivateTurnsBySid(tmp, 'm-clear', 'sid-a');
  assert.strictEqual(cleared, true);
  assert.strictEqual(store.listPrivateTurnsBySid(tmp, 'm-clear', 'sid-a').length, 0);
  assert.strictEqual(store.listPrivateTurnsBySid(tmp, 'm-clear', 'sid-b').length, 1, 'sid-b untouched');
  assert.strictEqual(store.listPrivateTurns(tmp, 'm-clear', 'gemini').length, 1, 'kind untouched');
  // clearing nonexistent returns false
  assert.strictEqual(store.clearPrivateTurnsBySid(tmp, 'm-clear', 'sid-nope'), false);
  cleanup();
});

test('appendPrivateTurnBySid rejects empty/null sid', () => {
  setup();
  assert.throws(() => store.appendPrivateTurnBySid(tmp, 'm', '', 'q', 'r'), /invalid sid/);
  assert.throws(() => store.appendPrivateTurnBySid(tmp, 'm', null, 'q', 'r'), /invalid sid/);
  cleanup();
});

console.log('All passed.');
