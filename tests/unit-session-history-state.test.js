'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFreshSession, hasSubmittedPrompt, isFreshLaunch } = require('../core/session-history-state');

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
    { transcriptPath: 'saved.jsonl' }, { kind: 'codex-resume' }, { codexAllowMtimeFallback: true },
    { geminiChatId: 'saved' }, { kimiSid: 'saved' }, { kimiSessionDir: 'saved' }, { acpSid: 'saved' }]) {
    assert.equal(isFreshSession({ kind: 'codex', ...evidence }), false);
  }
});

test('launch intent is captured before IDs are allocated, never inferred for a restored conversation', () => {
  for (const kind of ['claude', 'codex', 'gemini', 'kimi', 'deepseek', 'qwen', 'glm']) {
    assert.equal(isFreshLaunch(kind), true);
    assert.equal(isFreshLaunch(kind + '-resume'), false);
    for (const options of [{ useResume: true }, { useContinue: true }, { resumePicker: true },
      { resumeCCSessionId: 'id' }, { forkCCSessionId: 'id' }, { codexSid: 'id' }, { codexForkSid: 'id' },
      { geminiChatId: 'id' }, { kimiSid: 'id' }, { acpSid: 'id' }, { resumeTranscriptPath: 'file' }]) {
      assert.equal(isFreshLaunch(kind, options), false);
    }
  }
  const fresh = { kind: 'claude', freshLaunch: true, ccSessionId: 'allocated' };
  assert.equal(isFreshSession(fresh), true);
  assert.equal(isFreshSession({ ...fresh, freshLaunch: false }), false);
  assert.equal(isFreshSession({ ...fresh, runStartedAt: 123 }), false);
  assert.equal(isFreshSession({ ...fresh, transcriptPath: 'pending' }), false);
  assert.equal(isFreshSession({ ...fresh, transcriptPath: 'pending' }, { allowMissingTranscript: true }), true);
  assert.equal(isFreshSession({ ...fresh, transcriptPath: 'pending', lastRunStartedAt: 123 }, { allowMissingTranscript: true }), false);
});
