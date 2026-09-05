'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groupchat = require('../core/group-chat-orchestrator.js');

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ledger-'));
}

{
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'meeting');
  const begin = orch.beginTurn('Q1');
  const receipt = orch.recordTurnPrompt(begin.turnNum, 'sid-1', 'SYSTEM\n\nQ1', {
    runId: begin.runId, memberId: 'm7', kind: 'codex', dispatchAt: Date.now(),
  });
  assert.ok(receipt.attemptId);
  orch.setSendStatus(begin.turnNum, 'sid-1', 'submitted', {
    attemptId: receipt.attemptId,
    acknowledgementSource: 'task_started',
    providerTurnId: 'provider-turn-1',
  });
  orch.patchTurnResult(begin.turnNum, 'sid-1', {
    text: 'answer', status: 'completed', memberId: 'm7', speaker: 'Codex',
    attemptId: receipt.attemptId, runId: begin.runId,
    providerTurnId: 'provider-turn-1', signalSource: 'task_complete', finality: 'provider_final',
  });
  orch.completeTurn(begin.turnNum, 'Q1', [{
    sid: 'sid-1', text: 'answer', status: 'completed', attemptId: receipt.attemptId,
    runId: begin.runId, providerTurnId: 'provider-turn-1', deliveredSeq: 1,
  }], { 'sid-1': { memberId: 'm7', displayName: 'Codex', kind: 'codex' } }, {}, { runId: begin.runId });
  const state = orch.getState();
  assert.strictEqual(state.schemaVersion, 4);
  assert.strictEqual(state.memberIdsBySid['sid-1'], 'm7');
  assert.strictEqual(state.attempts[receipt.attemptId].status, 'completed');
  assert.strictEqual(state.turns[0].attemptIdBy['sid-1'], receipt.attemptId);
  assert.strictEqual(state.turns[0].providerTurnIdBy['sid-1'], 'provider-turn-1');
  assert.ok(state.messages.every(message => Number.isInteger(message.seq) && message.seq > 0));
  assert.ok(state.revision > 0);

  groupchat._private.resetCache();
  const reloaded = groupchat.getOrchestrator(root, 'meeting').getState();
  assert.strictEqual(reloaded.attempts[receipt.attemptId].status, 'completed');
  assert.strictEqual(reloaded.lastDeliveredSeq['sid-1'], 1);
}

{
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'restart');
  const begin = orch.beginTurn('unfinished');
  const receipt = orch.recordTurnPrompt(begin.turnNum, 'sid-1', 'unfinished', {
    runId: begin.runId, memberId: 'm1', kind: 'claude',
  });
  orch.updateAttempt(receipt.attemptId, { status: 'running' }, 'attempt_started');
  groupchat._private.resetCache();
  const recovered = groupchat.getOrchestrator(root, 'restart').getState();
  assert.strictEqual(recovered.attempts[receipt.attemptId].status, 'recovering');
  assert.strictEqual(recovered.attempts[receipt.attemptId].recoveryReason, 'hub_restart');
  assert.strictEqual(recovered.currentMode, 'idle', 'restart must not leave a fake live spinner');
}

{
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'run-guard');
  const first = orch.beginTurn('first');
  orch.recordTurnPrompt(first.turnNum, 'sid-1', 'first prompt', {
    runId: first.runId, memberId: 'm1', kind: 'codex',
  });
  const second = orch.beginTurn('second', { turnNum: first.turnNum, appendUserMessage: false });
  const secondReceipt = orch.recordTurnPrompt(second.turnNum, 'sid-1', 'second prompt', {
    runId: second.runId, memberId: 'm1', kind: 'codex',
  });
  orch.completeTurn(first.turnNum, 'first', [], {}, {}, { runId: first.runId });
  const state = orch.getState();
  assert.strictEqual(state.activeRun.runId, second.runId);
  assert.strictEqual(state.currentMode, 'group', 'late old-run completion cannot clear the new run');
  assert.strictEqual(state.pendingPrompts[String(second.turnNum)]['sid-1'].attemptId, secondReceipt.attemptId,
    'late old-run completion cannot delete the new retry receipt');
}

{
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'late-final');
  const begin = orch.beginTurn('network race');
  const receipt = orch.recordTurnPrompt(begin.turnNum, 'sid-1', 'network race', {
    runId: begin.runId, memberId: 'm1', kind: 'codex',
  });
  const failure = { code: 'network_interrupted', retryable: true, autoRetry: false };
  const earlyFailure = {
    sid: 'sid-1', status: 'errored', text: '', reason: failure.code, failure,
    attemptId: receipt.attemptId, runId: begin.runId, providerTurnId: 'turn-1',
  };
  orch.patchTurnResult(begin.turnNum, 'sid-1', {
    ...earlyFailure, memberId: 'm1', speaker: 'Codex',
  });
  orch.patchTurnResult(begin.turnNum, 'sid-1', {
    text: '重连后最终答案', status: 'completed', attemptId: receipt.attemptId,
    runId: begin.runId, providerTurnId: 'turn-1', finality: 'provider_final', signalSource: 'task_complete',
  });
  // Promise.allSettled still holds the earlier failure object. Completing the
  // whole run later must not regress the already-patched provider final.
  orch.completeTurn(begin.turnNum, 'network race', [earlyFailure], {
    'sid-1': { memberId: 'm1', displayName: 'Codex', kind: 'codex' },
  }, {}, { runId: begin.runId });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].byStatus['sid-1'], 'completed');
  assert.strictEqual(state.turns[0].by['sid-1'], '重连后最终答案');
  assert.strictEqual(state.turns[0].failureBy['sid-1'], undefined);
  assert.strictEqual(state.attempts[receipt.attemptId].status, 'completed');
}

{
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'stable-cursor');
  orch.state.messages = [
    { seq: 10, role: 'assistant', sid: 'peer', speaker: 'Peer', content: '旧内容' },
    { seq: 20, role: 'user', speaker: '你', content: '当前问题' },
    { seq: 21, role: 'assistant', sid: 'peer', speaker: 'Peer', content: '新内容' },
  ];
  orch.state.lastDeliveredIdx.self = 0; // deliberately stale after insertion/removal
  orch.state.lastDeliveredSeq.self = 20;
  const delta = orch.buildDelta('self', '继续');
  assert.ok(delta.includes('新内容'));
  assert.ok(!delta.includes('旧内容'), 'stable seq cursor must beat a drifted array index');
}

console.log('groupchat ledger persistence: ok');
