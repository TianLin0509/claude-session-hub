'use strict';
// Stage 2 P0-4 单测：锁住 turn-completion-watcher 状态机契约。
//
// 覆盖：
//  1. wait() → transcriptTap emit turn-complete → settle as 'completed' + signalSource 透传
//  2. wait() → manualExtract(text) → settle as 'manual_extracted' + source='manual'
//  3. wait() → skip() → settle as 'absent', text=''
//  4. wait() → soft alert t1/t2 触发 onSoftAlert 但**不 settle**（关键：永不自动退出）
//  5. wait() → transcriptTap emit turn-error → settle as 'errored' + reason 透传
//  6. wait() → 重复 settle 调用幂等（防重入）
//  7. markProcessExit(code=0) → 'completed' (P1 预埋路径)
//  8. markProcessExit(code≠0) → 'errored'

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createTurnCompletionWatcher,
  SOFT_ALERT_T1_MS,
  SOFT_ALERT_T2_MS,
} = require('../core/turn-completion-watcher.js');

function mkTap() { return new EventEmitter(); }

async function testCompleted() {
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-A', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000, // 不会在测试期内触发
  });
  const p = w.wait();
  setImmediate(() => tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'hello', signalSource: 'result_event', completedAt: 1717000000000 }));
  const r = await p;
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.text, 'hello');
  assert.strictEqual(r.signalSource, 'result_event');
  assert.strictEqual(r.sid, 'sid-A');
  assert.strictEqual(r.label, 'gemini-1');
  assert.strictEqual(w.isSettled(), true);
  console.log('  ✓ testCompleted');
}

async function testCompletedIgnoresOtherSid() {
  // 不同 sid 的 turn-complete 事件不应误触本 watcher
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-A', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => {
    tap.emit('turn-complete', { hubSessionId: 'sid-OTHER', text: 'noise' });
    setImmediate(() => tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'real', signalSource: 'tokens_total' }));
  });
  const r = await p;
  assert.strictEqual(r.text, 'real');
  console.log('  ✓ testCompletedIgnoresOtherSid');
}

async function testManualExtract() {
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-B', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => w.manualExtract('extracted body'));
  const r = await p;
  assert.strictEqual(r.status, 'manual_extracted');
  assert.strictEqual(r.text, 'extracted body');
  assert.strictEqual(r.signalSource, 'manual');
  console.log('  ✓ testManualExtract');
}

async function testSkip() {
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-C', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => w.skip());
  const r = await p;
  assert.strictEqual(r.status, 'absent');
  assert.strictEqual(r.text, '');
  console.log('  ✓ testSkip');
}

async function testSoftAlertDoesNotSettle() {
  // 关键不变式：T1/T2 触发 onSoftAlert 但 watcher 仍处于 unsettled。
  // 只有外部触发点（manualExtract/skip/turn-complete/turn-error）才能 settle。
  const tap = mkTap();
  const alerts = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-D', label: 'gemini-1',
    softAlertT1Ms: 30,    // 30ms 后触发 T1
    softAlertT2Ms: 60,    // 60ms 后触发 T2
    onSoftAlert: (level) => alerts.push(level),
  });
  const p = w.wait();
  // 等 T2 触发完成
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual(alerts, ['t1', 't2'], 'both T1 and T2 alerts fire');
  assert.strictEqual(w.isSettled(), false, 'watcher must NOT settle on soft alerts (永不自动退出)');
  // T2 之后用户手动 skip 才 settle
  w.skip();
  const r = await p;
  assert.strictEqual(r.status, 'absent');
  assert.strictEqual(w.isSettled(), true);
  console.log('  ✓ testSoftAlertDoesNotSettle');
}

async function testErrored() {
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-E', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => tap.emit('turn-error', { hubSessionId: 'sid-E', reason: 'pty broke' }));
  const r = await p;
  assert.strictEqual(r.status, 'errored');
  assert.strictEqual(r.reason, 'pty broke');
  console.log('  ✓ testErrored');
}

async function testIdempotentSettle() {
  // 多次调用 manualExtract / skip / 重复 emit turn-complete 应只 settle 一次
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-F', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => {
    w.manualExtract('first');
    w.manualExtract('second'); // 应被忽略
    w.skip();                   // 应被忽略
    tap.emit('turn-complete', { hubSessionId: 'sid-F', text: 'late' }); // 应被忽略（监听已 cleanup）
  });
  const r = await p;
  assert.strictEqual(r.text, 'first', 'first settle wins');
  assert.strictEqual(r.status, 'manual_extracted');
  console.log('  ✓ testIdempotentSettle');
}

async function testProcessExitClean() {
  // P1 预埋：markProcessExit({code:0}) 视为 completed（无文本兜底）
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-G', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => w.markProcessExit({ code: 0 }));
  const r = await p;
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.signalSource, 'process_exit_clean');
  console.log('  ✓ testProcessExitClean');
}

async function testProcessExitErrored() {
  // markProcessExit({code:1}) 或 signal=SIGKILL 视为 errored
  const tap = mkTap();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-H', label: 'gemini-1',
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const p = w.wait();
  setImmediate(() => w.markProcessExit({ code: 1 }));
  const r = await p;
  assert.strictEqual(r.status, 'errored');
  assert.ok(/code=1/.test(r.reason), `reason should mention exit code, got: ${r.reason}`);
  console.log('  ✓ testProcessExitErrored');
}

function testConstantsExported() {
  // SOFT_ALERT_T1_MS = 90000 / T2 = 180000（与 plan / spec 锁定一致）
  assert.strictEqual(SOFT_ALERT_T1_MS, 90000);
  assert.strictEqual(SOFT_ALERT_T2_MS, 180000);
  console.log('  ✓ testConstantsExported');
}

function testThrowsWithoutTap() {
  assert.throws(
    () => createTurnCompletionWatcher({ hubSessionId: 'sid' }),
    /transcriptTap required/
  );
  assert.throws(
    () => createTurnCompletionWatcher({ transcriptTap: mkTap() }),
    /hubSessionId required/
  );
  console.log('  ✓ testThrowsWithoutTap');
}

(async () => {
  console.log('Running turn-completion-watcher tests...');
  testConstantsExported();
  testThrowsWithoutTap();
  await testCompleted();
  await testCompletedIgnoresOtherSid();
  await testManualExtract();
  await testSkip();
  await testSoftAlertDoesNotSettle();
  await testErrored();
  await testIdempotentSettle();
  await testProcessExitClean();
  await testProcessExitErrored();
  console.log('All passed.');
})().catch(e => {
  console.error('FAIL:', e);
  process.exit(1);
});
