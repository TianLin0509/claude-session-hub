'use strict';

// 会议室两条休眠规则（2026-09-07 用户要求）：
//   1. 房间里只要还有人在动，其他成员就不能被闲置巡检单独收走 —— 群聊里一个 agent
//      在等队友说完，自己 5 小时没输入输出，以前就是这样被收走的，整条流程断在那里。
//   2. 开发循环跑到 pass（status='done'）时主动把整间房收掉，不必等巡检。

const assert = require('node:assert/strict');
const test = require('node:test');

const { SessionManager } = require('../core/session-manager.js');
const { suspendMeetingRoom } = require('../core/meeting-room-suspend.js');

const HOUR = 60 * 60 * 1000;

function seed(manager, id, info, activityAt) {
  manager.sessions.set(id, {
    info: { hubId: id, ...info },
    pty: null,
    pendingTimers: [],
    startedAt: activityAt,
    lastInputAt: activityAt,
    lastOutputAt: activityAt,
    suspendRequestedAt: 0,
  });
}

test('队友还在动时，干等的会议室成员不被单独休眠', () => {
  const manager = new SessionManager();
  const now = Date.now();
  const idle = now - 9 * HOUR;

  // 同一个会议室：waiter 自己 9 小时没动静，busy 队友 10 分钟前还在输出。
  seed(manager, 'waiter', { kind: 'claude', title: '一号位', ccSessionId: 'cc-1', meetingId: 'room-1' }, idle);
  seed(manager, 'busy', { kind: 'codex', title: '二号位', codexSid: 'sid-1', meetingId: 'room-1' }, now - 10 * 60 * 1000);
  // 对照组：不属于任何会议室的独立会话，同样闲置 9 小时 → 照旧该休眠。
  seed(manager, 'lonely', { kind: 'codex', title: '独立', codexSid: 'sid-2' }, idle);

  const preview = manager.previewIdleSuspend({ idleMs: 5 * HOUR, now });
  const byId = new Map(preview.items.map(item => [item.sessionId, item]));
  assert.equal(byId.get('waiter').eligible, false, '队友在跑时不该收走干等的成员');
  assert.equal(byId.get('waiter').reason, 'meeting-room-active');
  assert.equal(byId.get('busy').eligible, false);
  assert.equal(byId.get('lonely').eligible, true, '不在会议室里的会话不受这条规则影响');

  // excludeMeeting:false 是 main/session-auto-suspend.js sweepOptions 的实际取值：
  // 群聊成员本来就参与巡检，挡住 waiter 的只能是新的房间级计时。
  const swept = manager.suspendIdleSessions({ idleMs: 5 * HOUR, now, excludeMeeting: false, reason: 'idle-timeout' });
  assert.deepEqual(swept.requested, ['lonely'], '实际执行必须跟预演一致');
});

test('整间闲够了仍会被一起收走，不给会议室永久免死金牌', () => {
  const manager = new SessionManager();
  const now = Date.now();
  const idle = now - 9 * HOUR;
  seed(manager, 'a', { kind: 'claude', title: '一号位', ccSessionId: 'cc-1', meetingId: 'room-1' }, idle);
  seed(manager, 'b', { kind: 'codex', title: '二号位', codexSid: 'sid-1', meetingId: 'room-1' }, idle);

  const swept = manager.suspendIdleSessions({ idleMs: 5 * HOUR, now, excludeMeeting: false, reason: 'idle-timeout' });
  assert.deepEqual(swept.requested.sort(), ['a', 'b']);
});

function roomHarness() {
  const manager = new SessionManager();
  const now = Date.now();
  seed(manager, 'a', { kind: 'claude', title: '一号位', ccSessionId: 'cc-1', meetingId: 'room-1' }, now);
  seed(manager, 'b', { kind: 'codex', title: '二号位', codexSid: 'sid-1', meetingId: 'room-1' }, now);
  const meeting = { id: 'room-1', subSessions: ['a', 'b'], status: 'idle' };
  const pushed = [];
  const meetingManager = {
    getMeeting: id => (id === 'room-1' ? meeting : null),
    updateMeeting: (id, fields) => { Object.assign(meeting, fields); return { ...meeting }; },
  };
  return { manager, meeting, meetingManager, pushed,
    sendToRenderer: (channel, payload) => pushed.push({ channel, payload }) };
}

test('整间休眠：成员全部收走后房间才标 dormant，并推给渲染进程', () => {
  const h = roomHarness();
  const result = suspendMeetingRoom('room-1', {
    meetingManager: h.meetingManager,
    sessionManager: h.manager,
    sendToRenderer: h.sendToRenderer,
    logger: { log() {}, warn() {} },
    reason: 'loop-passed',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.suspended.sort(), ['a', 'b']);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.meetingDormant, true);
  assert.equal(h.meeting.status, 'dormant');
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0].channel, 'meeting-updated');
  assert.equal(h.pushed[0].payload.meeting.status, 'dormant');
});

test('有成员收不掉时房间不标 dormant——否则会出现"已休眠但里面还有人在跑"', () => {
  const h = roomHarness();
  // 缺原生会话 ID 的成员过不了休眠闸门。
  h.manager.sessions.get('b').info.codexSid = null;
  const result = suspendMeetingRoom('room-1', {
    meetingManager: h.meetingManager,
    sessionManager: h.manager,
    sendToRenderer: h.sendToRenderer,
    logger: { log() {}, warn() {} },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.suspended, ['a']);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.meetingDormant, false);
  assert.equal(h.meeting.status, 'idle');
  assert.equal(h.pushed.length, 0);
});

test('成员早就不在会话表里，不算收不掉', () => {
  const h = roomHarness();
  h.manager.sessions.delete('b');
  const result = suspendMeetingRoom('room-1', {
    meetingManager: h.meetingManager,
    sessionManager: h.manager,
    sendToRenderer: h.sendToRenderer,
    logger: { log() {}, warn() {} },
  });
  assert.equal(result.blocked.length, 0);
  assert.equal(result.skipped['session-not-found'], 1);
  assert.equal(result.meetingDormant, true);
});

test('缺依赖或房间不存在时安静返回错误，不抛异常', () => {
  assert.equal(suspendMeetingRoom('').error, 'meeting-id-missing');
  assert.equal(suspendMeetingRoom('room-1', {}).error, 'meeting-manager-missing');
  assert.equal(suspendMeetingRoom('room-x', {
    meetingManager: { getMeeting: () => null },
    sessionManager: { suspendSession: () => ({ ok: true }) },
  }).error, 'meeting-not-found');
});

console.log('unit-meeting-room-suspend OK');
