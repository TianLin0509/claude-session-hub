'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSessionIpc } = require('../main/ipc/session-handlers.js');

test('主动打开只更新活动时间，不制造回答完成、未读或运行态；缺失会话失败', () => {
  const handlers = new Map();
  const info = { id: 'old', lastMessageTime: 100, lastCompletedAt: 90, unreadCount: 0, status: 'idle' };
  registerSessionIpc({ handle: (key, fn) => handlers.set(key, fn), on() {} }, {
    sendToRenderer() {}, sessionManager: {
      getSession: id => id === info.id ? { ...info } : null,
      updateSessionMeta: (_id, fields) => Object.assign(info, fields),
    },
  });
  const open = handlers.get('session:record-history-open');
  const before = Date.now();
  const result = open(null, { sessionId: 'old' });
  assert.equal(result.ok, true); assert.ok(result.at >= before);
  assert.equal(info.lastMessageTime, result.at);
  assert.equal(info.lastCompletedAt, 90); assert.equal(info.unreadCount, 0); assert.equal(info.status, 'idle');
  assert.equal(open(null, { sessionId: 'missing' }).ok, false);
  assert.equal(open(null).ok, false);
});

test('底层拒绝更新时明确失败', () => {
  const handlers = new Map();
  registerSessionIpc({ handle: (key, fn) => handlers.set(key, fn), on() {} }, {
    sendToRenderer() {}, sessionManager: { getSession: () => ({ id: 'old' }), updateSessionMeta: () => undefined },
  });
  assert.equal(handlers.get('session:record-history-open')(null, { sessionId: 'old' }).ok, false);
});
