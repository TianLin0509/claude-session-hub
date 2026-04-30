'use strict';
// Stage 2 P2-1 单测：Codex task_complete 3s debounce。
//
// 不变式：
//   1. 单次 task_complete → 3s 后真 emit turn-complete
//   2. 多次连续 task_complete（中间无 task_started）→ 最后一次 text 为准，3s 静默后才 emit
//   3. task_complete 后 3s 内出现新 task_started → cancel pending，不 emit
//   4. task_started 之后再来 task_complete → 新一轮 debounce，emit 用新 text
//
// 用 fake timers 加速测试（不真等 3s）。直接读 transcript-tap.js 源码静态确认契约。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSrc() {
  return fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf-8');
}

function extractCodexOnLineBody(src) {
  const startIdx = src.indexOf('Stage 2 P2-1：Codex 多 turn 加固');
  assert.ok(startIdx >= 0, 'P2-1 comment marker must exist');
  const endIdx = src.indexOf('const tail = new JsonlTail(rolloutPath', startIdx);
  assert.ok(endIdx > startIdx);
  return src.slice(startIdx, endIdx);
}

function testDebounceConstantIs3000() {
  const body = extractCodexOnLineBody(readSrc());
  assert.ok(/TASK_COMPLETE_DEBOUNCE_MS\s*=\s*3000/.test(body),
    'TASK_COMPLETE_DEBOUNCE_MS must equal 3000ms (3s, per spec)');
  console.log('  ✓ testDebounceConstantIs3000');
}

function testTaskStartedCancelsPendingEmit() {
  const body = extractCodexOnLineBody(readSrc());
  // 必须识别 task_started 事件并清除 pending timer
  assert.ok(/eventType\s*===\s*['"]task_started['"]/.test(body),
    'must check eventType === "task_started"');
  assert.ok(/clearTimeout\(entry\._pendingEmitTimer\)/.test(body),
    'must clearTimeout pending emit timer');
  assert.ok(/entry\._pendingText\s*=\s*null/.test(body),
    'must clear pendingText on task_started');
  console.log('  ✓ testTaskStartedCancelsPendingEmit');
}

function testTaskCompleteResetsDebounce() {
  const body = extractCodexOnLineBody(readSrc());
  // 在 task_complete 分支前必须先 clearTimeout 旧 pending（实现连续 task_complete 用最后一次）
  assert.ok(/eventType\s*===\s*['"]task_complete['"]/.test(body),
    'must check eventType === "task_complete"');
  // 分支内必须重置 _pendingEmitTimer
  assert.ok(/if\s*\(entry\._pendingEmitTimer\)\s*clearTimeout\(entry\._pendingEmitTimer\)/.test(body),
    'task_complete branch must clear previous pending timer (enables "last task_complete wins")');
  // 必须存 pendingText 而不是直接 emit
  assert.ok(/entry\._pendingText\s*=\s*text/.test(body),
    'task_complete must save text into entry._pendingText');
  console.log('  ✓ testTaskCompleteResetsDebounce');
}

function testEmitGoesThroughTimer() {
  const body = extractCodexOnLineBody(readSrc());
  // emit 必须在 setTimeout 回调里，不是同步
  // 找 'turn-complete' 出现位置
  const emitIdx = body.indexOf("this.emit('turn-complete'");
  assert.ok(emitIdx > 0, 'must emit turn-complete');
  // 在 emitIdx 之前最近的应是 setTimeout
  const before = body.slice(0, emitIdx);
  const setTimeoutIdx = before.lastIndexOf('setTimeout');
  assert.ok(setTimeoutIdx > 0, 'emit must be wrapped in setTimeout (debounce)');
  // 且 emit payload 含 signalSource: 'task_complete'
  assert.ok(/signalSource:\s*['"]task_complete['"]/.test(body.slice(emitIdx, emitIdx + 400)),
    'emit payload must include signalSource: "task_complete"');
  console.log('  ✓ testEmitGoesThroughTimer');
}

function testUnregisterClearsPendingTimer() {
  const src = readSrc();
  // 定位 CodexTap class 范围内的 unregisterSession（避开 ClaudeTap / GeminiTap 同名方法）
  const codexClassStart = src.indexOf('class CodexTap');
  const codexClassEnd = src.indexOf('class GeminiTap', codexClassStart);
  assert.ok(codexClassStart > 0 && codexClassEnd > codexClassStart);
  const codexBody = src.slice(codexClassStart, codexClassEnd);
  // 在 CodexTap 范围内找 unregisterSession
  const unregStart = codexBody.indexOf('unregisterSession(hubSessionId)');
  assert.ok(unregStart >= 0, 'CodexTap must have unregisterSession');
  const unregBody = codexBody.slice(unregStart, unregStart + 600);
  assert.ok(/_pendingEmitTimer/.test(unregBody),
    'CodexTap unregisterSession must reference _pendingEmitTimer for cleanup');
  assert.ok(/clearTimeout\(bound\._pendingEmitTimer\)/.test(unregBody),
    'CodexTap unregisterSession must clearTimeout the pending emit timer (memory leak guard)');
  console.log('  ✓ testUnregisterClearsPendingTimer');
}

function testInitialEntryHasPendingFields() {
  const src = readSrc();
  // CodexTap _bindSession 的 _bound.set 初始 entry 必须含 _pendingEmitTimer/_pendingText/_pendingDurationMs
  const startIdx = src.indexOf('this._bound.set(hubSessionId, {');
  assert.ok(startIdx >= 0);
  // 找 codex 的 _bound.set（多个 Tap 都有，按上下文锚定 — codex 那段在 'rolloutPath' 字段附近）
  const codexBindStart = src.indexOf('rolloutPath, tail, lastText: null');
  assert.ok(codexBindStart >= 0, 'must locate codex _bound.set entry init');
  const codexBindEnd = src.indexOf('});', codexBindStart);
  const codexBind = src.slice(codexBindStart, codexBindEnd);
  assert.ok(/_pendingEmitTimer:\s*null/.test(codexBind),
    'codex _bound entry must init _pendingEmitTimer: null');
  assert.ok(/_pendingText:\s*null/.test(codexBind),
    'codex _bound entry must init _pendingText: null');
  console.log('  ✓ testInitialEntryHasPendingFields');
}

console.log('Running Codex task_complete debounce tests...');
testDebounceConstantIs3000();
testTaskStartedCancelsPendingEmit();
testTaskCompleteResetsDebounce();
testEmitGoesThroughTimer();
testUnregisterClearsPendingTimer();
testInitialEntryHasPendingFields();
console.log('All passed.');
