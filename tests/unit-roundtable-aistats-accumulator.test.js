'use strict';
// roundtable-orchestrator aiStats 累加器（meeting-create-modal 2026-05-01 重构后）
//
// 新 schema：state.aiStats 按 sid 索引（让 3 个 Claude slot 各自独立累加），
// 每个 sid 项形如 { totalThinkSec, totalTokens, perTurnHistory, kind, model }。
// 老 kind 索引格式由 setMeetingContext 触发 migrateAiStats（migration 测试在
// orchestrator-aistats-migration.test.js）。
//
// 覆盖：
//   1. 初始化：state.aiStats 默认 {} (sid 索引化后无 kind 默认 entry)
//   2. completeTurn 接受 stats.thinkSecBy / tokensBy → state.aiStats[<sid>] 累加
//   3. record 写入 thinkSecBy / tokensBy 字段（per-sid，未变）
//   4. perTurnHistory 跨多轮累积，且仅当本轮该 sid 有数据（>0）时才写
//   5. 老 state.json（无 aiStats 字段）_loadState 自动补 {}
//   6. completeTurn 不传 stats 时累加器 no-op（向后兼容）
//   7. 多轮累计正确（totalThinkSec / totalTokens 单调递增）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RoundtableOrchestrator } = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

let _tmpRoot = null;
function setupTmp() {
  _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-aistats-test-'));
  return _tmpRoot;
}
function cleanupTmp() {
  if (_tmpRoot) { try { fs.rmSync(_tmpRoot, { recursive: true, force: true }); } catch {} _tmpRoot = null; }
}

function mkOrch() {
  const dir = setupTmp();
  const scene = scenes.getScene('general');
  const orch = new RoundtableOrchestrator(dir, 'm-test', scene);
  orch.setMeetingContext({
    'sid-claude': { kind: 'claude', model: 'claude-opus-4-7[1m]' },
    'sid-gemini': { kind: 'gemini', model: 'gemini-2.5-flash' },
    'sid-codex':  { kind: 'codex',  model: 'gpt-5.5' },
  });
  return orch;
}

function testInitialAiStats() {
  const orch = mkOrch();
  assert.ok(orch.state.aiStats, 'state.aiStats must exist after init');
  assert.deepStrictEqual(orch.state.aiStats, {}, 'sid 索引化后默认空对象（用到才创建）');
  cleanupTmp();
  console.log('  ✓ testInitialAiStats');
}

function testCompleteTurnAccumulates() {
  const orch = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q', {
    'sid-claude': 'C', 'sid-gemini': 'G', 'sid-codex': 'X',
  }, {}, null, {
    thinkSecBy: { 'sid-claude': 5.2, 'sid-gemini': 4.0, 'sid-codex': 3.5 },
    tokensBy:   { 'sid-claude': 0,   'sid-gemini': 1234, 'sid-codex': 0 },
  });
  assert.strictEqual(orch.state.aiStats['sid-claude'].totalThinkSec, 5.2);
  assert.strictEqual(orch.state.aiStats['sid-gemini'].totalTokens, 1234);
  assert.strictEqual(orch.state.aiStats['sid-codex'].totalThinkSec, 3.5);
  // kind/model 元数据透传
  assert.strictEqual(orch.state.aiStats['sid-claude'].kind, 'claude');
  assert.strictEqual(orch.state.aiStats['sid-gemini'].model, 'gemini-2.5-flash');
  cleanupTmp();
  console.log('  ✓ testCompleteTurnAccumulates');
}

function testRecordHasThinkSecBy() {
  const orch = mkOrch();
  orch.beginTurn('fanout');
  const rec = orch.completeTurn(1, 'fanout', 'q', { 'sid-claude': 'C' }, {}, null, {
    thinkSecBy: { 'sid-claude': 7.5 },
    tokensBy: { 'sid-claude': 250 },
  });
  assert.strictEqual(rec.thinkSecBy['sid-claude'], 7.5,
    'turn record must persist thinkSecBy field');
  assert.strictEqual(rec.tokensBy['sid-claude'], 250,
    'turn record must persist tokensBy field');
  cleanupTmp();
  console.log('  ✓ testRecordHasThinkSecBy');
}

