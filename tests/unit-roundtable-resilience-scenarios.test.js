'use strict';
// Stage 2 P0-17 集成测试：6 个容错升级核心场景。
//
// 覆盖（与 plan/spec 的 6 场景一一对应）：
//   1. 正常：三家 90s 内完成，无 banner，watcher 全 settle 为 completed
//   2. Gemini 慢响应 30s：自然完成（仍在 T1=90s 之前），不触发 soft alert
//   3. Gemini 假死：90s+ 仍无 turn-complete → onSoftAlert 触发，但 watcher 不自动 settle；
//                   用户调 manualExtract(text) 后才 settle 为 manual_extracted
//   4. 用户跳过 Gemini：watcher.skip() → settle 为 absent；下游 prompt builder 写"未参与"
//   5. Codex 多 turn：连续两次 turn-complete 事件——第一次后 watcher 已 settle，第二次被忽略
//   6. 三家全错：3 个 watcher 都 emit turn-error → 都 settle 为 errored；
//                Promise.allSettled 不阻塞、下游 prompt 写"发生错误未输出"
//
// 不依赖真实 Hub 启动（隔离 Hub + CDP UI E2E 留给用户手测，按 plan 设计章节"E2E 必须真人 UI 操作"
// 铁律执行）。本测试只做单进程 mock 驱动的状态机集成验证，CI 可重复跑。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');
const { RoundtableOrchestrator } = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

function mkTap() { return new EventEmitter(); }

function mkOrch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-resilience-test-'));
  return {
    orch: new RoundtableOrchestrator(dir, 'm-test', scenes.getScene('general')),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const sidLabel = sid => ({
  'sid-claude': 'Claude',
  'sid-gemini': 'Gemini',
  'sid-codex':  'Codex',
}[sid] || 'AI');

// ---- 场景 1：正常路径 ----
async function scenario1_AllNormal() {
  const tap = mkTap();
  const watchers = ['sid-claude', 'sid-gemini', 'sid-codex'].map(sid =>
    createTurnCompletionWatcher({
      transcriptTap: tap, hubSessionId: sid, label: sidLabel(sid),
      softAlertT1Ms: 5000, softAlertT2Ms: 10000, // 不会在测试期内触发
    })
  );
  const promises = watchers.map(w => w.wait());
  // 三家都在合理时间内 emit turn-complete
  setImmediate(() => {
    tap.emit('turn-complete', { hubSessionId: 'sid-claude', text: 'C', signalSource: 'hook_stop' });
    tap.emit('turn-complete', { hubSessionId: 'sid-gemini', text: 'G', signalSource: 'result_event' });
    tap.emit('turn-complete', { hubSessionId: 'sid-codex',  text: 'X', signalSource: 'task_complete' });
  });
  const settled = await Promise.allSettled(promises);
  const results = settled.map(s => s.value);
  assert.ok(results.every(r => r.status === 'completed'),
    'scenario 1: all 3 must be completed');
  assert.deepStrictEqual(results.map(r => r.signalSource).sort(),
    ['hook_stop', 'result_event', 'task_complete'].sort(),
    'each AI uses its own L1 signal source');
  console.log('  ✓ scenario1_AllNormal');
}

// ---- 场景 2：Gemini 慢响应 30s（仍在 T1=90s 前）----
async function scenario2_SlowResponseUnderT1() {
  const tap = mkTap();
  const alerts = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-gemini', label: 'Gemini',
    softAlertT1Ms: 200, softAlertT2Ms: 500,
    onSoftAlert: level => alerts.push(level),
  });
  const p = w.wait();
  // 80ms 后 emit（远低于 T1=200ms）
  setTimeout(() => tap.emit('turn-complete', {
    hubSessionId: 'sid-gemini', text: 'slow but ok', signalSource: 'tokens_total'
  }), 80);
  const r = await p;
  assert.strictEqual(r.status, 'completed');
  assert.deepStrictEqual(alerts, [], 'no soft alert if completed before T1');
  console.log('  ✓ scenario2_SlowResponseUnderT1');
}

// ---- 场景 3：Gemini 假死 90s+ → 软提醒 → 用户 manual extract ----
async function scenario3_DeadlockManualExtract() {
  const tap = mkTap();
  const alerts = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-gemini', label: 'Gemini',
    softAlertT1Ms: 50,  // 50ms 模拟 90s
    softAlertT2Ms: 100, // 100ms 模拟 180s
    onSoftAlert: level => alerts.push(level),
  });
  const p = w.wait();
  // 等过 T2 + 余量
  await new Promise(r => setTimeout(r, 150));
  assert.deepStrictEqual(alerts, ['t1', 't2'],
    'both T1 and T2 alerts must fire when watcher stays unsettled');
  assert.strictEqual(w.isSettled(), false,
    'watcher must NOT auto-settle on soft alerts (key invariant)');
  // 用户在 UI 点"一键提取"
  w.manualExtract('extracted from JSONL bypass');
  const r = await p;
  assert.strictEqual(r.status, 'manual_extracted');
  assert.strictEqual(r.text, 'extracted from JSONL bypass');
  assert.strictEqual(r.signalSource, 'manual');
  console.log('  ✓ scenario3_DeadlockManualExtract');
}

