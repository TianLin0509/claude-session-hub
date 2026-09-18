'use strict';

// 群聊分支三个 IPC 的行为契约（2026-09-17）：
//   groupchat:add-existing-session / groupchat:create-from-sessions / groupchat:fork-meeting
//
// 这里用替身跑真实 handler，重点守三件事：
//   1. 拒绝必须给得出原因（没有原生 ID、类型不支持、轮次进行中、开发群聊）。
//   2. 分支参数必须真的传下去（fork id、模型、effort、mcpProfile…）——历史上
//      这些字段每漏一个，用户就会得到一个被悄悄打回默认配置的成员。
//   3. 中途失败必须整体回滚，不留下半个群聊。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerGroupChatForkIpc } = require('../main/ipc/groupchat-fork-handlers.js');
const groupchat = require('../core/group-chat-orchestrator.js');

let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log('  OK ' + name),
    (error) => { failed += 1; console.error('  FAIL ' + name); console.error(error.stack || error.message); },
  ));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gc-fork-ipc-'));

const CLAUDE_NATIVE_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_NATIVE_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function claudeSession(id, extra = {}) {
  return {
    id,
    kind: 'claude',
    title: `会话 ${id}`,
    cwd: 'C:\\work\\proj',
    ccSessionId: CLAUDE_NATIVE_ID,
    runtimeBackend: 'claude-stream-json',
    nativeConfig: {},
    currentModel: { id: 'opus' },
    effort: 'high',
    mcpProfile: 'lean',
    fastMode: false,
    ...extra,
  };
}

function codexSession(id, extra = {}) {
  return {
    id, kind: 'codex', title: `会话 ${id}`, cwd: 'C:\\work\\proj',
    codexSid: CODEX_NATIVE_ID, currentModel: { id: 'gpt-5.5' }, effort: 'xhigh',
    codexSpeedTier: 'fast', ...extra,
  };
}

function harness({ sessions = [], meetings = [], failAddOnCall = 0 } = {}) {
  const ipc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
  const sessionsById = new Map(sessions.map(s => [s.id, s]));
  const meetingsById = new Map(meetings.map(m => [m.id, { subSessions: [], participants: [], ...m }]));
  const calls = [];
  let created = 0;

  const meetingManager = {
    createMeeting(opts) {
      created += 1;
      const meeting = { id: `fork-${created}`, groupChat: true, subSessions: [], participants: [], ...opts };
      meetingsById.set(meeting.id, meeting);
      calls.push(['createMeeting', meeting.id, opts]);
      return { ...meeting };
    },
    getMeeting(id) {
      const meeting = meetingsById.get(id);
      return meeting ? JSON.parse(JSON.stringify(meeting)) : null;
    },
    getAllMeetings() { return [...meetingsById.values()].map(m => ({ ...m })); },
    closeMeeting(id) {
      const meeting = meetingsById.get(id);
      meetingsById.delete(id);
      calls.push(['closeMeeting', id]);
      return meeting ? [...meeting.subSessions] : [];
    },
    setParticipants(id, participants) {
      calls.push(['setParticipants', id, participants]);
      const meeting = meetingsById.get(id);
      if (meeting) meeting.participants = participants;
    },
    updateMeeting(id, fields) {
      calls.push(['updateMeeting', id, fields]);
      const meeting = meetingsById.get(id);
      if (meeting) Object.assign(meeting, fields);
      return meeting ? { ...meeting } : null;
    },
  };

  // 真实的 addMeetingSubInternal 会把成员登记进 meetingManager —— 回滚正是靠这份登记
  // 才能把已经建好的会话收回来，所以替身也必须登记。
  const addMeetingSubInternal = async (meetingId, kind, opts) => {
    calls.push(['addMeetingSub', meetingId, kind, opts]);
    const nth = calls.filter(c => c[0] === 'addMeetingSub').length;
    if (failAddOnCall === nth) throw new Error('CLI 启动失败');
    const session = { id: `new-${nth}`, kind, title: opts.title, opts };
    sessionsById.set(session.id, session);
    const meeting = meetingsById.get(meetingId);
    if (meeting) meeting.subSessions = [...meeting.subSessions, session.id];
    return { session, meeting: meeting ? { ...meeting } : null };
  };

  registerGroupChatForkIpc(ipc, {
    addMeetingSubInternal,
    getHubDataDir: () => tmp,
    getPersistedSessions: () => [],
    groupchat,
    logger: { warn() {} },
    meetingManager,
    sendToRenderer: (channel, payload) => calls.push(['send', channel, payload && payload.meeting && payload.meeting.id]),
    sessionManager: {
      getAllSessions: () => [...sessionsById.values()],
      getSession: (id) => sessionsById.get(id) || null,
      closeSession: (id) => { calls.push(['closeSession', id]); sessionsById.delete(id); },
    },
    sessionStore: { deleteSessionFile() {}, cancelDirty() {} },
    stateStore: { save() {}, markRemovedSession() {}, markRemovedMeeting() {} },
  });
  return {
    calls,
    meetingManager,
    invoke: (channel, payload) => ipc.handlers.get(channel)(null, payload),
  };
}

