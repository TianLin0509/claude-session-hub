'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingMemberTitlePatch, createMeetingMemberTitleSync } = require('../core/meeting-member-titles');
const { sessionDisplayTitle, migrateLegacyBranchSessionMeta } = require('../core/session-title-guards');
const { ALL_AI_KINDS, KIND_LABELS } = require('../core/ai-kinds');

test('all member kinds inherit the group topic with their own model prefix', () => {
  const meeting = { id: 'g', title: '验证调度方案' };
  for (const kind of ALL_AI_KINDS) {
    const member = { id: kind, kind: kind + '-resume', meetingId: 'g', title: '默认名' };
    const patch = meetingMemberTitlePatch(member, meeting);
    assert.equal(patch.title, `${KIND_LABELS[kind]} · 验证调度方案`);
    const named = { ...member, ...patch };
    assert.equal(sessionDisplayTitle(named), patch.title);
    assert.equal(migrateLegacyBranchSessionMeta(named).title, patch.title);
    assert.equal(meetingMemberTitlePatch(named, meeting), null);
  }
  assert.equal(meetingMemberTitlePatch({ kind: 'codex', meetingId: 'g', currentModel: { id: 'gpt-6-astra', displayName: 'GPT-6 Astra' } }, meeting).title,
    'GPT-6 Astra · 验证调度方案');
});

test('manual member titles and standalone sessions are protected', () => {
  const meeting = { id: 'g', title: '讨论方案' };
  assert.equal(meetingMemberTitlePatch({ meetingId: 'g', userRenamed: true, title: '我的审稿员' }, meeting), null);
  assert.equal(meetingMemberTitlePatch({ kind: 'claude' }, meeting), null);
  assert.equal(meetingMemberTitlePatch({ meetingId: 'other' }, meeting), null);
});

test('dormant display does not mutate history and status-only group updates do not write members', () => {
  const member = { id: 'a', kind: 'codex', meetingId: 'g', title: 'Codex 1', status: 'dormant' };
  const meeting = { id: 'g', title: '群聊任务', subSessions: ['a'] };
  assert.equal(sessionDisplayTitle(member, KIND_LABELS, meeting), 'Codex · 群聊任务');
  assert.equal(member.title, 'Codex 1');
  let writes = 0;
  const sync = createMeetingMemberTitleSync({ getMeeting: () => meeting, readSession: () => member,
    writeSession: () => { writes++; }, publish: () => {} });
  sync.rememberMeeting(meeting);
  sync.onEvent('meeting-updated', { meeting: { ...meeting, status: 'idle', lastMessageTime: 123 } });
  assert.equal(writes, 0);
});

test('group rename, newly added/model-switched members and dormant records use one sync path without recursion', () => {
  const meeting = { id: 'g', title: '旧群名', subSessions: ['a', 'b', 'manual'] };
  const rows = new Map([
    ['a', { id: 'a', kind: 'claude', meetingId: 'g' }],
    ['b', { hubId: 'b', kind: 'codex', status: 'dormant', meetingId: 'g' }],
    ['manual', { id: 'manual', kind: 'kimi', meetingId: 'g', title: '手动标题', userRenamed: true }],
  ]);
  const events = [], writes = [];
  let sync;
  sync = createMeetingMemberTitleSync({
    getMeeting: id => id === 'g' ? meeting : null,
    readSession: id => rows.get(id),
    writeSession: (id, patch) => {
      writes.push(id);
      const next = { ...rows.get(id), ...patch };
      rows.set(id, next);
      // Mirrors SessionManager.updateSessionMeta's synchronous event.
      sync.onEvent('session-updated', { session: next });
      return next;
    },
    publish: (channel, data) => events.push({ channel, data }),
  });
  sync.onEvent('meeting-updated', { meeting });
  assert.deepEqual(writes, ['a', 'b']);
  assert.equal(rows.get('b').title, 'Codex · 旧群名');
  meeting.title = '新群名';
  sync.onEvent('meeting-updated', { meeting });
  assert.equal(rows.get('a').title, 'Claude · 新群名');
  const member = { ...rows.get('a'), currentModel: { id: 'haiku', displayName: 'Haiku' } };
  rows.set('a', member);
  assert.equal(sync.onEvent('session-updated', { session: member }).session.title, 'Haiku · 新群名');
  rows.set('new', { id: 'new', kind: 'gemini', meetingId: 'g' });
  assert.equal(sync.onEvent('session-created', { session: rows.get('new') }).session.title, 'Antigravity · 新群名');
  assert.equal(rows.get('manual').title, '手动标题');
  assert.equal(events.length, 4);
});
