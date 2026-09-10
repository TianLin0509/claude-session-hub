'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { nativeUnknownOutcome } = require('../core/native-groupchat-outcome');
const { createClaudeNativeWatcher } = require('../core/claude-native-watcher');
const { EventEmitter } = require('node:events');
const failure = { status: 'errored', text: '已收到的部分回答', reason: 'connection lost' };

test('unknown Claude outcome is bound to the dispatched record, not the current session', () => {
  const claude = { records: new Map([['A', { submissionId: 'A', userMessageId: 'uuid-A', status: 'unknown' }],
    ['B', { submissionId: 'B', userMessageId: 'uuid-B', status: 'queued' }]]) };
  const result = nativeUnknownOutcome(failure, { claude, submissionId: 'A' });
  assert.equal(result.reason, 'submission_unknown');
  assert.equal(result.userMessageId, 'uuid-A');
  assert.equal(result.text, failure.text);
  assert.equal(result.finality, 'unknown');
  assert.equal(result.failure.autoRetry, false);
  assert.equal(result.failure.retryable, false);
  assert.equal(result.failure.action, 'reconcile_native_history');
  assert.equal(nativeUnknownOutcome(failure, { claude, submissionId: 'B' }), failure);
  assert.equal(nativeUnknownOutcome(failure, { claude, submissionId: 'C' }), failure);
  for (const status of ['completed', 'failed', 'interrupted', 'rejected']) {
    claude.records.get('A').status = status;
    assert.equal(nativeUnknownOutcome(failure, { claude, submissionId: 'A' }), failure);
  }
});

test('Codex distinguishes pre-ACK uncertainty and exact accepted-turn disconnect', () => {
  const codex = { runtime: { state: 'unknown', submission: { id: 'A', status: 'unknown' } } };
  assert.equal(nativeUnknownOutcome(failure, { codex, submissionId: 'A' }).failure.code, 'submission_unknown');
  assert.equal(nativeUnknownOutcome(failure, { codex, submissionId: 'B' }), failure);
  codex.runtime = { state: 'unknown', turnId: 'turn-A', submission: { id: 'A', status: 'accepted', turnId: 'turn-A' } };
  assert.equal(nativeUnknownOutcome(failure, { codex, submissionId: 'A', providerTurnId: 'turn-A' }).finality, 'unknown');
  assert.equal(nativeUnknownOutcome(failure, { codex, submissionId: 'A', providerTurnId: 'turn-B' }), failure);
  assert.equal(nativeUnknownOutcome(failure, { codex, submissionId: 'A' }), failure);
  codex.runtime.state = 'completed';
  assert.equal(nativeUnknownOutcome(failure, { codex, submissionId: 'A', providerTurnId: 'turn-A' }), failure);
});

test('native projection never changes completed or interrupted outcomes and never interprets error text', () => {
  const codex = { runtime: { submission: { id: 'A', status: 'unknown' } } };
  for (const status of ['completed', 'interrupted', 'superseded']) {
    const result = { ...failure, status };
    assert.equal(nativeUnknownOutcome(result, { codex, submissionId: 'A' }), result);
  }
  assert.equal(nativeUnknownOutcome(failure), failure);
  assert.equal(nativeUnknownOutcome(failure, { submissionId: 'A' }), failure);
});

test('accepted Claude disconnect preserves partial output and releases all watcher listeners', async () => {
  const claude = new EventEmitter();
  claude.runtime = { reason: null, requests: [] };
  const record = { submissionId: 'A', userMessageId: 'uuid-A', status: 'running', started: true,
    accepted: true, finalText: failure.text };
  claude.records = new Map([['A', record]]); claude.active = record;
  const watcher = createClaudeNativeWatcher(claude, { sid: 's', submissionId: 'A', attemptId: 'A' });
  const pending = watcher.wait();
  record.status = 'unknown'; claude.emit('state');
  const result = nativeUnknownOutcome(await pending, { claude, submissionId: 'A' });
  assert.equal(result.failure.code, 'submission_unknown');
  assert.equal(result.text, failure.text);
  for (const name of ['state', 'lifecycle', 'item']) assert.equal(claude.listenerCount(name), 0);
});
