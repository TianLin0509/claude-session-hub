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

console.log('All passed.');
