'use strict';
// meeting-create-modal Task 5（2026-05-01）— migrateAiStats helper 单测：
//   1. 老 kind 索引格式（含 claude/gemini/codex）+ sidToInfoMap → sid 索引化
//   2. 同 kind 多 sid（3 Claude slot）：累计仅划给第一个 sid，其余起 0（不重复累加）
//   3. 新 sid 索引格式（无 claude/gemini/codex 顶层 key）→ 直通不动
//   4. 缺失 sidToInfoMap → 返回 {}（迁移失败丢累计统计 per spec §4.4）
//   5. RoundtableOrchestrator.setMeetingContext 触发自动迁移
//   6. completeTurn 给新 sid 项写入 kind/model 元数据

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { RoundtableOrchestrator, migrateAiStats, _isLegacyKindKeyed } = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

let _tmpRoot = null;
function setupTmp() { _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mig-')); return _tmpRoot; }
function cleanupTmp() { if (_tmpRoot) { try { fs.rmSync(_tmpRoot, { recursive: true, force: true }); } catch {} _tmpRoot = null; } }

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running orchestrator migrateAiStats tests...');

test('_isLegacyKindKeyed detects old format', () => {
  assert.strictEqual(_isLegacyKindKeyed({}), false);
  assert.strictEqual(_isLegacyKindKeyed({ 'sid-xxx': { totalThinkSec: 0, totalTokens: 0 } }), false);
  assert.strictEqual(_isLegacyKindKeyed({ claude: { totalThinkSec: 0, totalTokens: 0 } }), true);
  assert.strictEqual(_isLegacyKindKeyed({ gemini: { totalTokens: 100 } }), true);
});

test('migrateAiStats: kind-indexed → sid-indexed', () => {
  const old = {
    claude: { totalThinkSec: 100, totalTokens: 5000, perTurnHistory: [{n:1, thinkSec:100, tokens:5000, ts:0}] },
    gemini: { totalThinkSec: 50, totalTokens: 3000, perTurnHistory: [] },
    codex:  { totalThinkSec: 30, totalTokens: 2000, perTurnHistory: [] },
  };
  const sidInfo = {
    'sid-aaa': { kind: 'claude', model: 'claude-opus-4-7[1m]' },
    'sid-bbb': { kind: 'gemini', model: 'gemini-2.5-flash' },
    'sid-ccc': { kind: 'codex',  model: 'gpt-5.5' },
  };
  const m = migrateAiStats(old, sidInfo);
  assert.strictEqual(m['sid-aaa'].totalThinkSec, 100);
  assert.strictEqual(m['sid-aaa'].kind, 'claude');
  assert.strictEqual(m['sid-aaa'].model, 'claude-opus-4-7[1m]');
  assert.strictEqual(m['sid-bbb'].totalTokens, 3000);
  assert.strictEqual(m['sid-ccc'].totalThinkSec, 30);
  assert.strictEqual(m['sid-aaa'].perTurnHistory.length, 1);
});

test('migrateAiStats: 3 Claude slots — first claims old totals, others zero', () => {
  const old = {
    claude: { totalThinkSec: 60, totalTokens: 4000, perTurnHistory: [] },
  };
  const sidInfo = {
    'sid-c1': { kind: 'claude', model: 'claude-opus-4-7[1m]' },
    'sid-c2': { kind: 'claude', model: 'claude-sonnet-4-5' },
    'sid-c3': { kind: 'claude', model: 'claude-opus-4-6' },
  };
  const m = migrateAiStats(old, sidInfo);
  assert.strictEqual(m['sid-c1'].totalThinkSec, 60);
  assert.strictEqual(m['sid-c2'].totalThinkSec, 0);
  assert.strictEqual(m['sid-c3'].totalThinkSec, 0);
  assert.strictEqual(m['sid-c2'].kind, 'claude');
  assert.strictEqual(m['sid-c3'].model, 'claude-opus-4-6');
});

test('migrateAiStats: new sid format passes through unchanged', () => {
  const newFormat = { 'sid-xxx': { totalThinkSec: 10, totalTokens: 500, kind: 'deepseek', perTurnHistory: [] } };
  const m = migrateAiStats(newFormat, { 'sid-xxx': { kind: 'deepseek' } });
  assert.deepStrictEqual(m, newFormat);
});

test('migrateAiStats: empty sidInfo → {} (lose stats per spec)', () => {
  const old = { claude: { totalThinkSec: 100, totalTokens: 5000 } };
  const m = migrateAiStats(old, {});
  assert.deepStrictEqual(m, {});
});

test('migrateAiStats: null/undefined inputs → {}', () => {
  assert.deepStrictEqual(migrateAiStats(null, {}), {});
  assert.deepStrictEqual(migrateAiStats(undefined, {}), {});
});

test('setMeetingContext on legacy state file triggers migration', () => {
  const dir = setupTmp();
  const stateDir = path.join(dir, 'arena-prompts');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'm-legacy-roundtable.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    meetingId: 'm-legacy', currentTurn: 1, currentMode: 'idle', turns: [],
    aiStats: {
      claude: { totalThinkSec: 200, totalTokens: 8000, perTurnHistory: [] },
      gemini: { totalThinkSec: 80, totalTokens: 0, perTurnHistory: [] },
      codex:  { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
    },
  }));

  const orch = new RoundtableOrchestrator(dir, 'm-legacy', scenes.getScene('general'));
  // Before setMeetingContext, aiStats is still legacy (load preserved as-is)
  assert.ok(_isLegacyKindKeyed(orch.state.aiStats), 'pre-migration: still legacy');

  orch.setMeetingContext({
    'sid-A': { kind: 'claude', model: 'claude-opus-4-7[1m]' },
    'sid-B': { kind: 'gemini', model: 'gemini-2.5-pro' },
    'sid-C': { kind: 'codex',  model: 'gpt-5.5' },
  });

  assert.strictEqual(orch.state.aiStats['sid-A'].totalThinkSec, 200);
  assert.strictEqual(orch.state.aiStats['sid-B'].totalThinkSec, 80);
  assert.strictEqual(orch.state.aiStats['sid-C'].totalThinkSec, 0);
  assert.ok(!orch.state.aiStats.claude, 'no kind-keyed entries after migration');
  cleanupTmp();
});

