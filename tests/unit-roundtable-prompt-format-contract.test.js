'use strict';
// 锁定 build*Prompt 输出"第一行非空 + 含轮号 N"的契约（2026-05-03）
//
// 这个契约支撑：
//   - resendCurrentPrompt 用 prompt 第一行作 ring-buffer 指纹，必须非空
//   - turn meta 的 promptHeaderBy[sid] 须能区分不同轮次（含轮号）
// 如果将来 build*Prompt 头部格式调整违反此契约，CI 立即拦截，
// 提醒同步更新 spec / 实现 / 防漂移 fallback。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-promptfmt-'));
process.env.CLAUDE_HUB_DATA_DIR_TEST = TMP;

const roundtable = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

console.log('Running build*Prompt format contract tests...');

function freshOrch() {
  const meetingId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sceneObj = scenes.getScene('research') || scenes.getScene('general');
  return roundtable.getOrchestrator(TMP, meetingId, sceneObj);
}

function firstLine(s) {
  return String(s || '').split('\n')[0];
}

test('buildFanoutPrompt 第一行非空且含 "第 N 轮"', () => {
  const orch = freshOrch();
  const p = orch.buildFanoutPrompt(3, 'q', '', null, null, null);
  const fl = firstLine(p);
  assert.ok(fl.length > 0, '第一行非空');
  assert.ok(/第\s*3\s*轮/.test(fl), `第一行需含 "第 3 轮"，实际=${fl}`);
});

test('buildDebatePrompt 第一行非空且含 "第 N 轮"', () => {
  const orch = freshOrch();
  const p = orch.buildDebatePrompt(5, 'q', null, null, null);
  const fl = firstLine(p);
  assert.ok(fl.length > 0, '第一行非空');
  assert.ok(/第\s*5\s*轮/.test(fl), `第一行需含 "第 5 轮"，实际=${fl}`);
});

// 摘要功能 2026-05-08 整体下线：buildSummaryPrompt + buildBriefSummaryPrompt 已删
test('buildSummaryPrompt 已不存在（摘要功能下线）', () => {
  const orch = freshOrch();
  assert.strictEqual(typeof orch.buildSummaryPrompt, 'undefined', 'buildSummaryPrompt 已删除');
  assert.strictEqual(typeof orch.buildBriefSummaryPrompt, 'undefined', 'buildBriefSummaryPrompt 已删除');
});

const failed = process.exitCode || 0;
console.log(`\n${failed ? '✗' : '✓'} prompt format contract: ${3 - failed} passed\n`);
