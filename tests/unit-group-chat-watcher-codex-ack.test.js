'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const watcher = require('../core/group-chat-watcher.js');

function harness({ acknowledgeOnEnter = 4 } = {}) {
  const transcriptTap = new EventEmitter();
  const writes = [];
  let activity = 0;
  let enterCount = 0;
  const sessionManager = {
    getSession: () => ({ id: 'agent-session', transcriptKind: 'codex', kind: 'codex', cwd: process.cwd() }),
    getGroupChatReady: () => true,
    setGroupChatReady() {},
    getGroupChatLastActivity: () => activity,
    getSessionBuffer: () => '',
    writeToSession(sid, data) {
      writes.push({ sid, data });
      activity += 1;
      if (data === '\r') {
        enterCount += 1;
        if (enterCount === acknowledgeOnEnter) {
          setImmediate(() => transcriptTap.emit('turn-started', { hubSessionId: sid, turnId: 'turn-ack' }));
        }
      }
    },
  };
  watcher.init({
    sessionManager,
    transcriptTap,
    cliReadyDetector: { isReady: () => true },
    codexTurnStartAckMs: 20,
    codexTurnStartRecoveryMs: 30,
  });
  return { sessionManager, transcriptTap, writes, get enterCount() { return enterCount; } };
}

test('Codex paste receives a late isolated Enter until task_started acknowledges submission', async () => {
  const state = harness({ acknowledgeOnEnter: 4 });
  const result = await watcher.sendToPty('agent-session', 'agent prompt', 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.sendStatus, 'auto_recovered');
  assert.equal(state.enterCount, 4, 'three ordinary Enter attempts plus one late recovery Enter');
  assert.equal(state.transcriptTap.listenerCount('turn-started'), 0, 'ack listener must be removed');
});

test('Codex paste reports stuck when no provider turn ever acknowledges the prompt', async () => {
  const state = harness({ acknowledgeOnEnter: Number.POSITIVE_INFINITY });
  const result = await watcher.sendToPty('agent-session', 'agent prompt', 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.sendStatus, 'stuck');
  assert.equal(state.enterCount, 5, 'three ordinary attempts and two bounded late recoveries');
  assert.equal(state.transcriptTap.listenerCount('turn-started'), 0, 'failed ack listener must be removed');
});
