'use strict';

const assert = require('assert');
const { registerMeetingTimelineIpc } = require('../main/ipc/meeting-timeline-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function createMeetingManager() {
  const calls = [];
  const turns = [{ role: 'user', text: 'existing', ts: 1 }];
  return {
    calls,
    appendTurn(meetingId, role, text, ts) {
      calls.push(['appendTurn', meetingId, role, text, typeof ts]);
      return { meetingId, role, text, ts };
    },
    loadTimelineLazy(meetingId) {
      calls.push(['loadTimelineLazy', meetingId]);
      return meetingId === 'meet-1';
    },
    getTimeline(meetingId) {
      calls.push(['getTimeline', meetingId]);
      return meetingId === 'meet-1' ? turns : [];
    },
    getCursor(meetingId, targetSid) {
      calls.push(['getCursor', meetingId, targetSid]);
      return targetSid === 'sid-known' ? 0 : null;
    },
    incrementalContext(meetingId, targetSid) {
      calls.push(['incrementalContext', meetingId, targetSid]);
      return { turns, advancedTo: 1 };
    },
    getAllMeetings() {
      calls.push(['getAllMeetings']);
      return [{ id: 'meet-1' }];
    },
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running meeting timeline IPC contract tests...');

test('registers expected timeline channels', () => {
  const ipc = createFakeIpc();
  registerMeetingTimelineIpc(ipc, { meetingManager: createMeetingManager(), sendToRenderer: () => {} });

  for (const channel of [
    'meeting-append-user-turn',
    'meeting-get-timeline',
    'meeting-incremental-context',
    'get-dormant-meetings',
    'meeting-load-timeline',
  ]) {
    assert.ok(ipc.handlers.has(channel), `${channel} should be registered`);
  }
});

test('append user turn emits timeline update and rejects invalid text', () => {
  const ipc = createFakeIpc();
  const meetingManager = createMeetingManager();
  const emitted = [];
  registerMeetingTimelineIpc(ipc, {
    meetingManager,
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
  });

  assert.strictEqual(ipc.handlers.get('meeting-append-user-turn')(null, { meetingId: 'meet-1', text: '' }), null);
  const turn = ipc.handlers.get('meeting-append-user-turn')(null, { meetingId: 'meet-1', text: 'hello' });

  assert.strictEqual(turn.role, 'user');
  assert.strictEqual(turn.text, 'hello');
  assert.strictEqual(emitted[0][0], 'meeting-timeline-updated');
  assert.strictEqual(emitted[0][1].meetingId, 'meet-1');
});

test('timeline read and load delegate through lazy loader', () => {
  const ipc = createFakeIpc();
  const meetingManager = createMeetingManager();
  registerMeetingTimelineIpc(ipc, { meetingManager, sendToRenderer: () => {} });

  const timeline = ipc.handlers.get('meeting-get-timeline')(null, 'meet-1');
  const loaded = ipc.handlers.get('meeting-load-timeline')(null, 'meet-1');
  const missing = ipc.handlers.get('meeting-load-timeline')(null, 'missing');

  assert.strictEqual(timeline.length, 1);
  assert.deepStrictEqual(loaded, { ok: true, timeline });
  assert.deepStrictEqual(missing, { ok: false, reason: 'no persisted timeline (or meeting unknown)' });
  assert.ok(meetingManager.calls.some(call => call[0] === 'loadTimelineLazy' && call[1] === 'meet-1'));
});

test('incremental context warns on unregistered target and still delegates', () => {
  const ipc = createFakeIpc();
  const meetingManager = createMeetingManager();
  const warns = [];
  registerMeetingTimelineIpc(ipc, {
    logger: { warn: (msg) => warns.push(msg) },
    meetingManager,
    sendToRenderer: () => {},
  });

  assert.deepStrictEqual(ipc.handlers.get('meeting-incremental-context')(null, {}), { turns: [], advancedTo: 0 });
  const result = ipc.handlers.get('meeting-incremental-context')(null, { meetingId: 'meet-1', targetSid: 'sid-missing' });

  assert.strictEqual(result.advancedTo, 1);
  assert.strictEqual(warns.length, 1);
  assert.ok(warns[0].includes('sid-missing'));
});

test('get-dormant-meetings returns current meeting list', () => {
  const ipc = createFakeIpc();
  registerMeetingTimelineIpc(ipc, { meetingManager: createMeetingManager(), sendToRenderer: () => {} });

  assert.deepStrictEqual(ipc.handlers.get('get-dormant-meetings')(), [{ id: 'meet-1' }]);
});

console.log('All meeting timeline IPC contract tests passed.');