console.log('Running group chat fork IPC tests...');

test('加入群聊：分支参数原样传给成员创建（模型 / effort / MCP 档位 / fast）', async () => {
  const h = harness({
    sessions: [claudeSession('src-1')],
    meetings: [{ id: 'm-1', groupChat: true, title: '研究群', subSessions: ['other'] }],
  });
  const result = await h.invoke('groupchat:add-existing-session', { meetingId: 'm-1', sessionId: 'src-1' });
  assert.strictEqual(result.ok, true, result.message);
  const [, , kind, opts] = h.calls.find(c => c[0] === 'addMeetingSub');
  assert.strictEqual(kind, 'claude');
  assert.strictEqual(opts.forkCCSessionId, CLAUDE_NATIVE_ID, '必须按原生会话 ID 分支');
  assert.strictEqual(opts.branchSourceSessionId, 'src-1');
  assert.strictEqual(opts.model, 'opus');
  assert.strictEqual(opts.effort, 'high');
  assert.strictEqual(opts.mcpProfile, 'lean');
  assert.strictEqual(opts.fastMode, false);
  assert.strictEqual(opts.cwd, 'C:\\work\\proj', 'Claude 分支必须留在原工作目录，否则找不到原生会话');
});

test('加入群聊：没有原生会话 ID 的会话被拒绝，并说清楚为什么', async () => {
  const h = harness({
    sessions: [claudeSession('src-1', { ccSessionId: null })],
    meetings: [{ id: 'm-1', groupChat: true, title: '研究群' }],
  });
  const result = await h.invoke('groupchat:add-existing-session', { meetingId: 'm-1', sessionId: 'src-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'native-session-id-missing');
  assert.match(result.message, /原生会话 ID/);
  assert.ok(!h.calls.some(c => c[0] === 'addMeetingSub'), '拒绝时不能留下半个成员');
});

test('加入群聊：已经是成员就不再重复加', async () => {
  const h = harness({
    sessions: [claudeSession('src-1')],
    meetings: [{ id: 'm-1', groupChat: true, subSessions: ['src-1'] }],
  });
  const result = await h.invoke('groupchat:add-existing-session', { meetingId: 'm-1', sessionId: 'src-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'already-member');
});

test('可分支清单排除本群成员和没有原生 ID 的会话', async () => {
  const h = harness({
    sessions: [
      claudeSession('src-1'),
      claudeSession('src-2', { ccSessionId: null }),
      claudeSession('in-room'),
      { id: 'sh-1', kind: 'powershell', title: 'shell' },
    ],
    meetings: [{ id: 'm-1', groupChat: true, subSessions: ['in-room'] }],
  });
  const rows = await h.invoke('groupchat:forkable-sessions', { meetingId: 'm-1' });
  assert.deepStrictEqual(rows.map(r => r.id), ['src-1']);
});

test('从会话建群：两个会话各分支一份，群聊沿用共同的工作目录', async () => {
  const h = harness({ sessions: [claudeSession('src-1'), codexSession('src-2')] });
  const result = await h.invoke('groupchat:create-from-sessions', { sessionIds: ['src-1', 'src-2'], title: '三方会诊' });
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.sessions.length, 2);
  const created = h.calls.find(c => c[0] === 'createMeeting');
  assert.strictEqual(created[2].title, '三方会诊');
  assert.strictEqual(created[2].workspace, 'C:\\work\\proj');
  const adds = h.calls.filter(c => c[0] === 'addMeetingSub');
  assert.deepStrictEqual(adds.map(c => c[2]), ['claude', 'codex']);
  assert.strictEqual(adds[1][3].codexForkSid, CODEX_NATIVE_ID);
  assert.ok(h.calls.some(c => c[0] === 'send' && c[1] === 'meeting-created'));
});

test('从会话建群：任一会话分支失败就整体回滚，不留半个群聊', async () => {
  const h = harness({ sessions: [claudeSession('src-1'), codexSession('src-2')], failAddOnCall: 2 });
  const result = await h.invoke('groupchat:create-from-sessions', { sessionIds: ['src-1', 'src-2'] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /CLI 启动失败/);
  assert.ok(h.calls.some(c => c[0] === 'closeMeeting'), '失败必须把新建的群聊删掉');
  assert.ok(h.calls.some(c => c[0] === 'closeSession' && c[1] === 'new-1'), '已建好的成员也要收回');
  assert.strictEqual(h.meetingManager.getAllMeetings().length, 0);
});

test('整群分支：成员逐个分支，记录带 sid 映射搬过去', async () => {
  const meetingId = 'm-src';
  const orch = groupchat.getOrchestrator(tmp, meetingId);
  const begin = orch.beginTurn('讨论一下架构');
  orch.ensureMemberIdentity('src-1', 'm1');
  orch.ensureMemberIdentity('src-2', 'm2');
  orch.completeTurn(begin.turnNum, '讨论一下架构', [
    { sid: 'src-1', status: 'completed', text: '甲的看法' },
    { sid: 'src-2', status: 'completed', text: '乙的看法' },
  ], {
    'src-1': { sid: 'src-1', memberId: 'm1', displayName: 'Alpha' },
    'src-2': { sid: 'src-2', memberId: 'm2', displayName: 'Beta' },
  });

  const h = harness({
    sessions: [claudeSession('src-1'), codexSession('src-2')],
    meetings: [{
      id: meetingId, groupChat: true, title: '架构群', scene: 'general',
      subSessions: ['src-1', 'src-2'], participants: [0, 1],
      slotSpecs: [{ memberId: 'm1', kind: 'claude' }, { memberId: 'm2', kind: 'codex' }],
      workspace: 'C:\\work\\proj', covenantText: '约定：先给结论',
    }],
  });

  const result = await h.invoke('groupchat:fork-meeting', { meetingId });
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.meeting.title, '架构群（分支1）');
  assert.deepStrictEqual(Object.keys(result.sidMap).sort(), ['src-1', 'src-2']);

  const forkedOrch = groupchat.getOrchestrator(tmp, result.meeting.id);
  const state = forkedOrch.getState();
  assert.ok(state.messages.some(m => m.content === '甲的看法' && m.sid === result.sidMap['src-1']),
    '历史发言必须改挂到新成员身上');
  assert.strictEqual(state.forkedFrom.meetingId, meetingId);
  assert.ok(state.messages.some(m => m.systemNote && /分支自/.test(m.content)), '要留一条可见的分支说明');
  assert.deepStrictEqual(h.calls.filter(c => c[0] === 'setParticipants').pop()[2], [0, 1]);
  assert.ok(h.calls.some(c => c[0] === 'updateMeeting' && c[2].covenantText === '约定：先给结论'));
  // 分支后的成员不会被重灌历史（游标一起继承了）
  forkedOrch.beginTurn('分支后的新问题');
  const prompt = forkedOrch.buildFirstDelta(result.sidMap['src-1'], '分支后的新问题', '## 规则');
  assert.ok(!prompt.includes('乙的看法'));
});

test('整群分支：进行中的轮次拒绝分支', async () => {
  const meetingId = 'm-busy';
  const orch = groupchat.getOrchestrator(tmp, meetingId);
  orch.beginTurn('正在问'); // currentMode 变成 group
  const h = harness({
    sessions: [claudeSession('src-1')],
    meetings: [{ id: meetingId, groupChat: true, title: '忙碌群', subSessions: ['src-1'] }],
  });
  const result = await h.invoke('groupchat:fork-meeting', { meetingId });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'turn-in-progress');
  assert.ok(!h.calls.some(c => c[0] === 'createMeeting'), '拒绝时不能先建出一个空群聊');
});

test('整群分支：开发群聊明确拒绝，并说明原因', async () => {
  const h = harness({
    sessions: [claudeSession('src-1')],
    meetings: [{ id: 'm-dev', groupChat: true, title: '开发群', scene: 'dev', mode: 'dev', subSessions: ['src-1'] }],
  });
  const result = await h.invoke('groupchat:fork-meeting', { meetingId: 'm-dev' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'dev-meeting-unsupported');
  assert.match(result.message, /工作目录/);
});

test('整群分支：发过言却没有原生 ID 的成员必须拦下来（否则历史会凭空少一个人）', async () => {
  const meetingId = 'm-broken';
  const orch = groupchat.getOrchestrator(tmp, meetingId);
  const begin = orch.beginTurn('问题');
  orch.completeTurn(begin.turnNum, '问题', [{ sid: 'src-1', status: 'completed', text: '说过话' }],
    { 'src-1': { sid: 'src-1', memberId: 'm1', displayName: 'Alpha' } });
  const h = harness({
    sessions: [claudeSession('src-1', { ccSessionId: null })],
    meetings: [{ id: meetingId, groupChat: true, title: '坏群', subSessions: ['src-1'] }],
  });
  const result = await h.invoke('groupchat:fork-meeting', { meetingId });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /成员「/);
  assert.ok(!h.calls.some(c => c[0] === 'createMeeting'));
});

test('整群分支：从没发过言的席位直接按同配置新建，不算失败', async () => {
  const meetingId = 'm-silent';
  const h = harness({
    sessions: [codexSession('src-1'), claudeSession('src-2', { ccSessionId: null, title: '待命席位' })],
    meetings: [{
      id: meetingId, groupChat: true, title: '安静群', subSessions: ['src-1', 'src-2'],
      slotSpecs: [{ memberId: 'm1', kind: 'codex' }, { memberId: 'm2', kind: 'claude' }],
    }],
  });
  const result = await h.invoke('groupchat:fork-meeting', { meetingId });
  assert.strictEqual(result.ok, true, result.message);
  const adds = h.calls.filter(c => c[0] === 'addMeetingSub');
  assert.strictEqual(adds.length, 2);
  assert.strictEqual(adds[0][3].codexForkSid, CODEX_NATIVE_ID, '发过言的成员走分支');
  assert.strictEqual(adds[1][3].forkCCSessionId, undefined, '没发过言的席位没有可继承的上下文');
  assert.strictEqual(adds[1][3].title, '待命席位');
});

Promise.all(pending).then(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
});
