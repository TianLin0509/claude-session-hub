'use strict';
// Stage 2 P0-14 单测：buildDebatePrompt 对 absent / errored 状态的处理。
//   摘要功能 2026-05-08 整体下线：原 buildSummaryPrompt 测试已删
//
// 不变式：
//   1. 老格式（lastTurn.byStatus = null/undefined）→ 全部当 completed 处理（向后兼容）
//   2. byStatus[sid] === 'absent'  → prompt 写"X 本轮因故未参与，请勿引用"，不引用 by 文本
//   3. byStatus[sid] === 'errored' → prompt 写"X 本轮发生错误未输出，请勿引用"
//   4. byStatus[sid] === 'completed' / 'manual_extracted' / undefined → 正常引用 by 文本
//   5. completeTurn 接受可选 byStatus 参数并存入 record

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RoundtableOrchestrator } = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');
const { computeLastTurnInjection } = require('../core/roundtable-injection.js');

// 方案 F · helper：旧风格 (lastTurn, targetSid) → 新签名 buildDebatePrompt
function buildDebate(orch, turnNum, userInput, lastTurn, targetSid, sidLabelFn) {
  const inj = computeLastTurnInjection(lastTurn, [targetSid], sidLabelFn, () => null);
  return orch.buildDebatePrompt(turnNum, userInput, null, inj[targetSid] || null, null);
}

let _tmpRoot = null;
function setupTmp() {
  _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-absent-test-'));
  return _tmpRoot;
}
function cleanupTmp() {
  if (_tmpRoot) {
    try { fs.rmSync(_tmpRoot, { recursive: true, force: true }); } catch {}
    _tmpRoot = null;
  }
}

function mkOrch() {
  const dir = setupTmp();
  const scene = scenes.getScene('general');
  return new RoundtableOrchestrator(dir, 'm-test', scene);
}

const sidLabel = sid => ({
  'sid-claude': 'Claude',
  'sid-gemini': 'Gemini',
  'sid-codex':  'Codex',
}[sid] || 'AI');

function testCompleteTurnAcceptsByStatus() {
  const orch = mkOrch();
  orch.beginTurn('fanout');
  const rec = orch.completeTurn(1, 'fanout', 'q', {
    'sid-claude': 'C answer',
    'sid-gemini': '',
    'sid-codex': 'X answer',
  }, {}, {
    'sid-claude': 'completed',
    'sid-gemini': 'absent',
    'sid-codex': 'errored',
  });
  assert.deepStrictEqual(rec.byStatus, {
    'sid-claude': 'completed',
    'sid-gemini': 'absent',
    'sid-codex': 'errored',
  }, 'byStatus must be persisted on the turn record');
  cleanupTmp();
  console.log('  ✓ testCompleteTurnAcceptsByStatus');
}

function testCompleteTurnLegacyNoByStatus() {
  // 不传 byStatus → record.byStatus = null（老格式向后兼容）
  const orch = mkOrch();
  orch.beginTurn('fanout');
  const rec = orch.completeTurn(1, 'fanout', 'q', { 'sid-claude': 'C' }, {});
  assert.strictEqual(rec.byStatus, null,
    'omitting byStatus must persist null (legacy format flag)');
  cleanupTmp();
  console.log('  ✓ testCompleteTurnLegacyNoByStatus');
}

function testDebatePromptWithAbsent() {
  const orch = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q1', {
    'sid-claude': 'Claude opinion',
    'sid-gemini': '',
    'sid-codex': 'Codex opinion',
  }, {}, {
    'sid-claude': 'completed',
    'sid-gemini': 'absent',
    'sid-codex': 'completed',
  });
  const last = orch.getLastTurn();
  // Codex 视角看 debate prompt：应该看到 Claude 的真实观点 + Gemini 的未参与说明
  const prompt = buildDebate(orch, 2, 'q2', last, 'sid-codex', sidLabel);
  assert.ok(prompt.includes('Claude opinion'), 'must include Claude real opinion');
  assert.ok(prompt.includes('Gemini 本轮因故未参与'), 'must mark Gemini as absent');
  assert.ok(!prompt.includes('Codex opinion'), 'must NOT include Codex own opinion (targetSid filter)');
  cleanupTmp();
  console.log('  ✓ testDebatePromptWithAbsent');
}

function testDebatePromptWithErrored() {
  const orch = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q1', {
    'sid-claude': '',
    'sid-gemini': 'Gemini opinion',
    'sid-codex': 'Codex opinion',
  }, {}, {
    'sid-claude': 'errored',
    'sid-gemini': 'completed',
    'sid-codex': 'completed',
  });
  const last = orch.getLastTurn();
  const prompt = buildDebate(orch, 2, '', last, 'sid-gemini', sidLabel);
  assert.ok(prompt.includes('Claude 本轮发生错误未输出'), 'must mark Claude as errored');
  assert.ok(prompt.includes('Codex opinion'), 'Codex real opinion still in prompt');
  cleanupTmp();
  console.log('  ✓ testDebatePromptWithErrored');
}

function testDebatePromptLegacyNoByStatus() {
  // 老格式：byStatus = null → 全部当 completed
  const orch = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q1', {
    'sid-claude': 'Claude opinion',
    'sid-gemini': 'Gemini opinion',
  }, {}); // 不传 byStatus
  const last = orch.getLastTurn();
  const prompt = buildDebate(orch, 2, '', last, 'sid-codex', sidLabel);
  assert.ok(prompt.includes('Claude opinion'));
  assert.ok(prompt.includes('Gemini opinion'));
  assert.ok(!/因故未参与/.test(prompt), 'legacy turn must not produce "absent" copy');
  cleanupTmp();
  console.log('  ✓ testDebatePromptLegacyNoByStatus');
}

function testManualExtractedTreatedAsCompleted() {
  // manual_extracted 在 prompt 中应该和 completed 一样正常引用
  const orch = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q1', {
    'sid-claude': 'Claude real',
    'sid-gemini': 'Gemini extracted',
  }, {}, {
    'sid-claude': 'completed',
    'sid-gemini': 'manual_extracted',
  });
  const last = orch.getLastTurn();
  const prompt = buildDebate(orch, 2, '', last, 'sid-claude', sidLabel);
  assert.ok(prompt.includes('Gemini extracted'),
    'manual_extracted text must be included in prompt as if it were completed');
  assert.ok(!/因故未参与|发生错误未输出/.test(prompt),
    'manual_extracted must not produce absent/errored copy');
  cleanupTmp();
  console.log('  ✓ testManualExtractedTreatedAsCompleted');
}

console.log('Running roundtable prompt absent/errored filter tests...');
testCompleteTurnAcceptsByStatus();
testCompleteTurnLegacyNoByStatus();
testDebatePromptWithAbsent();
testDebatePromptWithErrored();
testDebatePromptLegacyNoByStatus();
testManualExtractedTreatedAsCompleted();
console.log('All passed.');
