'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function attempt(overrides = {}) {
  const now = Date.now();
  return {
    attemptId: 'attempt-current',
    runId: 'run-current',
    sid: 'sid-codex',
    kind: 'codex',
    dispatchAt: now - 100,
    startedAt: now - 50,
    providerTurnId: 'turn-current',
    ...overrides,
  };
}

async function strictTurnOwnership() {
  const tap = new EventEmitter();
  const rejected = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-codex',
    label: 'Codex',
    kind: 'codex',
    attempt: attempt(),
    onEventRejected: item => rejected.push(item),
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const pending = w.wait();
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-old', completedAt: Date.now(),
    text: '旧轮迟到答案', signalSource: 'task_complete',
  });
  await delay(10);
  assert.strictEqual(w.isSettled(), false);
  assert.strictEqual(rejected[0].reason, 'provider_turn_mismatch');
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    text: '当前轮最终答案', signalSource: 'task_complete',
  });
  const result = await pending;
  assert.strictEqual(result.text, '当前轮最终答案');
  assert.strictEqual(result.attemptId, 'attempt-current');
  assert.strictEqual(result.providerTurnId, 'turn-current');
}

async function finalAnswerGate() {
  const tap = new EventEmitter();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-codex',
    label: 'Codex',
    kind: 'codex',
    attempt: attempt(),
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const pending = w.wait();
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    text: '我先检查一下', signalSource: 'agent_message',
  });
  await delay(10);
  assert.strictEqual(w.isSettled(), false, 'commentary must never settle an attempt');
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    text: '检查完成后的最终答案', signalSource: 'task_complete',
  });
  assert.strictEqual((await pending).text, '检查完成后的最终答案');
}

async function quotaAndTransportFailures() {
  const tap = new EventEmitter();
  const quotaWatcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-codex',
    label: 'Codex',
    kind: 'codex',
    attempt: attempt(),
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const quotaPending = quotaWatcher.wait();
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    text: "You've hit your session limit · resets 6am", signalSource: 'task_complete',
  });
  const quota = await quotaPending;
  assert.strictEqual(quota.status, 'errored');
  assert.strictEqual(quota.failure.code, 'quota_exceeded');
  assert.strictEqual(quota.failure.autoRetry, false);

  const exitWatcher = createTurnCompletionWatcher({
    transcriptTap: new EventEmitter(),
    hubSessionId: 'sid-codex',
    label: 'Codex',
    kind: 'codex',
    attempt: attempt(),
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const exitPending = exitWatcher.wait();
  exitWatcher.markProcessExit({ code: 0 });
  const exited = await exitPending;
  assert.strictEqual(exited.status, 'errored', 'clean PTY exit without final text is not a completed answer');
  assert.strictEqual(exited.failure.code, 'runtime_exited');
}

async function terminalWithoutTextWaitsForPersistedFinal() {
  const tap = new EventEmitter();
  let waiting = 0;
  const w = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-codex',
    label: 'Codex',
    kind: 'codex',
    attempt: attempt(),
    onAwaitingFinalText: () => { waiting += 1; },
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const pending = w.wait();
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    text: '', signalSource: 'task_complete',
  });
  await delay(10);
  assert.strictEqual(waiting, 1);
  assert.strictEqual(w.isSettled(), false);
  assert.strictEqual(w.completeFromTranscript('刷盘后的最终答案', 'codex_auto_extract_final_answer', {
    turnId: 'turn-current',
  }), true);
  assert.strictEqual((await pending).text, '刷盘后的最终答案');
}

async function retryableTransportFailureCanBePatchedByLateFinal() {
  const tap = new EventEmitter();
  const patches = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-codex',
    label: 'Codex',
    kind: 'codex',
    attempt: attempt(),
    onTurnPatched: patch => patches.push(patch),
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const pending = w.wait();
  tap.emit('turn-error', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    message: 'stream disconnected before completion: ECONNRESET', signalSource: 'task_complete_error',
  });
  const failed = await pending;
  assert.strictEqual(failed.failure.code, 'network_interrupted');
  tap.emit('turn-complete', {
    hubSessionId: 'sid-codex', turnId: 'turn-current', completedAt: Date.now(),
    text: '重连后落盘的最终答案', signalSource: 'task_complete',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].status, 'completed');
  assert.strictEqual(patches[0].text, '重连后落盘的最终答案');
  w.cancelPatch();
}

async function hardTimeoutIsRetryableFailureNotAbsence() {
  const w = createTurnCompletionWatcher({
    transcriptTap: new EventEmitter(),
    hubSessionId: 'sid-codex', label: 'Codex', kind: 'codex', attempt: attempt(),
    softAlertT1Ms: 5000, softAlertT2Ms: 10000,
  });
  const pending = w.wait();
  w.markTimedOut();
  const result = await pending;
  assert.strictEqual(result.status, 'errored');
  assert.strictEqual(result.failure.code, 'response_timeout');
  assert.strictEqual(result.failure.autoRetry, false);
}

(async () => {
  await strictTurnOwnership();
  await finalAnswerGate();
  await quotaAndTransportFailures();
  await terminalWithoutTextWaitsForPersistedFinal();
  await retryableTransportFailureCanBePatchedByLateFinal();
  await hardTimeoutIsRetryableFailureNotAbsence();
  console.log('groupchat attempt watcher: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
