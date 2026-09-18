'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const attention = require('../core/session-attention-state');
const kinds = require('../core/ai-kinds');
const src = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function source(name) {
  const start = src.indexOf('function ' + name + '(');
  const end = src.indexOf('\n}', start + 1);
  return src.slice(start, end + 2);
}
function harness(kind, runtimeBackend) {
  const session = { id: 's', kind, runtimeBackend, status: 'idle', unreadCount: 0 };
  const noop = () => {};
  const c = { ...attention, require: p => require(path.resolve(__dirname, '../renderer', p)),
    ...kinds, isCodexKind: kinds.isCodexCliKind,
    sessions: new Map([['s', session]]), activeSessionId: 'other', document: { hasFocus: () => true },
    _lastWindowFocusAt: 0, Date, RUNTIME_COMPLETED: 'completed', CONFIDENCE_AUTHORITATIVE: 'authoritative',
    hasKimiBackgroundWork: () => false, clearKimiBackgroundFinishTimer: noop, cardWorkingLabel: () => kind,
    clearSessionConnectionIssue: noop, recordSessionArtifacts: noop, clearCodexCardWorking: noop,
    observeSessionRuntime: noop, scheduleSessionListRender: noop, schedulePersist: noop,
    armPtyBurstFallback: noop, markCodexCardWorking: noop, buildPreviewFromUserMessage: text => text,
    updateFloatingBarState: noop,
  };
  vm.createContext(c);
  for (const name of ['isTranscriptCliKind', 'isLegacyDeepSeekSession', 'isClaudeRuntimeSession',
    'buildReplyReadyPreview', 'onReplyCompleteFromTranscriptEvent', 'onPromptSubmittedFromTranscriptEvent']) {
    vm.runInContext(source(name), c);
  }
  const at = Date.now();
  const prompt = (turnId, offset) => c.onPromptSubmittedFromTranscriptEvent({ hubSessionId: 's', kind, turnId, submittedAt: at + offset, text: 'task' });
  const complete = (turnId, offset, extra = {}) => c.onReplyCompleteFromTranscriptEvent({ hubSessionId: 's', kind, turnId, completedAt: at + offset, text: 'answer', ...extra });
  return { session, c, prompt, complete };
}
for (const [kind, backend] of [['claude', 'claude-stream-json'], ['claude-resume', 'claude-stream-json'],
  ['codex', 'codex-app-server'], ['deepseek', undefined], ['gemini', undefined], ['kimi', undefined],
  ['qwen', 'acp'], ['deepseek-acp', 'acp'], ['glm', 'acp']]) {
  test(kind + ': completion unread, duplicate/stale protection, foreground and group ownership', () => {
    const { session, c, prompt, complete } = harness(kind, backend);
    prompt('one', 1); complete('one', 2);
    assert.equal(session.unreadCount, 1);
    assert.equal(attention.sessionHasCompletedUnread(session), true);
    complete('one', 2);
    assert.equal(session.unreadCount, 1, 'duplicate');
    prompt('two', 3);
    assert.equal(session.unreadCount, 0, 'new prompt acknowledges old answer');
    complete('one', 4);
    assert.equal(session.unreadCount, 0, 'old turn cannot finish new prompt');
    complete('two', 5);
    assert.equal(session.unreadCount, 1);
    c.activeSessionId = 's'; prompt('three', 6); complete('three', 7);
    assert.equal(session.unreadCount, 0, 'focused visible answer is read');
    c.activeSessionId = 'other'; prompt('group', 8); complete('group', 9, { meetingId: 'group' });
    assert.equal(session.unreadCount, 0, 'meeting owns member unread aggregation');
  });
}
