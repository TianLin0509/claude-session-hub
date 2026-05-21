'use strict';

const assert = require('assert');
const { registerMeetingIpc, switchScene, withUserRenameFields, isValidMeetingId } = require('../main/ipc/meeting-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
    on(channel, fn) {
      this.listeners.set(channel, fn);
    },
  };
}

function createFakeMeetingManager() {
  const meeting = {
    id: 'meet-1',
    title: 'Old',
    groupChat: true,
    subSessions: ['s1', 's2', 's3'],
    participants: [0, 1, 2],
    scene: 'general',
    covenantText: 'old covenant',
  };
  const calls = [];
  return {
    calls,
    getMeeting(id) {
      calls.push(['getMeeting', id]);
      return id === meeting.id ? { ...meeting } : null;
    },
    updateMeeting(id, fields) {
      calls.push(['updateMeeting', id, fields]);
      if (id !== meeting.id) return null;
      Object.assign(meeting, fields);
      return { ...meeting };
    },
    setParticipants(id, participants) {
      calls.push(['setParticipants', id, participants]);
      if (id === meeting.id) meeting.participants = participants;
    },
    getAllMeetings() {
      calls.push(['getAllMeetings']);
      return [{ ...meeting }];
    },
  };
}

function createFakeScenes() {
  const writes = [];
  return {
    COVENANT_RESEARCH: 'research covenant',
    writes,
    getScene(scene) {
      if (scene === 'research') return { defaultCovenant: 'research covenant' };
      if (scene === 'general') return { defaultCovenant: 'general covenant' };
      return null;
    },
    writeCovenantSnapshot(root, meetingId, text) {
      writes.push(['snapshot', root, meetingId, text]);
    },
    writePromptFile(root, meetingId, scene, text, slotId) {
      writes.push(['prompt', root, meetingId, scene, text, slotId || null]);
    },
  };
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  OK ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

console.log('Running meeting IPC contract tests...');

test('registers expected meeting channels', () => {
  const ipc = createFakeIpc();
  registerMeetingIpc(ipc, {
    getHubDataDir: () => 'C:\\tmp\\hub',
    meetingManager: createFakeMeetingManager(),
    scenes: createFakeScenes(),
    sendToRenderer: () => {},
    stateStore: { save() {} },
  });

  for (const channel of [
    'get-immersive-mode',
    'save-immersive-mode',
    'groupchat:set-participants',
    'update-meeting-sync',
    'get-scene-covenant',
    'get-research-covenant-template',
    'switch-scene',
    'get-meetings',
  ]) {
    assert.ok(ipc.handlers.has(channel), `${channel} should be registered as handle`);
  }
  assert.ok(ipc.listeners.has('update-meeting'), 'update-meeting should be registered as listener');
});

test('meeting rename fields preserve old title semantics', () => {
  assert.deepStrictEqual(withUserRenameFields({ title: 'New' }), {
    title: 'New',
    userRenamed: true,
    autoTitlePending: false,
  });
  assert.deepStrictEqual(withUserRenameFields({ title: 'AI', autoTitleGenerated: true }), {
    title: 'AI',
    autoTitleGenerated: true,
  });
});

test('update-meeting-sync emits update and returns boolean result', () => {
  const ipc = createFakeIpc();
  const meetingManager = createFakeMeetingManager();
  const emitted = [];
  registerMeetingIpc(ipc, {
    getHubDataDir: () => 'C:\\tmp\\hub',
    meetingManager,
    scenes: createFakeScenes(),
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
    stateStore: { save() {} },
  });

  const ok = ipc.handlers.get('update-meeting-sync')(null, { meetingId: 'meet-1', fields: { title: 'Renamed' } });

  assert.strictEqual(ok, true);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0][0], 'meeting-updated');
  assert.strictEqual(emitted[0][1].meeting.userRenamed, true);
  assert.strictEqual(emitted[0][1].meeting.autoTitlePending, false);
});

test('groupchat:set-participants validates, dedupes, sorts, persists, and emits', async () => {
  const ipc = createFakeIpc();
  const meetingManager = createFakeMeetingManager();
  const saves = [];
  const emitted = [];
  registerMeetingIpc(ipc, {
    getHubDataDir: () => 'C:\\tmp\\hub',
    getImmersiveByMeeting: () => ({ 'meet-1': false }),
    getLastPersistedSessions: () => [{ hubId: 's1' }],
    meetingManager,
    scenes: createFakeScenes(),
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
    stateStore: { save(state) { saves.push(state); } },
  });

  const result = await ipc.handlers.get('groupchat:set-participants')(null, {
    meetingId: 'meet-1',
    participants: [2, 0, 2],
  });

  assert.deepStrictEqual(result, { ok: true });
  assert.deepStrictEqual(meetingManager.calls.find(call => call[0] === 'setParticipants'), ['setParticipants', 'meet-1', [0, 2]]);
  assert.strictEqual(saves.length, 1);
  assert.deepStrictEqual(saves[0].sessions, [{ hubId: 's1' }]);
  assert.deepStrictEqual(saves[0].immersiveByMeeting, { 'meet-1': false });
  assert.strictEqual(emitted.at(-1)[0], 'meeting-updated');
});

test('switch-scene writes covenant and prompt files for research slots', () => {
  const meetingManager = createFakeMeetingManager();
  const scenes = createFakeScenes();
  const emitted = [];
  const result = switchScene({
    meetingId: 'meet-1',
    scene: 'research',
    covenant: 'new covenant',
    deps: {
      getHubDataDir: () => 'C:\\tmp\\hub',
      meetingManager,
      scenes,
      sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
      slotIds: ['slot-a', 'slot-b'],
    },
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(scenes.writes, [
    ['snapshot', 'C:\\tmp\\hub', 'meet-1', 'new covenant'],
    ['prompt', 'C:\\tmp\\hub', 'meet-1', 'research', 'new covenant', 'slot-a'],
    ['prompt', 'C:\\tmp\\hub', 'meet-1', 'research', 'new covenant', 'slot-b'],
    ['prompt', 'C:\\tmp\\hub', 'meet-1', 'research', 'new covenant', null],
  ]);
  assert.strictEqual(emitted[0][0], 'meeting-updated');
});

test('switch-scene rejects invalid ids and scenes without side effects', () => {
  const meetingManager = createFakeMeetingManager();
  const scenes = createFakeScenes();
  assert.strictEqual(isValidMeetingId('abc-123_X'), true);
  assert.strictEqual(isValidMeetingId('../bad'), false);
  assert.deepStrictEqual(
    switchScene({
      meetingId: '../bad',
      scene: 'research',
      covenant: 'x',
      deps: { getHubDataDir: () => 'C:\\tmp\\hub', meetingManager, scenes, sendToRenderer: () => {} },
    }),
    { ok: false, error: 'invalid meetingId' }
  );
  assert.deepStrictEqual(
    switchScene({
      meetingId: 'meet-1',
      scene: 'missing',
      covenant: 'x',
      deps: { getHubDataDir: () => 'C:\\tmp\\hub', meetingManager, scenes, sendToRenderer: () => {} },
    }),
    { ok: false, error: 'invalid scene: missing' }
  );
  assert.deepStrictEqual(scenes.writes, []);
});
