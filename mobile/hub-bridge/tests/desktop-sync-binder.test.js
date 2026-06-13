'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { DesktopSyncBinder } = require('../desktop-sync-binder');
const { MSG } = require('../../shared/protocol');

function makeOutbound() {
  const sent = [];
  return {
    sent,
    send(msg) { sent.push(msg); return true; },
  };
}

test('DesktopSyncBinder snapshot includes live sessions and meetings', () => {
  const outbound = makeOutbound();
  const sessionManager = new EventEmitter();
  sessionManager.getAllSessions = () => [
    {
      id: 's1',
      kind: 'claude',
      title: '桌面 Claude',
      cwd: 'C:\\repo',
      createdAt: 10,
      lastMessageTime: 20,
      lastOutputPreview: '刚刚完成了一个方案',
    },
  ];
  sessionManager.getSession = (id) => id === 's1'
    ? { id: 's1', kind: 'claude', title: 'Desktop Claude', model: 'claude-opus-4-7', status: 'active' }
    : null;
  const meetingManager = {
    getAllMeetings: () => [
      { id: 'm1', title: 'AI 群聊', scene: 'general', subSessions: ['s1'], createdAt: 11, lastMessageTime: 30 },
    ],
    loadTimelineLazy: () => true,
    getTimeline: () => [{ text: '群聊最后一条' }],
  };
  const binder = new DesktopSyncBinder({ sessionManager, meetingManager, outbound, logger: { warn() {} } });

  binder.handleSnapshotRequest({ deviceToken: 'dt', requestId: 'r1' });

  assert.equal(outbound.sent.length, 1);
  assert.equal(outbound.sent[0].type, MSG.HUB_SNAPSHOT);
  assert.equal(outbound.sent[0].deviceToken, 'dt');
  assert.equal(outbound.sent[0].snapshot.cards.length, 2);
  assert.equal(outbound.sent[0].snapshot.cards[0].targetType, 'meeting');
  assert.equal(outbound.sent[0].snapshot.cards[0].members.length, 1);
  assert.equal(outbound.sent[0].snapshot.cards[0].members[0].kind, 'claude');
  assert.equal(outbound.sent[0].snapshot.cards[0].timeline.length, 1);
  assert.equal(outbound.sent[0].snapshot.cards[1].targetType, 'session');
});

test('DesktopSyncBinder hub-command writes to target session and acks', async () => {
  const outbound = makeOutbound();
  const writes = [];
  const sessionManager = new EventEmitter();
  sessionManager.getSession = (id) => id === 's1'
    ? { id: 's1', kind: 'claude', title: '桌面 Claude', createdAt: 10, lastMessageTime: 20 }
    : null;
  sessionManager.getSessionBuffer = () => 'ready';
  sessionManager.writeToSession = (sessionId, data) => writes.push({ sessionId, data });
  const transcriptTap = { notePrompt() {} };
  const binder = new DesktopSyncBinder({ sessionManager, transcriptTap, outbound, logger: { warn() {} } });

  binder.handleCommand({
    deviceToken: 'dt',
    clientId: 'c1',
    targetType: 'session',
    targetId: 's1',
    content: 'hello hub',
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(writes, [{ sessionId: 's1', data: 'hello hub\r' }]);
  assert.equal(outbound.sent[0].type, MSG.COMMAND_ACK);
  assert.equal(outbound.sent[0].ok, true);
  assert.equal(outbound.sent[0].clientId, 'c1');
});

test('DesktopSyncBinder hub-command dispatches to target meeting and emits completion delta', async () => {
  const outbound = makeOutbound();
  const meetingManager = {
    getMeeting: (id) => id === 'm1'
      ? { id: 'm1', title: 'AI meeting', scene: 'general', subSessions: ['s1'], createdAt: 10, lastMessageTime: 20 }
      : null,
    loadTimelineLazy: () => true,
    getTimeline: () => [{ text: 'last meeting turn' }],
  };
  const dispatchCalls = [];
  const binder = new DesktopSyncBinder({
    sessionManager: new EventEmitter(),
    meetingManager,
    outbound,
    dispatchGroupChatTurn: async (meetingId, payload) => {
      dispatchCalls.push({ meetingId, payload });
      return { status: 'queued' };
    },
    logger: { warn() {} },
  });

  binder.handleCommand({
    deviceToken: 'dt',
    clientId: 'c2',
    targetType: 'meeting',
    targetId: 'm1',
    content: 'hello meeting',
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(outbound.sent[0].type, MSG.COMMAND_ACK);
  assert.equal(outbound.sent[0].ok, true);
  assert.deepEqual(dispatchCalls, [{ meetingId: 'm1', payload: { userInput: 'hello meeting', source: 'mobile-ai-hub' } }]);
  assert.equal(outbound.sent[1].type, MSG.HUB_DELTA);
  assert.equal(outbound.sent[1].card.targetType, 'meeting');
  assert.equal(outbound.sent[1].turn.sessionId, 'meeting:m1');
});

test('DesktopSyncBinder manages desktop session rename pin and destroy', async () => {
  const outbound = makeOutbound();
  const sessionManager = new EventEmitter();
  const sessions = new Map([
    ['s1', { id: 's1', kind: 'powershell', title: 'Old title', createdAt: 10, lastMessageTime: 20 }],
  ]);
  sessionManager.getSession = (id) => sessions.get(id) ? { ...sessions.get(id) } : null;
  sessionManager.getAllSessions = () => Array.from(sessions.values()).map(s => ({ ...s }));
  sessionManager.renameSession = (id, title, opts = {}) => {
    const s = sessions.get(id);
    if (!s) return undefined;
    Object.assign(s, { title, userRenamed: !!opts.userRenamed });
    return { ...s };
  };
  sessionManager.updateSessionMeta = (id, fields = {}) => {
    const s = sessions.get(id);
    if (!s) return undefined;
    Object.assign(s, fields);
    sessionManager.emit('session-updated', { ...s });
    return { ...s };
  };
  sessionManager.closeSession = (id) => {
    sessions.delete(id);
  };
  const binder = new DesktopSyncBinder({ sessionManager, outbound, logger: { warn() {} } });

  assert.equal(binder.handleRename({ deviceToken: 'dt', sessionId: 's1', title: 'New title' }), true);
  assert.equal(sessions.get('s1').title, 'New title');
  assert.equal(outbound.sent.at(-1).type, MSG.HUB_SNAPSHOT);
  assert.equal(outbound.sent.at(-1).snapshot.cards[0].title, 'New title');

  assert.equal(binder.handlePin({ deviceToken: 'dt', sessionId: 's1', pinned: true }), true);
  assert.equal(sessions.get('s1').pinned, true);
  assert.equal(outbound.sent.at(-1).snapshot.cards[0].pinned, true);

  assert.equal(binder.handleDestroy({ deviceToken: 'dt', sessionId: 's1' }), true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(sessions.has('s1'), false);
  assert.equal(outbound.sent.at(-1).snapshot.cards.some(c => c.id === 's1'), false);
});
