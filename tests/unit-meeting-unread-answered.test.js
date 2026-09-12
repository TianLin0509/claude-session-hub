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
test('selectMeeting no longer acknowledges all members; renderer preserves local attention on updates', () => {
  const start = source.indexOf('async function selectMeeting(');
  const body = source.slice(start, source.indexOf('paintSidebarActiveTarget', start));
  assert.doesNotMatch(body, /clearSessionCompletedUnread|unreadAnswered.*clear/);
  assert.match(source, /meetingUnread\.preserveMeetingAttention\(previous, meeting\)/);
});