function testPerTurnHistorySkipsZero() {
  const orch = mkOrch();
  orch.beginTurn('fanout');
  // codex 本轮无数据（0/0）→ 不应进 history
  orch.completeTurn(1, 'fanout', 'q', { 'sid-gemini': 'G', 'sid-claude': '', 'sid-codex': '' }, {}, null, {
    thinkSecBy: { 'sid-gemini': 4.0, 'sid-claude': 0, 'sid-codex': 0 },
    tokensBy:   { 'sid-gemini': 500, 'sid-claude': 0, 'sid-codex': 0 },
  });
  assert.strictEqual(orch.state.aiStats['sid-gemini'].perTurnHistory.length, 1,
    'gemini has data → history len 1');
  assert.strictEqual(orch.state.aiStats['sid-claude'].perTurnHistory.length, 0,
    'claude no data → skipped');
  assert.strictEqual(orch.state.aiStats['sid-codex'].perTurnHistory.length, 0,
    'codex no data → skipped');
  cleanupTmp();
  console.log('  ✓ testPerTurnHistorySkipsZero');
}

function testLegacyStateLoadFillsAiStats() {
  // 模拟旧 state.json（无 aiStats 字段）
  const dir = setupTmp();
  const stateDir = path.join(dir, 'arena-prompts');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'm-legacy-roundtable.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    meetingId: 'm-legacy', currentTurn: 0, currentMode: 'idle', turns: [],
  }));

  const orch = new RoundtableOrchestrator(dir, 'm-legacy', scenes.getScene('general'));
  assert.ok(orch.state.aiStats, '_loadState must fill aiStats {} for legacy file');
  assert.deepStrictEqual(orch.state.aiStats, {});
  cleanupTmp();
  console.log('  ✓ testLegacyStateLoadFillsAiStats');
}

function testNoStatsArgumentSkipsAccumulator() {
  // completeTurn 不传第 7 参 stats → aiStats 不变（空对象），向后兼容
  const orch = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q', { 'sid-claude': 'C' }, {}); // 仅 5 参
  assert.deepStrictEqual(orch.state.aiStats, {});
  cleanupTmp();
  console.log('  ✓ testNoStatsArgumentSkipsAccumulator');
}

function testMultiTurnCumulative() {
  const orch = mkOrch();
  // 3 轮，每轮 sid-gemini 思考 4s + 500 tokens
  for (let i = 1; i <= 3; i++) {
    orch.beginTurn('fanout');
    orch.completeTurn(i, 'fanout', `q${i}`, { 'sid-gemini': 'G' }, {}, null, {
      thinkSecBy: { 'sid-gemini': 4.0 },
      tokensBy: { 'sid-gemini': 500 },
    });
  }
  assert.strictEqual(orch.state.aiStats['sid-gemini'].totalThinkSec, 12,
    'sid-gemini total thinkSec accumulates 3 turns × 4s');
  assert.strictEqual(orch.state.aiStats['sid-gemini'].totalTokens, 1500,
    'sid-gemini total tokens accumulates 3 × 500');
  assert.strictEqual(orch.state.aiStats['sid-gemini'].perTurnHistory.length, 3,
    'history len = 3 turns');
  cleanupTmp();
  console.log('  ✓ testMultiTurnCumulative');
}

console.log('Running roundtable aiStats accumulator tests...');
testInitialAiStats();
testCompleteTurnAccumulates();
testRecordHasThinkSecBy();
testPerTurnHistorySkipsZero();
testLegacyStateLoadFillsAiStats();
testNoStatsArgumentSkipsAccumulator();
testMultiTurnCumulative();
console.log('All passed.');
