'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_COMPLETED,
  RUNTIME_IDLE,
  RUNTIME_FAILED,
  RUNTIME_UNKNOWN,
  CONFIDENCE_AUTHORITATIVE,
  CONFIDENCE_STRONG,
  CONFIDENCE_SEMANTIC,
  CONFIDENCE_FALLBACK,
  applySessionRuntimeObservation,
  getSessionRuntimeTruth,
  sessionRuntimeIsActive,
} = require('../core/session-runtime-truth.js');

test('official lifecycle advances starting to running to completed and mirrors legacy status', () => {
  const session = { status: 'idle' };
  assert.equal(applySessionRuntimeObservation(session, {
    state: RUNTIME_STARTING,
    source: 'claude-user-prompt-submit',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 1000,
    startedAt: 1000,
  }).applied, true);
  assert.equal(session.status, 'running');
  assert.equal(sessionRuntimeIsActive(session, { now: 2000 }), true);

  assert.equal(applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'pty-claude-active-status',
    confidence: CONFIDENCE_STRONG,
    observedAt: 2000,
  }).applied, true);
  assert.equal(getSessionRuntimeTruth(session, { now: 2500 }).state, RUNTIME_RUNNING);

  assert.equal(applySessionRuntimeObservation(session, {
    state: RUNTIME_COMPLETED,
    source: 'claude-stop',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 4000,
    completedAt: 4000,
  }).applied, true);
  assert.equal(session.status, 'idle');
  assert.equal(getSessionRuntimeTruth(session, { now: 5000 }).state, RUNTIME_COMPLETED);
});

test('late user-message cannot regress the same confirmed turn from running to starting', () => {
  const session = { status: 'idle' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'codex-task-started',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 5000,
    startedAt: 4000,
    turnId: 'turn-1',
  });
  const result = applySessionRuntimeObservation(session, {
    state: RUNTIME_STARTING,
    source: 'codex-user-message',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 5500,
    startedAt: 4000,
    turnId: 'turn-1',
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'active-phase-regression');
  assert.equal(session.runtimeTruth.state, RUNTIME_RUNNING);
});

test('newer current-screen PTY result can close stale semantic running', () => {
  const session = { status: 'idle' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'codex-task-started',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 1000,
  });
  const result = applySessionRuntimeObservation(session, {
    state: RUNTIME_COMPLETED,
    source: 'pty-codex-input-ready',
    confidence: CONFIDENCE_STRONG,
    observedAt: 2000,
    evidence: '› prompt | Context 97% left',
  });
  assert.equal(result.applied, true);
  assert.equal(session.status, 'idle');
  assert.equal(session.runtimeTruth.state, RUNTIME_COMPLETED);
});

test('older completion cannot override a newer turn', () => {
  const session = { status: 'idle' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_STARTING,
    source: 'new-prompt',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 5000,
  });
  const stale = applySessionRuntimeObservation(session, {
    state: RUNTIME_COMPLETED,
    source: 'old-complete',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 4000,
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale-observation');
  assert.equal(session.runtimeTruth.state, RUNTIME_STARTING);
});

test('delayed authoritative completion can enrich the same PTY-completed state', () => {
  const session = { status: 'running' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_COMPLETED,
    source: 'pty-codex-input-ready',
    confidence: CONFIDENCE_STRONG,
    observedAt: 5000,
    completedAt: 5000,
  });
  const enriched = applySessionRuntimeObservation(session, {
    state: RUNTIME_COMPLETED,
    source: 'codex-turn-complete',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 4900,
    completedAt: 4900,
  });
  assert.equal(enriched.applied, true);
  assert.equal(session.runtimeTruth.source, 'codex-turn-complete');
  assert.equal(session.runtimeTruth.observedAt, 5000);
});

test('same-state native and PTY signals are retained as cross-validation', () => {
  const session = { status: 'idle' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'codex-task-started',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 5000,
  });
  const corroborated = applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'pty-codex-interrupt-footer',
    confidence: CONFIDENCE_STRONG,
    observedAt: 5000,
    evidence: 'Working · esc to interrupt',
  });
  assert.equal(corroborated.applied, true);
  assert.equal(corroborated.corroborated, true);
  assert.equal(session.runtimeTruth.source, 'codex-task-started');
  assert.equal(session.runtimeTruth.corroborations.length, 1);
  assert.equal(session.runtimeTruth.corroborations[0].source, 'pty-codex-interrupt-footer');
});

