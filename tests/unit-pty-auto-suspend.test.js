'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../core/session-manager');

test('room completion cannot stop a PTY member with a live authoritative turn', () => {
  const sm = new SessionManager();
  sm.sessions.set('s', { info: { id:'s', kind:'codex', agentRuntime:'pty', codexSid:'thread' }, startedAt:1 });
  sm.noteAgentTurnStarted('s', { turnId:'a', startedAt:100 });
  assert.equal(sm._evaluateSuspendEligibility('s', { reason:'meeting-room-complete' }).error, 'pty-turn-unfinished');
  sm.noteAgentTurnFinished('s', { turnId:'previous', completedAt:150 });
  assert.equal(sm._evaluateSuspendEligibility('s', { reason:'meeting-room-complete' }).ok, false);
  sm.noteAgentTurnFinished('s', { turnId:'a', completedAt:200 });
  assert.equal(sm._evaluateSuspendEligibility('s', { reason:'meeting-room-complete' }).ok, true);
  sm.noteAgentTurnStarted('s', { turnId:'b', startedAt:300 });
  sm.noteAgentTurnFinished('s', { turnId:'a', completedAt:400 });
  assert.equal(sm._evaluateSuspendEligibility('s', { reason:'meeting-room-complete' }).ok, false);
  assert.equal(sm._evaluateSuspendEligibility('s', { reason:'restart' }).ok, true, 'explicit restart keeps its existing interrupt semantics');
});