// ---- 场景 4：用户跳过 Gemini + 下游 prompt 过滤 ----
async function scenario4_SkipParticipantPropagatesToPrompt() {
  const tap = mkTap();
  const watchers = {
    'sid-claude': createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 'sid-claude', label: 'Claude', softAlertT1Ms: 5000, softAlertT2Ms: 10000 }),
    'sid-gemini': createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 'sid-gemini', label: 'Gemini', softAlertT1Ms: 5000, softAlertT2Ms: 10000 }),
    'sid-codex':  createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 'sid-codex',  label: 'Codex',  softAlertT1Ms: 5000, softAlertT2Ms: 10000 }),
  };
  const promises = Object.entries(watchers).map(([sid, w]) => w.wait().then(r => [sid, r]));

  setImmediate(() => {
    tap.emit('turn-complete', { hubSessionId: 'sid-claude', text: 'C answer', signalSource: 'hook_stop' });
    watchers['sid-gemini'].skip(); // 用户在 UI 点"跳过"
    tap.emit('turn-complete', { hubSessionId: 'sid-codex',  text: 'X answer', signalSource: 'task_complete' });
  });
  const settled = await Promise.allSettled(promises);
  const byMap = {}, byStatus = {};
  for (const s of settled) {
    const [sid, r] = s.value;
    byMap[sid] = r.text || '';
    byStatus[sid] = r.status;
  }
  assert.deepStrictEqual(byStatus, {
    'sid-claude': 'completed',
    'sid-gemini': 'absent',
    'sid-codex':  'completed',
  }, 'skip must produce status=absent');

  // 完成本轮 + 写下一轮 debate prompt（Codex 视角）
  const { orch, cleanup } = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q1', byMap, {}, byStatus);
  const last = orch.getLastTurn();
  const prompt = orch.buildDebatePrompt(2, 'q2', last, 'sid-codex', sidLabel);
  assert.ok(prompt.includes('C answer'), 'Claude real opinion in prompt');
  assert.ok(prompt.includes('Gemini 本轮因故未参与'), 'Gemini absent → "因故未参与"');
  cleanup();
  console.log('  ✓ scenario4_SkipParticipantPropagatesToPrompt');
}

// ---- 场景 5：Codex 多 turn 重复 emit（保护幂等）----
async function scenario5_CodexMultiTurnIdempotent() {
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-codex', label: 'Codex',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => {
    // 第一次 task_complete（真实完成）
    tap.emit('turn-complete', { hubSessionId: 'sid-codex', text: 'first answer', signalSource: 'task_complete' });
    // 第二次（多 turn 误判，应被忽略）
    setTimeout(() => tap.emit('turn-complete', { hubSessionId: 'sid-codex', text: 'spurious second', signalSource: 'task_complete' }), 10);
  });
  await new Promise(r => setTimeout(r, 50));
  const result = await p;
  assert.strictEqual(result.text, 'first answer',
    'first settle wins; second turn-complete is ignored after settle');
  console.log('  ✓ scenario5_CodexMultiTurnIdempotent');
}

// ---- 场景 6：三家全错 ----
async function scenario6_AllErrored() {
  const tap = mkTap();
  const watchers = ['sid-claude', 'sid-gemini', 'sid-codex'].map(sid =>
    createTurnCompletionWatcher({
      transcriptTap: tap, hubSessionId: sid, label: sidLabel(sid),
      softAlertT1Ms: 5000, softAlertT2Ms: 10000,
    })
  );
  const promises = watchers.map(w => w.wait());
  setImmediate(() => {
    tap.emit('turn-error', { hubSessionId: 'sid-claude', reason: 'pty exit 1' });
    tap.emit('turn-error', { hubSessionId: 'sid-gemini', reason: 'OAuth expired' });
    tap.emit('turn-error', { hubSessionId: 'sid-codex',  reason: 'rate limit' });
  });
  const settled = await Promise.allSettled(promises);
  const results = settled.map(s => s.value);
  assert.ok(results.every(r => r.status === 'errored'),
    'scenario 6: all 3 must be errored (Promise.allSettled does not block on any)');

  // 下游 prompt builder 应该全部加注 "发生错误未输出"
  const { orch, cleanup } = mkOrch();
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', 'q', {
    'sid-claude': '',
    'sid-gemini': '',
    'sid-codex': '',
  }, {}, {
    'sid-claude': 'errored',
    'sid-gemini': 'errored',
    'sid-codex':  'errored',
  });
  const last = orch.getLastTurn();
  // Claude 视角：另两家都 errored
  const prompt = orch.buildDebatePrompt(2, '', last, 'sid-claude', sidLabel);
  assert.ok(/Gemini 本轮发生错误未输出/.test(prompt), 'prompt must mark Gemini errored');
  assert.ok(/Codex 本轮发生错误未输出/.test(prompt), 'prompt must mark Codex errored');
  cleanup();
  console.log('  ✓ scenario6_AllErrored');
}

(async () => {
  console.log('Running roundtable resilience integration scenarios...');
  await scenario1_AllNormal();
  await scenario2_SlowResponseUnderT1();
  await scenario3_DeadlockManualExtract();
  await scenario4_SkipParticipantPropagatesToPrompt();
  await scenario5_CodexMultiTurnIdempotent();
  await scenario6_AllErrored();
  console.log('All passed.');
})().catch(e => {
  console.error('FAIL:', e);
  process.exit(1);
});