test('late low-confidence heartbeat cannot resurrect a completed turn', () => {
  const session = { status: 'running' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_COMPLETED,
    source: 'groupchat-watcher-complete',
    confidence: CONFIDENCE_STRONG,
    observedAt: 5000,
    completedAt: 5000,
    turnId: '7',
  });
  const staleHeartbeat = applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'groupchat-watcher-heartbeat',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 5100,
    startedAt: 5100,
    turnId: '7',
  });
  assert.equal(staleHeartbeat.applied, false);
  assert.equal(staleHeartbeat.reason, 'terminal-state-resurrection');

  const nextTurn = applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'groupchat-watcher-heartbeat',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 5200,
    startedAt: 5200,
    turnId: '8',
  });
  assert.equal(nextTurn.applied, true);
  assert.equal(session.runtimeTruth.turnId, '8');
});

test('waiting is a first-class state and hard attention state wins', () => {
  const session = { status: 'running' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'claude-prompt',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 1000,
  });
  session.attentionState = 'needs-input';
  session.waitingReason = 'permission-request';
  session.waitingText = 'Allow PowerShell?';
  const truth = getSessionRuntimeTruth(session, { now: 1500 });
  assert.equal(truth.state, RUNTIME_WAITING);
  assert.equal(truth.evidence, 'Allow PowerShell?');
});

test('an official waiting observation keeps its authoritative source', () => {
  const session = { status: 'running', attentionState: 'needs-input', waitingText: 'Allow PowerShell?' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_WAITING,
    source: 'claude-permission-request',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 1000,
    evidence: 'Allow PowerShell?',
  });
  // Runtime mirroring sets status idle, while attention preserves waiting.
  const truth = getSessionRuntimeTruth(session, { now: 1500 });
  assert.equal(truth.state, RUNTIME_WAITING);
  assert.equal(truth.source, 'claude-permission-request');
  assert.equal(truth.confidence, CONFIDENCE_AUTHORITATIVE);
});

test('reply-ready attention does not hide a newer Claude background runtime', () => {
  const session = {
    status: 'running',
    attentionState: 'reply-ready',
    replyReady: true,
    unreadCount: 1,
    lastCompletedAt: 2000,
  };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_RUNNING,
    source: 'claude-background-tasks',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 2000,
    startedAt: 1000,
    evidence: 'tail logs',
  });

  const truth = getSessionRuntimeTruth(session, { now: 2500 });
  assert.equal(truth.state, RUNTIME_RUNNING);
  assert.equal(truth.source, 'claude-background-tasks');
  assert.equal(session.attentionState, 'reply-ready');
  assert.equal(session.unreadCount, 1);
});

test('starting and fallback-only running expire to unknown, not a false idle', () => {
  const starting = { status: 'idle' };
  applySessionRuntimeObservation(starting, {
    state: RUNTIME_STARTING,
    source: 'prompt-submit',
    confidence: CONFIDENCE_SEMANTIC,
    observedAt: 1000,
  });
  assert.equal(getSessionRuntimeTruth(starting, { now: 17_000 }).state, RUNTIME_UNKNOWN);

  const burst = { status: 'idle' };
  applySessionRuntimeObservation(burst, {
    state: RUNTIME_RUNNING,
    source: 'pty-byte-burst',
    confidence: CONFIDENCE_FALLBACK,
    observedAt: 1000,
  });
  assert.equal(getSessionRuntimeTruth(burst, { now: 5000 }).state, RUNTIME_UNKNOWN);
});

test('failure and dormant states are preserved as hard outcomes', () => {
  const failed = { status: 'idle' };
  applySessionRuntimeObservation(failed, {
    state: RUNTIME_FAILED,
    source: 'claude-stop-failure',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 1000,
    evidence: 'rate_limit',
  });
  assert.equal(failed.status, 'error');
  assert.equal(getSessionRuntimeTruth(failed, { now: 2000 }).state, RUNTIME_FAILED);

  const dormant = { status: 'dormant', runtimeTruth: failed.runtimeTruth };
  assert.equal(getSessionRuntimeTruth(dormant, { now: 2000 }).state, 'dormant');
});

test('legacy sessions remain compatible before receiving a RuntimeTruth observation', () => {
  const session = {
    status: 'running',
    _runSource: 'pty-semantic',
    runStartedAt: 1000,
    _ptyRuntimeEvidence: 'Working (1s · esc to interrupt)',
  };
  const truth = getSessionRuntimeTruth(session, { now: 2000 });
  assert.equal(truth.state, RUNTIME_RUNNING);
  assert.equal(truth.confidence, CONFIDENCE_STRONG);
  assert.match(truth.evidence, /esc to interrupt/);
});

test('explicit idle observation clears compatibility running', () => {
  const session = { status: 'running' };
  applySessionRuntimeObservation(session, {
    state: RUNTIME_IDLE,
    source: 'process-idle',
    confidence: CONFIDENCE_AUTHORITATIVE,
    observedAt: 1000,
  });
  assert.equal(session.status, 'idle');
  assert.equal(getSessionRuntimeTruth(session, { now: 2000 }).state, RUNTIME_IDLE);
});