test('completeTurn writes sid-keyed accumulator with kind/model', () => {
  const dir = setupTmp();
  const orch = new RoundtableOrchestrator(dir, 'm-new', scenes.getScene('general'));
  orch.setMeetingContext({
    'sid-X': { kind: 'deepseek', model: 'deepseek-v4-pro' },
    'sid-Y': { kind: 'glm', model: 'glm-4.6' },
  });
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q', { 'sid-X': 'ans-X', 'sid-Y': 'ans-Y' }, {}, null, {
    thinkSecBy: { 'sid-X': 4.5, 'sid-Y': 3.0 },
    tokensBy:   { 'sid-X': 800, 'sid-Y': 600 },
  });
  assert.strictEqual(orch.state.aiStats['sid-X'].totalThinkSec, 4.5);
  assert.strictEqual(orch.state.aiStats['sid-X'].kind, 'deepseek');
  assert.strictEqual(orch.state.aiStats['sid-X'].model, 'deepseek-v4-pro');
  assert.strictEqual(orch.state.aiStats['sid-Y'].totalTokens, 600);
  assert.strictEqual(orch.state.aiStats['sid-Y'].kind, 'glm');
  cleanupTmp();
});

test('multi-turn cumulative for same sid', () => {
  const dir = setupTmp();
  const orch = new RoundtableOrchestrator(dir, 'm-cum', scenes.getScene('general'));
  orch.setMeetingContext({ 'sid-G': { kind: 'gemini', model: 'gemini-2.5-flash' } });
  for (let i = 1; i <= 3; i++) {
    orch.beginTurn('fanout');
    orch.completeTurn(i, 'fanout', `q${i}`, { 'sid-G': `a${i}` }, {}, null, {
      thinkSecBy: { 'sid-G': 4 },
      tokensBy: { 'sid-G': 500 },
    });
  }
  assert.strictEqual(orch.state.aiStats['sid-G'].totalThinkSec, 12);
  assert.strictEqual(orch.state.aiStats['sid-G'].totalTokens, 1500);
  assert.strictEqual(orch.state.aiStats['sid-G'].perTurnHistory.length, 3);
  cleanupTmp();
});

console.log('All passed.');
