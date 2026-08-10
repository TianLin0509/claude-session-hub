'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ATTENTION_NEEDS_INPUT,
  ATTENTION_NONE,
  ATTENTION_REPLY_READY,
  applyPromptSubmitted,
  applyReplyCompleted,
  attentionStateOf,
  clearSessionAttention,
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');

test('ordinary unseen completion is completed-unread, not needs-input', () => {
  const session = { status: 'running', unreadCount: 0 };
  const result = applyReplyCompleted(session, {
    completedAt: 2000,
    turnId: 'turn-1',
    text: '报告已经完成',
    seenByUser: false,
  });
  assert.equal(result.applied, true);
  assert.equal(attentionStateOf(session), ATTENTION_REPLY_READY);
  assert.equal(session.isWaiting, false);
  assert.equal(session.replyReady, true);
  assert.equal(session.unreadCount, 1);
  assert.equal(sessionHasCompletedUnread(session), true);
  assert.equal(sessionNeedsUserInput(session), false);
});

test('real CLI question remains needs-input even while visible', () => {
  const session = { status: 'running', unreadCount: 0 };
  applyReplyCompleted(session, {
    completedAt: 3000,
    text: '请选择部署环境',
    seenByUser: true,
    needsUserInput: true,
    reason: 'question',
  });
  assert.equal(attentionStateOf(session), ATTENTION_NEEDS_INPUT);
  assert.equal(session.isWaiting, true);
  assert.equal(session.unreadCount, 0);
  assert.equal(sessionNeedsUserInput(session), true);
});

test('new prompt clears attention and stale completion cannot override it', () => {
  const session = { status: 'idle', unreadCount: 1, attentionState: ATTENTION_REPLY_READY };
  assert.equal(applyPromptSubmitted(session, {
    submittedAt: 5000,
    turnId: 'turn-new',
  }).applied, true);
  assert.equal(attentionStateOf(session), ATTENTION_NONE);
  assert.equal(session.status, 'running');

  const stale = applyReplyCompleted(session, {
    completedAt: 4900,
    turnId: 'turn-old',
    text: '旧答案',
    seenByUser: false,
  });
  assert.equal(stale.applied, false);
  assert.match(stale.reason, /^stale-completion/);
  assert.equal(session.status, 'running');
  assert.equal(session.unreadCount, 0, 'submitting the next prompt acknowledges the previous unread reply');
});

test('turn mismatch rejects a delayed completion even with a later delivery time', () => {
  const session = { status: 'idle', unreadCount: 0 };
  applyPromptSubmitted(session, { submittedAt: 1000, turnId: 'turn-2' });
  const result = applyReplyCompleted(session, {
    completedAt: 2000,
    turnId: 'turn-1',
    text: '延迟投递的旧答案',
    seenByUser: false,
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'stale-completion-turn');
  assert.equal(session.status, 'running');
});

test('legacy reply-ready waiting flag migrates without becoming needs-input', () => {
  const session = {
    isWaiting: true,
    waitingReason: 'reply-ready',
    waitingText: '旧版完成提示',
    unreadCount: 1,
  };
  assert.equal(attentionStateOf(session), ATTENTION_REPLY_READY);
  assert.equal(sessionNeedsUserInput(session), false);
  assert.equal(sessionHasCompletedUnread(session), true);
  clearSessionAttention(session, { clearUnread: true });
  assert.equal(attentionStateOf(session), ATTENTION_NONE);
  assert.equal(session.unreadCount, 0);
});
