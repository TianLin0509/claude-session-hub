'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFreshSession, hasSubmittedPrompt } = require('../core/session-history-state');

test('welcome output and PTY activity do not count as a submitted prompt', () => {
  const session = { kind: 'codex', status: 'running', lastMessageTime: Date.now(),
    lastOutputPreview: 'What brings you here?', _ptyRuntimeObservedAt: Date.now() };
  assert.equal(isFreshSession(session), true);
  assert.equal(hasSubmittedPrompt(session), false);
  for (const key of ['runStartedAt', 'lastRunStartedAt']) {
    assert.equal(isFreshSession({ ...session, [key]: Date.now() }), false);
  }
  assert.equal(hasSubmittedPrompt({ _attentionClock: { lastPromptAt: 100 } }), true);
  assert.equal(isFreshSession(null), false);
});

test('restored identities and resume picker retain history diagnostics', () => {
  for (const evidence of [{ codexSid: 'saved' }, { ccSessionId: 'saved' },
    { transcriptPath: 'saved.jsonl' }, { kind: 'codex-resume' }, { codexAllowMtimeFallback: true }]) {
    assert.equal(isFreshSession({ kind: 'codex', ...evidence }), false);
  }
});
