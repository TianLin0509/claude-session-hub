'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSessionReadyNotifier,
  isDesktopNotificationReady,
} = require('../renderer/session-ready-notifier.js');

function readySession(id, at = 1000) {
  return {
    id,
    kind: 'codex',
    title: `任务 ${id}`,
    status: 'idle',
    attentionState: 'reply-ready',
    replyReady: true,
    unreadCount: 1,
    replyReadyText: `回答 ${id}`,
    lastCompletedAt: at,
    lastMessageTime: at,
    runtimeTruth: {
      state: 'completed',
      source: 'test-completion',
      confidence: 'authoritative',
      observedAt: at,
      completedAt: at,
    },
  };
}

test('eligibility is the exact completed-unread state, not raw completion noise', () => {
  assert.equal(isDesktopNotificationReady(readySession('ok')), true);
  assert.equal(isDesktopNotificationReady({ ...readySession('running'), status: 'running', runtimeTruth: {
    state: 'running', source: 'test-running', confidence: 'authoritative', observedAt: 2000,
  } }), false);
  assert.equal(isDesktopNotificationReady({ ...readySession('waiting'), attentionState: 'needs-input' }), false);
  assert.equal(isDesktopNotificationReady({ ...readySession('seen'), unreadCount: 0 }), false);
  assert.equal(isDesktopNotificationReady({ ...readySession('meeting'), meetingId: 'm-1' }), false);
});

test('startup primes old unread sessions without replaying notifications', () => {
  const sessions = new Map([['old', readySession('old')]]);
  const sent = [];
  const notifier = createSessionReadyNotifier({
    ipcRenderer: { send: (...args) => sent.push(args) },
    getSessions: () => sessions,
  });
  assert.equal(notifier.scan().armed, false);
  assert.equal(notifier.prime().readyCount, 1);
  assert.equal(notifier.scan().notified, false);
  assert.deepEqual(sent, []);
});

test('one state entry sends once; staying unread does not spam; re-entry sends again', () => {
  const sessions = new Map([['task', { id: 'task', status: 'running', unreadCount: 0 }]]);
  const sent = [];
  const notifier = createSessionReadyNotifier({
    ipcRenderer: { send: (...args) => sent.push(args) },
    getSessions: () => sessions,
  });
  notifier.prime();

  sessions.set('task', readySession('task', 2000));
  assert.equal(notifier.scan().notified, true);
  sessions.get('task').unreadCount = 2;
  assert.equal(notifier.scan().notified, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'desktop-notification:show');

  sessions.set('task', { id: 'task', status: 'idle', attentionState: 'none', unreadCount: 0 });
  notifier.scan();
  sessions.set('task', readySession('task', 3000));
  assert.equal(notifier.scan().notified, true);
  assert.equal(sent.length, 2);
});

test('simultaneous completions coalesce into one payload with an accurate count', () => {
  const sessions = new Map();
  const sent = [];
  const notifier = createSessionReadyNotifier({
    ipcRenderer: { send: (...args) => sent.push(args) },
    getSessions: () => sessions,
  });
  notifier.prime();
  sessions.set('first', readySession('first', 1000));
  sessions.set('latest', readySession('latest', 2000));
  const result = notifier.scan();
  assert.equal(result.notified, true);
  assert.equal(result.newCount, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].sessionId, 'latest');
  assert.equal(sent[0][1].readyCount, 2);
  assert.equal(sent[0][1].newCount, 2);
});
