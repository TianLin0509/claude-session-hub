'use strict';
// Exercise the real renderer IPC handler with isolated window/session inputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const meetingUnread = require('../renderer/meeting-unread');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function fixture(extra = {}) {
  const start = source.indexOf("ipcRenderer.on('groupchat-partial-update'");
  const end = source.indexOf('ipcRenderer.on(', start + 1);
  let handler;
  const meeting = { id: 'g', subSessions: ['a', 'b'], groupChat: true };
  const context = { ipcRenderer: { on: (_, fn) => { handler = fn; } }, meetingUnread,
    meetings: { g: meeting }, sessions: new Map(), activeSessionId: null, activeMeetingId: 'g', currentView: 'card',
    document: { hasFocus: () => false, hidden: false, getElementById: () => null },
    _acceptSidebarGroupChatEvent: () => true, _setGroupChatMemberWorking: () => false,
    scheduleSessionListRender: () => {}, ...extra };
  vm.runInNewContext(source.slice(start, end), context);
  const send = (sid, turnNum, status = 'completed') => handler(null, { meetingId: 'g', runId: 'r', sid, turnNum, status });
  return { meeting, send };
}
test('selected room in a background window still receives unread answers across rounds', () => {
  const f = fixture(); f.send('a', 1); f.send('b', 2);
  assert.deepEqual([...f.meeting.unreadAnswered], ['a', 'b']);
  assert.deepEqual([...f.meeting.answeredThisTurn], ['b']);
});
test('streaming/errors do not create completed unread attention', () => {
  const f = fixture(); f.send('a', 1, 'streaming'); f.send('a', 1, 'errored');
  assert.equal(meetingUnread.getMeetingUnreadMemberIds(f.meeting).size, 0);
});
test('only the foreground member latest view suppresses new attention', () => {
  const f = fixture({ activeSessionId: 'a', currentView: 'pty', document: { hasFocus: () => true, hidden: false, getElementById: () => null } });
  f.send('a', 1); f.send('b', 1);
  assert.deepEqual([...f.meeting.unreadAnswered], ['b']);
});
test('selectMeeting acknowledges all current members; metadata updates still preserve local attention', () => {
  const start = source.indexOf('async function selectMeeting(');
  const body = source.slice(start, source.indexOf('paintSidebarActiveTarget', start));
  assert.match(body, /markMeetingRead\(meetingId\)/);
  assert.match(source, /meetingUnread\.preserveMeetingAttention\(previous, meeting\)/);
});

test('reading a room clears all completed unread, preserves input requests and completion deduplication', () => {
  const sessions = new Map([
    ['a', { unreadCount: 2, replyReady: true, attentionState: 'reply-ready' }],
    ['b', { unreadCount: 1, needsUserInput: true, attentionState: 'needs-input' }],
    ['other', { unreadCount: 3, replyReady: true }],
  ]);
  const meeting = { subSessions: ['a', 'b'], unreadCount: 9 };
  const completion = { sid: 'a', status: 'completed', turnNum: 1, runId: 'r' };
  meetingUnread.recordMeetingAnswer(meeting, completion);
  const result = meetingUnread.readMeeting(meeting, sessions);
  assert.equal(result.changed, true);
  assert.deepEqual(result.sessionIds, ['a', 'b']);
  assert.equal(meetingUnread.getMeetingUnreadMemberIds(meeting, sessions).size, 0);
  assert.equal(meeting.unreadCount, 0);
  assert.equal(sessions.get('b').needsUserInput, true);
  assert.equal(sessions.get('other').unreadCount, 3);
  assert.equal(meetingUnread.recordMeetingAnswer(meeting, completion), false);
  assert.equal(meeting.unreadAnswered.size, 0);
  assert.equal(meetingUnread.readMeeting(meeting, sessions).changed, false);
  meetingUnread.recordMeetingAnswer(meeting, { ...completion, turnNum: 2 });
  assert.deepEqual([...meeting.unreadAnswered], ['a']);
});
