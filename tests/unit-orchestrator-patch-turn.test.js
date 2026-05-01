'use strict';
// FIX-F（2026-05-01）单测：orchestrator.patchTurnResult 行为锁定。
//
// 锁定不变量：
// 1. completed/manual_extracted 必须 patch by[sid] 文本 + byStatus[sid]
// 2. errored/absent 不改 by[sid]（保留空字符串），只 patch byStatus[sid]
// 3. thinkSecBy[sid] / tokensBy[sid] 按需更新
// 4. 不改 mode / userInput / meta / aiStats（避免重复累加）
// 5. lastPatchedAt 时间戳更新
// 6. 不存在的 turnNum 返回 null
// 7. 返回深拷贝（防止外部修改污染）

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 测试用临时数据目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-patch-test-'));
process.env.CLAUDE_HUB_DATA_DIR_TEST = TMP;

const roundtable = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

console.log('Running orchestrator.patchTurnResult tests...');

function freshOrch() {
  const meetingId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sceneObj = scenes.getScene('research') || scenes.getScene('general');
  const orch = roundtable.getOrchestrator(TMP, meetingId, sceneObj);
  // 模拟一个已完成的 turn：3 家中 codex errored
  orch.completeTurn(
    1,
    'fanout',
    '请分析兆易创新',
    {
      'sid-claude': 'Claude 的回答内容',
      'sid-gemini': 'Gemini 的回答内容',
      'sid-codex': '', // errored 没文本
    },
    {},
    {
      'sid-claude': 'completed',
      'sid-gemini': 'completed',
      'sid-codex': 'errored',
    },
    {
      thinkSecBy: { 'sid-claude': 30, 'sid-gemini': 25, 'sid-codex': 0 },
      tokensBy: { 'sid-claude': 1500, 'sid-gemini': 800, 'sid-codex': 0 },
      thinkSecByKind: { claude: 30, gemini: 25, codex: 0 },
      tokensByKind: { claude: 1500, gemini: 800, codex: 0 },
    }
  );
  return orch;
}

test('completed: patch by[sid] 文本 + byStatus + thinkSec + tokens', () => {
  const orch = freshOrch();
  const r = orch.patchTurnResult(1, 'sid-codex', {
    text: 'Codex 重新拉起后的新回答',
    status: 'completed',
    thinkSec: 22.3,
    tokens: { total: 1100 },
  });
  assert.ok(r, 'should return patched record');
  assert.strictEqual(r.by['sid-codex'], 'Codex 重新拉起后的新回答');
  assert.strictEqual(r.byStatus['sid-codex'], 'completed');
  assert.strictEqual(r.thinkSecBy['sid-codex'], 22.3);
  assert.strictEqual(r.tokensBy['sid-codex'], 1100);
  // 其他家不变
  assert.strictEqual(r.by['sid-claude'], 'Claude 的回答内容');
  assert.strictEqual(r.byStatus['sid-claude'], 'completed');
});

test('manual_extracted: 同 completed 也 patch by[sid] 文本', () => {
  const orch = freshOrch();
  const r = orch.patchTurnResult(1, 'sid-codex', {
    text: '从 transcript 提取的文本',
    status: 'manual_extracted',
  });
  assert.strictEqual(r.by['sid-codex'], '从 transcript 提取的文本');
  assert.strictEqual(r.byStatus['sid-codex'], 'manual_extracted');
});

test('errored: 不改 by[sid] 文本（保留 ""），仅 patch byStatus', () => {
  const orch = freshOrch();
  // 先把 codex 改成 completed（伪造场景：第一次 resend 成功）
  orch.patchTurnResult(1, 'sid-codex', { text: 'temp', status: 'completed' });
  // 第二次 resend 失败 errored，不应清空之前 patch 的 text
  const r = orch.patchTurnResult(1, 'sid-codex', { text: 'should-be-ignored', status: 'errored' });
  assert.strictEqual(r.by['sid-codex'], 'temp', 'errored should not overwrite by[sid] text');
  assert.strictEqual(r.byStatus['sid-codex'], 'errored');
});

test('absent: 同 errored 也不改 by[sid]', () => {
  const orch = freshOrch();
  orch.patchTurnResult(1, 'sid-codex', { text: 'temp', status: 'completed' });
  const r = orch.patchTurnResult(1, 'sid-codex', { text: '', status: 'absent' });
  assert.strictEqual(r.by['sid-codex'], 'temp');
  assert.strictEqual(r.byStatus['sid-codex'], 'absent');
});

test('不改 mode / userInput / meta', () => {
  const orch = freshOrch();
  const r = orch.patchTurnResult(1, 'sid-codex', { text: 'new', status: 'completed' });
  assert.strictEqual(r.mode, 'fanout');
  assert.strictEqual(r.userInput, '请分析兆易创新');
  assert.strictEqual(r.n, 1);
});

test('不重复累加 aiStats', () => {
  const orch = freshOrch();
  const beforeClaude = orch.state.aiStats?.claude?.totalThinkSec || 0;
  orch.patchTurnResult(1, 'sid-codex', {
    text: 'new', status: 'completed', thinkSec: 20, tokens: { total: 999 },
  });
  const afterClaude = orch.state.aiStats?.claude?.totalThinkSec || 0;
  assert.strictEqual(afterClaude, beforeClaude, 'aiStats must not be touched by patch (double-counting risk)');
});

test('lastPatchedAt 写入', () => {
  const orch = freshOrch();
  const before = Date.now();
  const r = orch.patchTurnResult(1, 'sid-codex', { text: 'x', status: 'completed' });
  assert.ok(typeof r.lastPatchedAt === 'number');
  assert.ok(r.lastPatchedAt >= before);
});

test('不存在的 turnNum 返回 null', () => {
  const orch = freshOrch();
  const r = orch.patchTurnResult(99, 'sid-codex', { text: 'x', status: 'completed' });
  assert.strictEqual(r, null);
});

test('返回深拷贝，外部修改不影响内部', () => {
  const orch = freshOrch();
  const r = orch.patchTurnResult(1, 'sid-codex', { text: 'x', status: 'completed' });
  r.by['sid-codex'] = 'mutated externally';
  const fresh = orch.getLastTurn();
  assert.strictEqual(fresh.by['sid-codex'], 'x', 'internal record must not be polluted by external mutation');
});

console.log('All passed.');
