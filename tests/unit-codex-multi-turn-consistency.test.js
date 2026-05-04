'use strict';
// Phase 4 — codex 多轮一致性契约测试（Spec S6）
//
// 覆盖：
//   S6a · fanout 完成判定：仅 task_complete (+ 3s debounce) 触发 turn-complete；
//         agent_message / task_started 不应触发
//   S6b · summary 模式取 final：extractLatestTurn 在含 task_complete 时返回 final_answer，
//         不使用 partial_commentary
//   S6 fanout 非阻塞：watcher 实例之间互不依赖（每 sid 独立）
//
// S6c (observer) / S6d (pilot) 因涉及 dispatch / orchestrator 全链路，留给 E2E 验证。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { CodexTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('../tests/helpers/fake-codex-rollout');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');

let failed = 0;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function _tmpRoot(label) {
  return path.join(os.tmpdir(), `codex-s6-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

async function _waitForBind(tap, hubSessionId, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tap._bound.has(hubSessionId)) return true;
    await _sleep(50);
  }
  return false;
}

// === S6a: agent_message 不触发 turn-complete ===
async function testAgentMessageDoesNotTriggerTurnComplete() {
  const tmpRoot = _tmpRoot('agent-only');
  const cwd = 'C:\\test\\s6a';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const events = [];
  tap.on('turn-complete', (ev) => events.push(ev));

  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    await fr.writeStreamingOnly(['commentary 1', 'commentary 2'], { gapMs: 5 });
    await fr.close();

    const hubSid = 'hub-s6a-1';
    tap.registerSession(hubSid, { cwd });
    await _waitForBind(tap, hubSid);

    // 给 tail 时间消费所有行
    await _sleep(200);
    assert.strictEqual(events.length, 0, `agent_message must NOT trigger turn-complete, got ${events.length} events`);
  } finally {
    tap.unregisterSession('hub-s6a-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === S6a: task_complete 触发 turn-complete（debounce 后）===
async function testTaskCompleteTriggersTurnCompleteWithDebounce() {
  const tmpRoot = _tmpRoot('debounce');
  const cwd = 'C:\\test\\s6a-debounce';
  // 用更短的 debounce 窗口加速测试（但 transcript-tap 写死 3s，无法外注入）
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const events = [];
  tap.on('turn-complete', (ev) => events.push(ev));

  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    await fr.writeAgentMessage('preview');
    await fr.writeTaskComplete('final answer', 100);
    await fr.close();

    const hubSid = 'hub-s6a-2';
    tap.registerSession(hubSid, { cwd });
    await _waitForBind(tap, hubSid);
    // task_complete 后 3s debounce → 等 3.5s 看 emit
    await _sleep(3500);

    assert.strictEqual(events.length, 1, 'task_complete after debounce must emit exactly once');
    assert.strictEqual(events[0].text, 'final answer');
    assert.strictEqual(events[0].signalSource, 'task_complete');
  } finally {
    tap.unregisterSession('hub-s6a-2');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === S6a: 多 task 场景 — 第一个 task_complete 后又开始 task_started → 取消 pending ===
async function testMultiTaskCancelsPending() {
  const tmpRoot = _tmpRoot('multi-task');
  const cwd = 'C:\\test\\s6a-multi';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const events = [];
  tap.on('turn-complete', (ev) => events.push(ev));

  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    // 第一个 task：started → completed（mid-task）
    await fr.writeTaskStarted();
    await fr.writeTaskComplete('mid task answer', 50);
    // 立即又 task_started → 取消 mid-task 的 pending emit
    await fr.writeTaskStarted();
    // 不再写 task_complete → 永远不应 emit
    await fr.close();

    const hubSid = 'hub-s6a-3';
    tap.registerSession(hubSid, { cwd });
    await _waitForBind(tap, hubSid);
    await _sleep(3500);   // 跨过 3s debounce

    assert.strictEqual(events.length, 0, 'new task_started must cancel pending emit; no turn-complete should fire');
  } finally {
    tap.unregisterSession('hub-s6a-3');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === S6b: summary 模式 extract 取 final_answer ===
async function testSummaryModeUsesFinalAnswer() {
  const tmpRoot = _tmpRoot('summary');
  const cwd = 'C:\\test\\s6b';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });

  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    // 写 commentary + final
    await fr.writeAgentMessage('intermediate thinking');
    await fr.writeAgentMessage('more processing');
    await fr.writeTaskComplete('final summarized result', 200);
    await fr.close();

    const hubSid = 'hub-s6b-1';
    tap.registerSession(hubSid, { cwd });
    await _waitForBind(tap, hubSid);

    const r = await tap.extractLatestTurn(hubSid, 0);
    // S6b 契约：含 task_complete 时 → 必须用 final，不退到 partial commentary
    assert.strictEqual(r.extractMode, 'final_answer', 'must use final_answer not partial_commentary');
    assert.strictEqual(r.text, 'final summarized result');
    // 不应包含 commentary 文本
    assert.ok(!r.text.includes('intermediate thinking'), 'final extract must not concat commentary');
  } finally {
    tap.unregisterSession('hub-s6b-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === S6 fanout 非阻塞：两个 watcher 互不依赖 ===
async function testTwoWatchersAreIndependent() {
  const tap = new EventEmitter();
  const watcherA = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-A',
    label: 'pikachu',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });
  const watcherB = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-B',
    label: 'charmander',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  const pA = watcherA.wait();
  const pB = watcherB.wait();

  // A 立即完成
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'A done', signalSource: 'task_complete' });
  const rA = await pA;

  assert.strictEqual(rA.status, 'completed');
  assert.strictEqual(rA.text, 'A done');
  // B 应仍未 settle
  assert.strictEqual(watcherB.isSettled(), false, 'B watcher must not settle when A completes');

  // 现在让 B 也完成
  tap.emit('turn-complete', { hubSessionId: 'sid-B', text: 'B done', signalSource: 'task_complete' });
  const rB = await pB;
  assert.strictEqual(rB.status, 'completed');
  assert.strictEqual(rB.text, 'B done');
}

// === S6 fanout 非阻塞：B errored 不影响 A ===
async function testWatcherErrorIsolation() {
  const tap = new EventEmitter();
  const watcherA = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-A',
    label: 'pikachu',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });
  const watcherB = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-B',
    label: 'charmander',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  const pA = watcherA.wait();
  const pB = watcherB.wait();

  tap.emit('turn-error', { hubSessionId: 'sid-B', reason: 'pty-died' });
  const rB = await pB;
  assert.strictEqual(rB.status, 'errored');
  // A 仍未 settle
  assert.strictEqual(watcherA.isSettled(), false, 'A must not be affected by B error');

  // A 仍能正常完成
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'A still good', signalSource: 'task_complete' });
  const rA = await pA;
  assert.strictEqual(rA.status, 'completed');
  assert.strictEqual(rA.text, 'A still good');
}

// === runner ===

const tests = [
  testAgentMessageDoesNotTriggerTurnComplete,
  testTaskCompleteTriggersTurnCompleteWithDebounce,
  testMultiTaskCancelsPending,
  testSummaryModeUsesFinalAnswer,
  testTwoWatchersAreIndependent,
  testWatcherErrorIsolation,
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
