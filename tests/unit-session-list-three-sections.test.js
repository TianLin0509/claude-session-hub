'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { partitionSidebarSessions } = require('../renderer/session-list-renderer');
const now = Date.now(), DAY = 86400000;
const item = (id, extra = {}) => ({ id, kind: 'codex', status: 'idle', lastMessageTime: now, ...extra });
const ids = items => items.map(s => s.id);

test('置顶优先，活跃按等待、异常、运行、未读排序，今天严格小于 24h', () => {
  const rows = [item('today'), item('read', { unreadCount: 1 }),
    item('run', { status: 'running' }), item('error', { status: 'failed' }),
    item('wait', { status: 'idle', attentionState: 'needs-input' }), item('pin', { pinned: true, status: 'idle', attentionState: 'needs-input' }),
    item('archive', { status: 'dormant' }), item('boundary', { lastMessageTime: now - DAY })];
  const p = partitionSidebarSessions(rows, { now });
  assert.deepEqual(ids(p.pinned), ['pin']);
  assert.deepEqual(ids(p.active), ['wait', 'error', 'run', 'read']);
  assert.deepEqual(ids(p.today), ['today']);
  assert.deepEqual(ids(p.archive), ['archive']);
  assert.equal(p.archiveCount, 1);
  assert.deepEqual(ids(p.older), ['boundary']);
});
test('刚休眠未读继续活跃；旧未读、置底休眠进归档；置顶休眠不重复计数', () => {
  const p = partitionSidebarSessions([
    item('fresh', { status: 'dormant', unreadCount: 1 }),
    item('old', { status: 'dormant', unreadCount: 1, lastMessageTime: now - 2 * DAY }),
    item('bottom', { status: 'dormant', bottomed: true }),
    item('pin', { status: 'dormant', pinned: true }),
  ], { now });
  assert.deepEqual(ids(p.active), ['fresh']);
  assert.deepEqual(ids(p.archive).sort(), ['bottom', 'old']);
  assert.equal(p.archiveCount, 2);
  assert.deepEqual(ids(p.pinned), ['pin']);
});
test('旧活信号不消失，群聊沿用成员状态；已选未读不计作新提醒', () => {
  const sub = item('sub', { status: 'idle', attentionState: 'needs-input' });
  const p = partitionSidebarSessions([
    item('group', { _isMeeting: true, _meeting: { subSessions: ['sub'] }, lastMessageTime: now - 8 * DAY }),
    item('selected', { unreadCount: 1 }),
    item('waking', { status: 'dormant', _resumePending: true, lastMessageTime: now - 8 * DAY }),
  ], { now, sessionMap: new Map([['sub', sub]]), activeSessionId: 'selected' });
  assert.deepEqual(ids(p.active), ['group', 'waking']);
  assert.deepEqual(ids(p.today), ['selected']);
});
test('700 多条休眠只贡献归档计数，输入不被修改', () => {
  const rows = Array.from({ length: 712 }, (_, i) => Object.freeze(item(String(i), { status: 'dormant' })));
  const p = partitionSidebarSessions(Object.freeze(rows), { now });
  assert.equal(p.archiveCount, 712);
  assert.equal(p.pinned.length + p.active.length + p.today.length, 0);
});
