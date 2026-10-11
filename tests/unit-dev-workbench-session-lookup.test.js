'use strict';
// session-updated -> development board (2026-10-11): finding the rooms that
// contain a session must not clone every meeting's workflow (~2 ms per event on
// a 220-room production state). Same rooms, same order, same board push.

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MeetingRoomManager } = require('../core/meeting-room');
const { createDevWorkbench } = require('../main/groupchat/dev-workbench');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-workbench-lookup-'));
const make = (id, subSessions, extra = {}) => ({ id, title: '任务 ' + id, scene: 'dev', groupChat: true, workspace: directory,
  subSessions, serialWorkflow: { enabled: true, steps: [['m1']], loop: { enabled: false }, loopState: { runId: 'r-' + id, status: 'paused', history: [] } }, ...extra });

async function main() {
  const manager = new MeetingRoomManager();
  manager.meetings.set('a', make('a', ['s1', 's2']));
  manager.meetings.set('b', make('b', ['s3']));
  manager.meetings.set('c', make('c', ['s2']));
  manager.meetings.set('broken', { ...make('broken', null), subSessions: 'not-an-array' });
  manager.meetings.set('null', null);

  // Equivalent to the old filter over getDevWorkbenchRecords().
  for (const sid of ['s1', 's2', 's3', 'missing']) {
    const legacy = manager.getDevWorkbenchRecords().filter(m => m.subSessions?.includes(sid)).map(m => m.id);
    assert.deepEqual(manager.getMeetingIdsForSession(sid), legacy, sid);
  }

  let recordsCalls = 0;
  const original = manager.getDevWorkbenchRecords.bind(manager);
  manager.getDevWorkbenchRecords = () => { recordsCalls++; return original(); };
  const events = [];
  const board = createDevWorkbench({ meetingManager: manager, loopEngine: { getStatus: () => ({ running: false }) }, getHubDataDir: () => directory,
    sendToRenderer: (channel, data) => events.push({ channel, data }), readSummary: async () => ({ missing: true }), logger: { warn() {} } });
  try {
    const before = recordsCalls;
    board.handleEvent('session-updated', { session: { id: 's2' } });
    assert.equal(recordsCalls, before, 'session-updated must not snapshot every meeting');
    board.flush();
    const push = events.filter(e => e.channel === 'dev-workbench:changed').at(-1);
    assert.ok(push, 'the board is told about the affected rooms');
    assert.deepEqual(push.data.rows.map(r => r.id).sort(), ['a', 'c']);
  } finally {
    board.dispose();
  }
  console.log('  OK session-updated finds member rooms without cloning workflows');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
