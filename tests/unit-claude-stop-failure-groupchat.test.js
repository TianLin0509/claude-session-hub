'use strict';

const assert = require('node:assert');
const { TranscriptTap } = require('../core/transcript-tap.js');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');

(async () => {
  const tap = new TranscriptTap();
  tap.registerSession('claude-sid', 'claude', {});
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'claude-sid',
    label: 'Claude',
    kind: 'claude',
    attempt: {
      attemptId: 'claude-attempt', runId: 'claude-run', sid: 'claude-sid', kind: 'claude',
      dispatchAt: Date.now() - 100,
    },
    softAlertT1Ms: 5000,
    softAlertT2Ms: 10000,
  });
  const pending = watcher.wait();
  tap.notifyClaudeError('claude-sid', {
    message: 'stream disconnected before completion: ECONNRESET',
    completedAt: Date.now(),
  });
  const result = await pending;
  assert.strictEqual(result.status, 'errored');
  assert.strictEqual(result.failure.code, 'network_interrupted');
  assert.strictEqual(result.failure.autoRetry, false);
  assert.strictEqual(result.attemptId, 'claude-attempt');
  tap.unregisterSession('claude-sid');
  console.log('claude StopFailure -> groupchat failure: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
