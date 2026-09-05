'use strict';

const assert = require('node:assert');
const {
  acceptGroupChatEvent,
  getGroupChatRevision,
  noteGroupChatSnapshot,
  resetGroupChatRevision,
} = require('../renderer/groupchat-event-revision.js');

resetGroupChatRevision();
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'm', turnNum: 1, runId: 'r1', revision: 10 }).accepted, true);
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'm', turnNum: 1, runId: 'r1', revision: 9 }).reason, 'stale_revision');
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'm', turnNum: 0, runId: 'r0', revision: 11 }).reason, 'stale_turn');
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'm', turnNum: 1, runId: 'other', revision: 12 }).reason, 'run_mismatch');
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'm', turnNum: 2, runId: 'r2', revision: 13 }, { allowRunReplacement: true }).accepted, true);
assert.deepStrictEqual(getGroupChatRevision('m'), { revision: 13, turnNum: 2, runId: 'r2' });

resetGroupChatRevision('snapshot');
assert.strictEqual(noteGroupChatSnapshot('snapshot', { revision: 3, currentTurn: 8, activeRun: { runId: 'rs' } }).accepted, true);
assert.strictEqual(noteGroupChatSnapshot('snapshot', { revision: 3, currentTurn: 8, activeRun: { runId: 'rs' } }).accepted, true,
  'a full snapshot at the same revision may enrich a prior lightweight push');
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'snapshot', revision: 2, turnNum: 8, runId: 'rs' }).accepted, false);

resetGroupChatRevision('shared');
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'shared', turnNum: 1, runId: 'r', revision: 1 }, { consumer: 'room' }).accepted, true);
assert.strictEqual(acceptGroupChatEvent({ meetingId: 'shared', turnNum: 1, runId: 'r', revision: 1 }, { consumer: 'sidebar' }).accepted, true,
  'two renderer consumers must independently accept the same event');

console.log('groupchat event revision: ok');
