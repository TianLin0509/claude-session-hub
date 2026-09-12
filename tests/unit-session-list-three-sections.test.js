'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { partitionSidebarSessions } = require('../renderer/session-list-renderer');
const now = Date.now(), DAY = 86400000;
const item = (id, extra = {}) => ({ id, kind: 'claude', status: 'idle', lastMessageTime: now, ...extra });
const ids = items => items.map(s => s.id);

test('置顶、未读优先，活跃按等待、异常、运行排序，今天严格小于 24h', () => {
  const rows = [item('today'), item('read', { unreadCount: 1 }),
    item('run', { status: 'running' }), item('error', { status: 'failed' }),
    item('wait', { status: 'idle', attentionState: 'needs-input' }), item('pin', { pinned: true, status: 'idle', attentionState: 'needs-input' }),
    item('archive', { status: 'dormant' }), item('boundary', { lastMessageTime: now - DAY })];
  const p = partitionSidebarSessions(rows, { now });
  assert.deepEqual(ids(p.pinned), ['pin']);
  assert.deepEqual(ids(p.active), ['wait', 'error', 'run']);
  assert.deepEqual(ids(p.unread), ['read']);
  assert.deepEqual(ids(p.today), ['today']);
  assert.deepEqual(ids(p.archive), ['archive']);
  assert.equal(p.archiveCount, 1);
  assert.deepEqual(ids(p.older), ['boundary']);
});
test('休眠未读不受归档时间限制；置底休眠进归档；置顶不重复计数', () => {
  const p = partitionSidebarSessions([
    item('fresh', { status: 'dormant', unreadCount: 1 }),
    item('old', { status: 'dormant', unreadCount: 1, lastMessageTime: now - 2 * DAY }),
    item('bottom', { status: 'dormant', bottomed: true }),
    item('pin', { status: 'dormant', pinned: true }),
  ], { now });
  assert.deepEqual(ids(p.unread), ['fresh', 'old']);
  assert.deepEqual(ids(p.archive).sort(), ['bottom']);
  assert.equal(p.archiveCount, 1);
  assert.deepEqual(ids(p.pinned), ['pin']);
});
test('旧活信号不消失，群聊沿用成员状态；选中不等于已读', () => {
  const sub = item('sub', { status: 'idle', attentionState: 'needs-input' });
  const p = partitionSidebarSessions([
    item('group', { _isMeeting: true, _meeting: { subSessions: ['sub'] }, lastMessageTime: now - 8 * DAY }),
    item('selected', { unreadCount: 1 }),
    item('waking', { status: 'dormant', _resumePending: true, lastMessageTime: now - 8 * DAY }),
  ], { now, sessionMap: new Map([['sub', sub]]), activeSessionId: 'selected' });
  assert.deepEqual(ids(p.active), ['group', 'waking']);
  assert.deepEqual(ids(p.unread), ['selected']);
});
test('700 多条休眠只贡献归档计数，输入不被修改', () => {
  const rows = Array.from({ length: 712 }, (_, i) => Object.freeze(item(String(i), { status: 'dormant' })));
  const p = partitionSidebarSessions(Object.freeze(rows), { now });
  assert.equal(p.archiveCount, 712);
  assert.equal(p.pinned.length + p.active.length + p.today.length, 0);
});

test('群聊任意成员未读优先分组，同时保留其他成员运行/等待状态', () => {
  const members = new Map([
    ['reader', item('reader', { unreadCount: 1, status: 'dormant' })],
    ['worker', item('worker', { status: 'running' })],
  ]);
  const group = item('group', { _isMeeting: true, _meeting: { groupChat: true, subSessions: ['reader', 'worker'] }, unreadAnsweredSize: 0 });
  let p = partitionSidebarSessions([group], { now, sessionMap: members });
  assert.deepEqual(ids(p.unread), ['group']); assert.equal(p.states.get('group'), 'run');
  assert.equal(p.active.length, 0);
  members.get('worker').attentionState = 'needs-input';
  p = partitionSidebarSessions([group], { now, sessionMap: members });
  assert.deepEqual(ids(p.unread), ['group']); assert.equal(p.states.get('group'), 'wait');
  members.get('reader').unreadCount = 0;
  p = partitionSidebarSessions([group], { now, sessionMap: members });
  assert.equal(p.unread.length, 0); assert.deepEqual(ids(p.active), ['group']);
});
