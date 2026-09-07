'use strict';

// 会议室两条休眠规则（2026-09-07 用户要求）：
//   1. 会议室成员不被闲置巡检自动休眠 —— 群聊里一个 agent 在等队友说完，自己几小时
//      没有输入输出，以前就是这样被单独收走的，房间缺人，整条流程断在那里。
//   2. 开发循环跑到 pass（status='done'）时主动把整间房收掉，这才是会议室 PTY 的回收路径。
//
// 第 1 条曾经做成「按房间共享最近活动时间」，被评审打回：watcher 长时间不吐字时，
// 全房间的活动时间都是旧的，等待的队友照样被收走。下面第一条测试就是那个复现场景，
// 它守着「不能再退回按时间共享」这件事。

const assert = require('node:assert/strict');
const test = require('node:test');

const { SessionManager } = require('../core/session-manager.js');
const { suspendMeetingRoom } = require('../core/meeting-room-suspend.js');
const {
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
} = require('../main/session-auto-suspend.js');

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

// 走真实调度器（不是手搓 options），这样「sweepOptions 里到底传了什么」也被一起守住。
function idleSweepHarness({ watchers = new Map(), now = Date.now() } = {}) {
  const manager = new SessionManager();
  const silent = now - 9 * HOUR;
  seed(manager, 'worker', { kind: 'claude', title: '一号位·工作位', ccSessionId: 'cc-1', meetingId: 'room-1' }, silent);
  seed(manager, 'waiter', { kind: 'codex', title: '二号位·评审位', codexSid: 'sid-1', meetingId: 'room-1' }, silent);
  seed(manager, 'lonely', { kind: 'codex', title: '独立会话', codexSid: 'sid-2' }, silent);
  const meeting = { id: 'room-1', groupChat: true, subSessions: ['worker', 'waiter'] };
  const meetingManager = {
    getAllMeetings: () => [meeting],
    getMeeting: id => (id === 'room-1' ? meeting : null),
  };
  const scheduler = createSessionAutoSuspendScheduler({
    sessionManager: manager,
    getProtectedSessionIds: () => collectProtectedSessionIds({
      groupChatDispatcher: { getActiveWatchers: () => watchers },
      meetingManager,
    }),
    logger: { log() {}, warn() {} },
    now: () => now,
  });
  return { manager, scheduler };
}

test('评审复现场景：一号位 watcher 未结束且 9 小时没吐字，等它的队友也不被收走', () => {
  // 这正是上一轮被打回的场景。按房间共享「最近活动时间」救不了 waiter：
  // worker 的 watcher 虽然还活着，但它 9 小时没有输出，房间的活动时间也是旧的。
  const h = idleSweepHarness({ watchers: new Map([['worker', { isSettled: () => false }]]) });

  const preview = h.scheduler.preview();
  const byId = new Map(preview.items.map(item => [item.sessionId, item]));
  assert.equal(byId.get('waiter').eligible, false, '干等队友的会议室成员不该被自动休眠');
  assert.equal(byId.get('waiter').reason, 'meeting-member');
  assert.equal(byId.get('worker').eligible, false);
  assert.equal(byId.get('lonely').eligible, true, '不在会议室里的会话不受这条规则影响');

  const swept = h.scheduler.sweep();
  assert.deepEqual(swept.requested, ['lonely'], '实际执行必须跟预演一致');
});

test('房间里一个 watcher 都没有时，成员同样不被闲置巡检收走', () => {
  // 会议室成员的 PTY 由「循环 pass 后整间休眠」和手动休眠回收，不靠闲置巡检 ——
  // 靠巡检就必然要回答「这个成员是不是在等别人」，而那个问题没有可靠答案。
  const h = idleSweepHarness();
  const swept = h.scheduler.sweep();
  assert.deepEqual(swept.requested, ['lonely']);
  assert.equal(swept.skipped['meeting-member'], 2);
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
