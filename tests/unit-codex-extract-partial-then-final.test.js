'use strict';
// B1.6 RED — 用户先手动拉到 partial，之后 codex task_complete 来了 final → 必须 patch 覆盖
//
// 真 bug 暴露：
//   现状 patchListener 限制：
//     1. 只在 status='completed' 时挂（line 81）—— manual_extracted 不挂
//     2. signalSource 白名单只含 'stop_reason_terminal' / 'stop_hook'，不含 codex 'task_complete'
//   两条限制叠加 → codex partial→final 永远不 patch → 卡片永久停在 partial
//
// B1.7 GREEN 修补：
//   1. patchListener 也在 status='manual_extracted' 时挂
//   2. 白名单加 'task_complete'
//
// 注：本文件 B1.7 GREEN 落地前 RED 失败（onTurnPatched 不会被调用）。

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');

let failed = 0;

function _makeFakeTap() { return new EventEmitter(); }
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === case 1: manual_extracted (partial) → 后续 codex task_complete (final) → onTurnPatched 调用 ===
async function testManualExtractedThenCodexFinalPatch() {
  const tap = _makeFakeTap();
  const patches = [];
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-patch-1',
    label: 'pikachu',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
    onTurnPatched: (ev) => patches.push(ev),
    patchWindowMs: 5000,
  });

  const p = watcher.wait();
  // 第一步：用户手动提取 partial
  watcher.manualExtract('partial commentary text');
  const result = await p;
  assert.strictEqual(result.status, 'manual_extracted');
  assert.strictEqual(result.text, 'partial commentary text');

  // 第二步：codex 真的完成 → emit turn-complete with task_complete signal
  await _sleep(20);
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-1',
    text: 'partial commentary text plus the final answer all complete',
    signalSource: 'task_complete',
    completedAt: Date.now(),
  });
  await _sleep(30);

  assert.strictEqual(patches.length, 1, 'onTurnPatched must fire exactly once for codex final');
  assert.strictEqual(patches[0].sid, 'sid-patch-1');
  assert.strictEqual(patches[0].text, 'partial commentary text plus the final answer all complete');
  assert.strictEqual(patches[0].status, 'completed', 'patch event status should mark as completed');
}

// === case 2: completed → 后续更长 task_complete final → patch ===
async function testCompletedThenLongerFinalPatch() {
  const tap = _makeFakeTap();
  const patches = [];
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-patch-2',
    label: 'charmander',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
    onTurnPatched: (ev) => patches.push(ev),
    patchWindowMs: 5000,
  });

  const p = watcher.wait();
  // 第一次 emit：codex 第一个 task_complete（多 task 场景未完结的中间态）
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-2',
    text: 'mid-task answer',
    signalSource: 'task_complete',
  });
  const result = await p;
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.text, 'mid-task answer');

  // 第二次 emit：codex 真正最终 task_complete（更长更准）
  await _sleep(20);
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-2',
    text: 'mid-task answer extended and finalized with conclusion',
    signalSource: 'task_complete',
  });
  await _sleep(30);

  assert.strictEqual(patches.length, 1, 'longer final must trigger patch');
  assert.strictEqual(patches[0].text, 'mid-task answer extended and finalized with conclusion');
}

// === case 3: 同 text 重复 emit 不 patch（防风暴）===
async function testSameTextDoesNotTriggerPatch() {
  const tap = _makeFakeTap();
  const patches = [];
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-patch-3',
    label: 'squirtle',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
    onTurnPatched: (ev) => patches.push(ev),
    patchWindowMs: 5000,
  });

  const p = watcher.wait();
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-3',
    text: 'same text',
    signalSource: 'task_complete',
  });
  await p;

  await _sleep(20);
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-3',
    text: 'same text',
    signalSource: 'task_complete',
  });
  await _sleep(30);

  assert.strictEqual(patches.length, 0, 'same text must not trigger patch');
}

// === case 4: 更短 text 不 patch（防回退）===
async function testShorterTextDoesNotTriggerPatch() {
  const tap = _makeFakeTap();
  const patches = [];
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-patch-4',
    label: 'wartortle',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
    onTurnPatched: (ev) => patches.push(ev),
    patchWindowMs: 5000,
  });

  const p = watcher.wait();
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-4',
    text: 'longer initial text complete',
    signalSource: 'task_complete',
  });
  await p;

  await _sleep(20);
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-4',
    text: 'short',
    signalSource: 'task_complete',
  });
  await _sleep(30);

  assert.strictEqual(patches.length, 0, 'shorter text must not trigger patch (regression guard)');
}

// === case 5: cancelPatch 后即便有更长 final 也不 patch ===
async function testCancelPatchStopsForwardPatching() {
  const tap = _makeFakeTap();
  const patches = [];
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-patch-5',
    label: 'blastoise',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
    onTurnPatched: (ev) => patches.push(ev),
    patchWindowMs: 5000,
  });

  const p = watcher.wait();
  watcher.manualExtract('partial');
  await p;

  watcher.cancelPatch();   // 用户主动取消 patch（如导航离开）

  await _sleep(20);
  tap.emit('turn-complete', {
    hubSessionId: 'sid-patch-5',
    text: 'partial extended much longer with detail',
    signalSource: 'task_complete',
  });
  await _sleep(30);

  assert.strictEqual(patches.length, 0, 'cancelPatch must stop forward patching');
}

// === runner ===

const tests = [
  testManualExtractedThenCodexFinalPatch,
  testCompletedThenLongerFinalPatch,
  testSameTextDoesNotTriggerPatch,
  testShorterTextDoesNotTriggerPatch,
  testCancelPatchStopsForwardPatching,
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
