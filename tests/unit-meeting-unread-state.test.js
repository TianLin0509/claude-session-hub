'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getMeetingUnreadMemberIds, recordMeetingAnswer, preserveMeetingAttention, readMeetingMember } = require('../renderer/meeting-unread');
const { partitionSidebarSessions } = require('../renderer/session-list-renderer');
const group = () => ({ id: 'g', groupChat: true, subSessions: ['a', 'b'] });
const answer = (sid, turnNum, extra = {}) => ({ sid, turnNum, runId: 'run1', status: 'completed', ...extra });

test('unread survives new turns; round progress resets independently', () => {
  const m = group();
  recordMeetingAnswer(m, answer('a', 1));
  recordMeetingAnswer(m, answer('b', 2));
  assert.deepEqual([...getMeetingUnreadMemberIds(m)], ['a', 'b']);
  assert.deepEqual([...m.answeredThisTurn], ['b']);
});
test('only explicitly read member clears; needs-input and progress remain', () => {
  const m = group(), a = { id: 'a', attentionState: 'needs-input', unreadCount: 1 };
  const sessions = new Map([['a', a]]);
  recordMeetingAnswer(m, answer('a', 1)); recordMeetingAnswer(m, answer('b', 1));
  assert.equal(readMeetingMember(m, 'a', sessions).changed, true);
  assert.deepEqual([...getMeetingUnreadMemberIds(m, sessions)], ['b']);
  assert.equal(a.attentionState, 'needs-input');
  assert.equal(m.answeredThisTurn.size, 2);
  recordMeetingAnswer(m, answer('a', 1));
  assert.deepEqual([...getMeetingUnreadMemberIds(m, sessions)], ['b'], 'duplicate completion must not replay read attention');
  recordMeetingAnswer(m, answer('a', 1, { attemptId: 'retry2' }));
  assert.equal(getMeetingUnreadMemberIds(m, sessions).size, 2);
});
test('union counts members once and ignores removed members', () => {
  const m = { ...group(), unreadAnswered: new Set(['a', 'removed']) };
  const sessions = new Map([['a', {unreadCount: 3}], ['b', {attentionState: 'reply-ready'}]]);
  assert.deepEqual([...getMeetingUnreadMemberIds(m, sessions)], ['a', 'b']);
});
test('metadata replacement preserves unread and completion dedup, prunes removed members', () => {
  const m = group(); recordMeetingAnswer(m, answer('a', 1)); recordMeetingAnswer(m, answer('b', 1));
  const next = { ...group(), subSessions: ['b'] }; preserveMeetingAttention(m, next);
  assert.deepEqual([...getMeetingUnreadMemberIds(next)], ['b']);
  readMeetingMember(next, 'b'); recordMeetingAnswer(next, answer('b', 1));
  assert.equal(getMeetingUnreadMemberIds(next).size, 0);
});
test('selected or pinned groups still enter unread; read groups return to pinned', () => {
  const m = group(); recordMeetingAnswer(m, answer('a', 1));
  const item = { id: 'g', _isMeeting: true, _meeting: m, pinned: true };
  const sections = () => partitionSidebarSessions([item], { activeMeetingId: 'g' });
  assert.deepEqual(sections().unread.map(x => x.id), ['g']);
  assert.equal(sections().pinned.length, 0);
  readMeetingMember(m, 'a');
  assert.deepEqual(sections().pinned.map(x => x.id), ['g']);
});
test('only final answers from current members create attention', () => {
  const m = group();
  for (const status of ['streaming', 'thinking', 'errored', 'timeout']) recordMeetingAnswer(m, answer('a', 1, {status}));
  recordMeetingAnswer(m, answer('removed', 1));
  assert.equal(getMeetingUnreadMemberIds(m).size, 0);
  recordMeetingAnswer(m, answer('a', 1), { seenByUser: true });
  assert.equal(getMeetingUnreadMemberIds(m).size, 0);
  assert.equal(m.answeredThisTurn.size, 1);
  recordMeetingAnswer(m, answer('b', 1, {status: 'manual_extracted'}));
  assert.deepEqual([...getMeetingUnreadMemberIds(m)], ['b']);
});

test('reading a stale bubble cannot acknowledge a newer answer', () => {
  const m = group(); recordMeetingAnswer(m, answer('a', 2));
  assert.equal(readMeetingMember(m, 'a', new Map(), {turnNum: 1}).changed, false);
  assert.equal(getMeetingUnreadMemberIds(m).size, 1);
  assert.equal(readMeetingMember(m, 'a', new Map(), {turnNum: 2}).changed, true);
});
