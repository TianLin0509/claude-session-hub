'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getSessionRuntimeTruth, applySessionRuntimeObservation } = require('../core/session-runtime-truth');
const { sessionNeedsUserInput } = require('../core/session-attention-state');
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state');
const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');
const { buildComposerStatusModel } = require('../core/session-status-summary');
const { buildHomeSnapshot } = require('../renderer/home-workbench');
const { persistNativeRuntime } = require('../core/native-agent-runtime');

test('Claude consumers keep the same native identity and ignore contradictory screen, heartbeat and attention caches', () => {
  for (const state of ['idle', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'unknown']) {
    const s = { id: 'hub', kind: 'claude', status: 'running', runtimeBackend: 'claude-stream-json',
      gcWorking: true, _gcWorkingLastTs: 9000, attentionState: 'needs-input', needsUserInput: true,
      nativeRuntime: { state, connection: 'connected', providerSessionId: 'session', userMessageId: 'user', turnId: 'user',
        epoch: 2, revision: 9, startedAt: 7000, completedAt: state === 'completed' ? 8000 : 0, requests: [] } };
    assert.equal(getSessionRuntimeTruth(s).state, state);
    assert.equal(isGroupChatMemberRunning(s, 9000), ['starting', 'running', 'waiting'].includes(state), state);
    assert.equal(sessionNeedsUserInput(s), state === 'waiting', state);
    const runtime = deriveSessionRuntimeStatus(s, { now: 9000, isRunning: true });
    assert.equal(runtime.state, state);
    for (const key of ['providerSessionId', 'userMessageId', 'turnId', 'epoch', 'revision']) assert.equal(runtime[key], s.nativeRuntime[key], key);
    const composer = buildComposerStatusModel(s, { runtime, liveQuestion: { waiting: true, text: '旧输入框猜测' } });
    if (['completed', 'interrupted', 'idle'].includes(state)) assert.equal(composer.state, 'ready', state);
    assert.equal(buildHomeSnapshot({ sessions: new Map([[s.id, s]]), now: 9000 }).items[0].status, state);
    assert.equal(applySessionRuntimeObservation(s, { state: 'running', source: 'stop-hook' }).applied, false);
  }
});

test('both providers preserve identities across persistence without restoring live approval requests', () => {
  for (const [kind, backend] of [['codex', 'codex-app-server'], ['claude', 'claude-stream-json']]) {
    const s = { kind, runtimeBackend: backend, nativeRuntime: { state: 'waiting', connection: 'connected',
      epoch: 4, revision: 8, turnId: 'turn', providerSessionId: 'session', ownerPid: 123,
      requests: [{ id: 'old-request' }], waitingFlags: ['waitingOnApproval'] } };
    const saved = persistNativeRuntime(s);
    assert.ok(saved, kind); assert.equal(saved.connection, 'disconnected'); assert.equal(saved.turnId, 'turn');
    assert.deepEqual(saved.requests, []); assert.equal(saved.ownerPid, 123); assert.equal(s.nativeRuntime.requests.length, 1);
  }
});
