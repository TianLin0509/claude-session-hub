'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../core/session-manager');
const { restoreMissingMeetingIds } = require('../core/session-meeting-membership');

test('native public session retains the group ownership used by persistence and sidebar', () => {
  const result = SessionManager.prototype._toPublic({ id: 'member', kind: 'codex', meetingId: 'group', runtimeBackend: 'codex-app-server' });
  assert.equal(result.meetingId, 'group');
  assert.equal(SessionManager.prototype._toPublic({ id: 'ordinary', kind: 'codex' }).meetingId, null);
});

test('old missing ownership is repaired only by a unique exact Hub member id', () => {
  const sessions = [{ hubId: 'member', title: 'Codex 1' }, { hubId: 'unrelated', title: 'Codex 1' },
    { hubId: 'ambiguous' }, { hubId: 'owned', meetingId: 'original' }];
  const meetings = [{ id: 'one', subSessions: ['member', 'ambiguous', 'owned'] }, { id: 'two', subSessions: ['ambiguous'] }];
  assert.deepEqual(restoreMissingMeetingIds(sessions, meetings), ['member']);
  assert.equal(sessions[0].meetingId, 'one');
  assert.equal(sessions[1].meetingId, undefined);
  assert.equal(sessions[2].meetingId, undefined);
  assert.equal(sessions[3].meetingId, 'original');
  assert.deepEqual(restoreMissingMeetingIds(sessions, meetings), []);
});
