'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSessionRuntimeStatus,
  formatCompletionAge,
  formatRuntimeDuration,
} = require('../renderer/session-runtime-status.js');

test('runtime duration uses a stable clock format', () => {
  assert.equal(formatRuntimeDuration(0), '00:00');
  assert.equal(formatRuntimeDuration(12 * 60_000 + 1_000), '12:01');
  assert.equal(formatRuntimeDuration((2 * 60 * 60 + 3 * 60 + 4) * 1000), '2:03:04');
});

test('Codex running state exposes a visible elapsed clock and PTY evidence', () => {
  const now = 2_000_000;
  const result = deriveSessionRuntimeStatus({
    kind: 'codex',
    status: 'running',
    runStartedAt: now - (12 * 60_000 + 1_000),
    _ptyRuntimeEvidence: '• Working (12m 01s • esc to interrupt)',
  }, { now, isRunning: true });
  assert.deepEqual({
    state: result.state,
    label: result.label,
    meta: result.meta,
    visibleText: result.visibleText,
    ariaLabel: result.ariaLabel,
  }, {
    state: 'running',
    label: '工作中',
    meta: '12:01',
    visibleText: '工作中 · 12:01',
    ariaLabel: 'Codex 工作中',
  });
  assert.match(result.title, /esc to interrupt/);
});

test('waiting for input wins over a stale running flag', () => {
  const result = deriveSessionRuntimeStatus({
    kind: 'codex',
    status: 'running',
    attentionState: 'needs-input',
    waitingText: 'Allow command execution?',
  }, { now: 2_000_000, isRunning: true });
  assert.equal(result.state, 'waiting');
  assert.equal(result.visibleText, '等待输入 · 需要操作');
  assert.match(result.title, /Allow command execution/);
});

test('completed and untouched idle sessions are distinguishable without color alone', () => {
  const now = 2_000_000;
  const completed = deriveSessionRuntimeStatus({
    kind: 'codex',
    status: 'idle',
    attentionState: 'reply-ready',
    lastCompletedAt: now - 30_000,
    lastRunDurationMs: 72_000,
  }, { now });
  assert.equal(completed.state, 'complete');
  assert.equal(completed.visibleText, '已完成 · 刚刚');
  assert.match(completed.title, /本轮用时 01:12/);

  const idle = deriveSessionRuntimeStatus({ kind: 'codex', status: 'idle' }, { now });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.visibleText, '已就绪');

  const abortedAfterOlderCompletion = deriveSessionRuntimeStatus({
    kind: 'codex',
    status: 'idle',
    lastCompletedAt: now - 60_000,
    _attentionClock: { lastPromptAt: now - 10_000 },
  }, { now });
  assert.equal(abortedAfterOlderCompletion.state, 'idle');
  assert.equal(abortedAfterOlderCompletion.visibleText, '已就绪');
});

test('completion age remains concise', () => {
  const now = 10 * 24 * 60 * 60_000;
  assert.equal(formatCompletionAge(now - 59_000, now), '刚刚');
  assert.equal(formatCompletionAge(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatCompletionAge(now - 3 * 60 * 60_000, now), '3 小时前');
  assert.equal(formatCompletionAge(now - 2 * 24 * 60 * 60_000, now), '2 天前');
});
