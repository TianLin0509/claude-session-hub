'use strict';
// persist-sessions on Main (2026-10-11): the shallow "same field values" fast
// path must agree with the deep comparison it short-circuits, and membership
// repair must see the same rooms without cloning every meeting.

const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { persistentEntityEquals } = require('../main/ipc/persistence-handlers.js');
const { MeetingRoomManager } = require('../core/meeting-room.js');

function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { console.error(`  FAIL ${name}`); console.error(err.stack || err.message); process.exitCode = 1; }
}

const deep = (a, b) => {
  const strip = ({ updatedAt, savedAt, ...rest }) => rest;
  return isDeepStrictEqual(strip(a), strip(b));
};

test('agrees with the deep comparison on copies, edits and volatile stamps', () => {
  const usage = { total: 5 };
  const base = { hubId: 'a', title: 'T', sessionUsage: usage, recentArtifacts: [], n: NaN, z: 0, updatedAt: 1 };
  const cases = [
    { ...base },
    { ...base, updatedAt: 99, savedAt: 3 },
    { ...base, title: 'changed' },
    { ...base, sessionUsage: { total: 5 } },     // equal content, new object: deep path
    { ...base, sessionUsage: { total: 6 } },
    { ...base, recentArtifacts: ['x'] },
    { ...base, z: -0 },                          // Object.is differs; deep path decides
    { ...base, extra: undefined },
    (() => { const { title, ...rest } = base; return rest; })(),
    Object.assign(Object.create(null), base),
  ];
  for (const candidate of cases) {
    assert.equal(persistentEntityEquals(candidate, base), deep(candidate, base), JSON.stringify(Object.keys(candidate)));
    assert.equal(persistentEntityEquals(base, candidate), deep(base, candidate));
  }
  assert.equal(persistentEntityEquals(null, null), true);
  assert.equal(persistentEntityEquals(base, null), false);
});

test('membership view matches getAllMeetings for repair purposes', () => {
  const manager = new MeetingRoomManager();
  manager.meetings.set('m1', { id: 'm1', subSessions: ['a', 'b'], _timeline: [], _cursors: {} });
  manager.meetings.set('m2', { id: 'm2', subSessions: ['b', 'c'], _timeline: [], _cursors: {} });
  const view = manager.getMeetingMemberships();
  assert.deepEqual(view, manager.getAllMeetings().map(m => ({ id: m.id, subSessions: m.subSessions })));
  const { restoreMissingMeetingIds } = require('../core/session-meeting-membership.js');
  const viaView = [{ hubId: 'a' }, { hubId: 'b' }, { hubId: 'c' }];
  const viaAll = viaView.map(s => ({ ...s }));
  assert.deepEqual(restoreMissingMeetingIds(viaView, view), restoreMissingMeetingIds(viaAll, manager.getAllMeetings()));
  assert.deepEqual(viaView, viaAll);
});
