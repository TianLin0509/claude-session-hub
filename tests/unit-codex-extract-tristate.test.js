'use strict';
// B1.1 — codex extract 4 态契约
// 喂 4 种 rollout fixture（用 fake-codex-rollout 现场生成）→ 期望 extractLatestTurn
// 返回的 extractMode 命中 Spec S2 的 4 个值之一：
//   final_answer            ← rollout 末尾命中 task_complete.last_agent_message
//   partial_commentary      ← 仅 agent_message，无 task_complete
//   no_task_complete_yet    ← 已绑定但 agent_message 全部为空 / 全部空白
//   no_rollout_bound        ← sessionsRoot 中没有任何匹配的 rollout 文件
//
// **依赖**：业务代码 GREEN 改动（B1.2）：
//   1. CodexTap constructor 接受 opts.sessionsRoot / opts.pollIntervalMs
//   2. extractLatestTurn 返回值新增 extractMode 字段
//
// 在 B1.2 落地前本测试预期失败（RED）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FakeCodexRollout } = require('../tests/helpers/fake-codex-rollout');
const { CodexTap } = require('../core/transcript-tap');

let failed = 0;

function _tmpRoot(label) {
  return path.join(os.tmpdir(), `codex-tristate-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

// 等绑定完成（poll 直到 _bound 出现 hubSessionId 或超时）
async function _waitForBind(tap, hubSessionId, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tap._bound.has(hubSessionId)) return true;
    await _sleep(50);
  }
  return false;
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === case 1: final_answer ===
async function testExtractModeFinalAnswer() {
  const tmpRoot = _tmpRoot('final');
  const cwd = 'C:\\test\\proj-final';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    await fr.writeFullTurn(['preview chunk'], 'final final final', { gapMs: 5 });
    await fr.close();

    const hubSid = 'hub-final-1';
    tap.registerSession(hubSid, { cwd });
    const bound = await _waitForBind(tap, hubSid);
    assert.ok(bound, 'CodexTap should bind to fake rollout within 2s');

    const r = await tap.extractLatestTurn(hubSid, 0);
    assert.ok(r, 'extractLatestTurn must return non-null');
    assert.strictEqual(r.text, 'final final final', 'text should be task_complete.last_agent_message');
    assert.strictEqual(r.extractMode, 'final_answer', `extractMode must be 'final_answer', got '${r.extractMode}'`);
    assert.strictEqual(r.source, 'manual_codex_rollout', 'source should be manual_codex_rollout');
  } finally {
    tap.unregisterSession('hub-final-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 2: partial_commentary ===
async function testExtractModePartialCommentary() {
  const tmpRoot = _tmpRoot('partial');
  const cwd = 'C:\\test\\proj-partial';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    await fr.writeStreamingOnly(['piece A', 'piece B', 'piece C'], { gapMs: 5 });
    await fr.close();

    const hubSid = 'hub-partial-1';
    tap.registerSession(hubSid, { cwd });
    const bound = await _waitForBind(tap, hubSid);
    assert.ok(bound, 'must bind');

    const r = await tap.extractLatestTurn(hubSid, 0);
    assert.ok(r, 'extractLatestTurn must return non-null for streaming-only');
    assert.ok(r.text.includes('piece A') && r.text.includes('piece C'), 'text must concat agent_messages');
    assert.strictEqual(r.extractMode, 'partial_commentary', `extractMode must be 'partial_commentary', got '${r.extractMode}'`);
    assert.strictEqual(r.source, 'manual_codex_rollout_streaming');
  } finally {
    tap.unregisterSession('hub-partial-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 3: no_task_complete_yet ===
async function testExtractModeNoTaskCompleteYet() {
  const tmpRoot = _tmpRoot('notask');
  const cwd = 'C:\\test\\proj-notask';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    // 只写 task_started + 一条空白 agent_message（模拟 codex 还在 think，没产出文本）
    await fr.writeTaskStarted();
    await fr.writeAgentMessage('   ');  // 全空白，extractLatestTurn 应过滤掉
    await fr.close();

    const hubSid = 'hub-notask-1';
    tap.registerSession(hubSid, { cwd });
    const bound = await _waitForBind(tap, hubSid);
    assert.ok(bound, 'must bind');

    const r = await tap.extractLatestTurn(hubSid, 0);
    // 4 态契约：bound 但无内容 → 必须返回 extractMode='no_task_complete_yet'，不再返回 null
    assert.ok(r, 'extractLatestTurn must return object (not null) when bound but no content');
    assert.strictEqual(r.extractMode, 'no_task_complete_yet', `extractMode must be 'no_task_complete_yet', got '${r.extractMode}'`);
    assert.strictEqual(r.text || '', '', 'text should be empty for no_task_complete_yet');
  } finally {
    tap.unregisterSession('hub-notask-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 4: no_rollout_bound ===
async function testExtractModeNoRolloutBound() {
  const tmpRoot = _tmpRoot('nobind');
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const hubSid = 'hub-nobind-1';
    // 故意只 register 不写 fixture → 永远无法 bind
    tap.registerSession(hubSid, { cwd: 'C:\\nonexistent\\dir' });
    await _sleep(150);  // 给 scan 一次机会，仍然找不到

    const r = await tap.extractLatestTurn(hubSid, 0);
    // 4 态契约：未绑定 → 必须返回 extractMode='no_rollout_bound'，不再返回 null
    assert.ok(r, 'extractLatestTurn must return object (not null) when no rollout bound');
    assert.strictEqual(r.extractMode, 'no_rollout_bound', `extractMode must be 'no_rollout_bound', got '${r.extractMode}'`);
    assert.strictEqual(r.text || '', '', 'text should be empty for no_rollout_bound');
  } finally {
    tap.unregisterSession('hub-nobind-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// === case 5: 跨 sincePromptTs 过滤后命中 final_answer ===
//   验证 extractMode 判定不会被 sincePromptTs 时间过滤"误降级"为 partial_commentary
//   注意：必须用 now-relative 时间，否则 CodexTap 绑定窗口 [-10s, +5min] 会拒绝过去时间戳
async function testExtractModeFinalAnswerWithSinceTsFilter() {
  const tmpRoot = _tmpRoot('finalts');
  const cwd = 'C:\\test\\proj-finalts';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const baseTime = new Date();  // 用 now 让 spawnTime 落在绑定窗口内
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, startAt: baseTime });
    await fr.start();
    // turn 1: 在 baseTime+50ms 完成（应被 sincePromptTs 过滤掉）
    await fr.writeAgentMessage('old turn msg', { at: new Date(baseTime.getTime() + 50) });
    await fr.writeTaskComplete('old turn final', 500, { at: new Date(baseTime.getTime() + 100) });
    // turn 2: 在 baseTime+200ms 完成
    await fr.writeAgentMessage('new turn msg', { at: new Date(baseTime.getTime() + 200) });
    await fr.writeTaskComplete('new turn final', 600, { at: new Date(baseTime.getTime() + 250) });
    await fr.close();

    const hubSid = 'hub-finalts-1';
    tap.registerSession(hubSid, { cwd });
    const bound = await _waitForBind(tap, hubSid);
    assert.ok(bound, 'must bind');

    // sincePromptTs 设在 turn 1 和 turn 2 之间
    const sincePromptTs = baseTime.getTime() + 150;
    const r = await tap.extractLatestTurn(hubSid, sincePromptTs);
    assert.ok(r, 'must return result');
    assert.strictEqual(r.text, 'new turn final', 'text should be turn 2 final, not turn 1');
    assert.strictEqual(r.extractMode, 'final_answer', 'must be final_answer (not partial)');
  } finally {
    tap.unregisterSession('hub-finalts-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === runner ===

const tests = [
  testExtractModeFinalAnswer,
  testExtractModePartialCommentary,
  testExtractModeNoTaskCompleteYet,
  testExtractModeNoRolloutBound,
  testExtractModeFinalAnswerWithSinceTsFilter,
];

(async () => {
  for (const t of tests) {
    try {
      await t();
      console.log('  ✓', t.name);
    } catch (e) {
      console.error('  ✗', t.name);
      console.error('    ', e.stack || e.message);
      failed++;
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
