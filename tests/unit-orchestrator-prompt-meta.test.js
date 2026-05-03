'use strict';
// 锁定 orchestrator 的 prompt 元数据 API（recordTurnPrompt/getActivePrompt/setSendStatus）
// 与 completeTurn 内的 merge + 节流行为。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-promptmeta-'));
process.env.CLAUDE_HUB_DATA_DIR_TEST = TMP;

const roundtable = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

console.log('Running orchestrator prompt-meta tests...');

function freshOrch() {
  const meetingId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sceneObj = scenes.getScene('research') || scenes.getScene('general');
  return roundtable.getOrchestrator(TMP, meetingId, sceneObj);
}

test('recordTurnPrompt 切第一行 + 暂存 promptBy/promptHeaderBy', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', '[research · 第 1 轮 · 默认提问]\n## 用户问题\n请分析兆易创新');
  const active = orch.getActivePrompt(1);
  assert.ok(active, 'getActivePrompt 应返回非空');
  assert.strictEqual(active.promptBy['sid-A'], '[research · 第 1 轮 · 默认提问]\n## 用户问题\n请分析兆易创新');
  assert.strictEqual(active.promptHeaderBy['sid-A'], '[research · 第 1 轮 · 默认提问]');
});

test('setSendStatus 写入 active turn', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', 'L1\nL2');
  orch.setSendStatus(1, 'sid-A', 'auto_recovered');
  const active = orch.getActivePrompt(1);
  assert.strictEqual(active.sendStatus['sid-A'], 'auto_recovered');
});

test('completeTurn 后：promptBy 被节流删除，promptHeaderBy/sendStatus 落入 record', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', 'header A\nbody');
  orch.recordTurnPrompt(1, 'sid-B', 'header B\nbody');
  orch.setSendStatus(1, 'sid-A', 'ok');
  orch.completeTurn(1, 'fanout', 'q', { 'sid-A': 'a', 'sid-B': 'b' }, {}, { 'sid-A': 'completed', 'sid-B': 'completed' });
  const turn = orch.state.turns.find(t => t.n === 1);
  assert.ok(turn, 'turn record 应存在');
  assert.strictEqual(turn.promptHeaderBy?.['sid-A'], 'header A');
  assert.strictEqual(turn.promptHeaderBy?.['sid-B'], 'header B');
  assert.strictEqual(turn.sendStatus?.['sid-A'], 'ok');
  // promptBy 必须已被节流删除（不在 record 上、_activePrompts 也清掉）
  assert.strictEqual(turn.promptBy, undefined, 'record 不应有 promptBy');
  assert.strictEqual(orch.getActivePrompt(1), null, '_activePrompts[1] 应被清掉');
});

test('getActivePrompt 不存在时返回 null', () => {
  const orch = freshOrch();
  assert.strictEqual(orch.getActivePrompt(99), null);
});

test('rollbackTurn 也清 _activePrompts（避免泄漏）', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', 'h\nb');
  orch.rollbackTurn(1);
  assert.strictEqual(orch.getActivePrompt(1), null);
});

const failed = process.exitCode || 0;
console.log(`\n${failed ? '✗' : '✓'} orchestrator prompt-meta: ${5 - failed} passed\n`);
