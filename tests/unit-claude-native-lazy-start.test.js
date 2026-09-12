'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { persistNativeRuntime } = require('../core/native-agent-runtime');

const UUID = '11111111-2222-3333-4444-555555555555';
const base = { id: 's1', kind: 'claude', cwd: process.cwd(), launchArgs: ['--model', 'claude-opus-5[1m]'] };

test('a lazy dev seat holds its identity without connecting', () => {
  const native = new ClaudeNativeSession({ ...base, sessionId: UUID, lazyStart: true });
  assert.equal(native.runtime.connection, 'unstarted');
  assert.equal(native.runtime.state, 'idle', 'an unstarted seat is not "unknown" — nothing happened to reconcile');
  assert.equal(native.runtime.providerSessionId, UUID);
  assert.match(native.runtime.reason, /尚未开始/);
  // Restarting the Hub must bring it back unstarted, not as a disconnected
  // session asking to be reconciled.
  const persisted = persistNativeRuntime({ runtimeBackend: 'claude-stream-json', nativeRuntime: native.runtime });
  assert.equal(persisted.connection, 'unstarted');
  const restored = new ClaudeNativeSession({ ...base, sessionId: UUID, restoredRuntime: persisted });
  assert.equal(restored.runtime.connection, 'unstarted');
  assert.equal(restored.unreconciled, false);
});

test('a seat that already has work never pretends it has not started', () => {
  const content = [{ type: 'text', text: 'hi' }];
  const { createHash } = require('crypto');
  const promptFingerprint = createHash('sha256')
    .update(JSON.stringify(content.map(b => ({ text: b.text, type: b.type })))).digest('hex');
  const native = new ClaudeNativeSession({ ...base, sessionId: UUID, lazyStart: true,
    restoredRecords: [{ submissionId: 'a', userMessageId: 'u', providerSessionId: UUID,
      content, promptFingerprint, status: 'completed' }] });
  assert.notEqual(native.runtime.connection, 'unstarted');
  // A resumed conversation is not a fresh seat either.
  const resumed = new ClaudeNativeSession({ ...base, lazyStart: true, resumeSessionId: UUID });
  assert.notEqual(resumed.runtime.connection, 'unstarted');
});

test('starting a lazy seat leaves the unstarted state before it connects', async () => {
  const native = new ClaudeNativeSession({ ...base, sessionId: UUID, lazyStart: true });
  const states = [];
  native.on('state', snapshot => states.push(snapshot.connection));
  // Fail fast inside _start; the point is the transition it publishes first.
  native.options.clientFactory = () => { throw new Error('probe: no engine in this test'); };
  await assert.rejects(() => native.start(), /probe: no engine/);
  assert.equal(states[0], 'connecting');
});

test('restarting an unstarted seat leaves it dispatchable instead of demanding reconciliation', async () => {
  const native = new ClaudeNativeSession({ ...base, sessionId: UUID, lazyStart: true });
  const runtime = await native.reconnect({ stopActive: true });
  assert.equal(runtime.connection, 'unstarted');
  assert.equal(native.unreconciled, false, 'a seat that never ran has nothing to reconcile');
});
