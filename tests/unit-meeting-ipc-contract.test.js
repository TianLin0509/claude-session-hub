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

function createFakeMeetingManager(overrides = {}) {
  const meeting = {
    id: 'meet-1',
    title: 'Old',
    groupChat: true,
    subSessions: ['s1', 's2', 's3'],
    participants: [0, 2],
    slotSpecs: [
      { kind: 'claude', model: 'sonnet' },
      { kind: 'codex', model: 'gpt-5' },
      { kind: 'gemini', model: 'pro' },
    ],
    serialWorkflow: {
      enabled: true,
      steps: [['m1'], ['m2', 'm3']],
      loop: { enabled: true },
    },
    scene: 'general',
    covenantText: 'old covenant',
    ...overrides,
  };
  const calls = [];
  return {
    meeting,
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
      return id === meeting.id ? { ...meeting } : null;
    },
    setSlotSpecs(id, slotSpecs) {
      calls.push(['setSlotSpecs', id, slotSpecs]);
      if (id === meeting.id) meeting.slotSpecs = slotSpecs;
      return id === meeting.id ? { ...meeting } : null;
    },
    getAllMeetings() {
      calls.push(['getAllMeetings']);
      return [{ ...meeting }];
    },
    removeSubSession(id, sessionId) {
      calls.push(['removeSubSession', id, sessionId]);
      if (id !== meeting.id) return null;
      meeting.subSessions = meeting.subSessions.filter(sid => sid !== sessionId);
      return { ...meeting };
    },
    closeMeeting(id) {
      calls.push(['closeMeeting', id]);
      if (id !== meeting.id) return null;
      return ['s1', 's2'];
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
    'remove-meeting-sub',
    'close-meeting',
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

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.meeting.participants, [0, 2]);
  assert.deepStrictEqual(meetingManager.calls.find(call => call[0] === 'setParticipants'), ['setParticipants', 'meet-1', [0, 2]]);
  assert.strictEqual(saves.length, 1);
  assert.deepStrictEqual(saves[0].sessions, [{ hubId: 's1' }]);
  assert.deepStrictEqual(saves[0].immersiveByMeeting, { 'meet-1': false });
  assert.strictEqual(emitted.at(-1)[0], 'meeting-updated');
});

test('remove-meeting-sub closes only a real member, reindexes dependent state, cleans persistence, and emits', () => {
  const ipc = createFakeIpc();
  const meetingManager = createFakeMeetingManager();
  const calls = [];
  const emitted = [];
  const saves = [];
  registerMeetingIpc(ipc, {
    getHubDataDir: () => 'C:\\tmp\\hub',
    groupchat: {
      cleanup() {},
      getOrchestrator() {
        return { getState: () => ({ currentMode: 'idle' }) };
      },
    },
    meetingManager,
    scenes: createFakeScenes(),
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
    sessionManager: { closeSession: (sid) => calls.push(['closeSession', sid]) },
    sessionStore: {
      deleteSessionFile: (sid) => calls.push(['deleteSessionFile', sid]),
      cancelDirty: (sid) => calls.push(['cancelDirty', sid]),
    },
    stateStore: {
      save(state) { saves.push(state); },
      markRemovedSession: (sid) => calls.push(['markRemovedSession', sid]),
      markRemovedMeeting() {},
    },
  });

  const result = ipc.handlers.get('remove-meeting-sub')(null, { meetingId: 'meet-1', sessionId: 's2' });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.meeting.subSessions, ['s1', 's3']);
  assert.deepStrictEqual(result.meeting.participants, [0, 1]);
  assert.deepStrictEqual(result.meeting.slotSpecs, [
    { kind: 'claude', model: 'sonnet' },
    { kind: 'gemini', model: 'pro' },
  ]);
  assert.deepStrictEqual(result.meeting.serialWorkflow.steps, [['m1'], ['m2']]);
  assert.deepStrictEqual(
    meetingManager.calls.find(call => call[0] === 'updateMeeting')[2].serialWorkflow.steps,
    [['m1'], ['m2']],
    'reindexed serial workflow must be written through the manager contract'
  );
  assert.deepStrictEqual(calls, [
    ['closeSession', 's2'],
    ['markRemovedSession', 's2'],
    ['deleteSessionFile', 's2'],
    ['cancelDirty', 's2'],
  ]);
  assert.strictEqual(emitted.at(-1)[0], 'meeting-updated');
  assert.strictEqual(saves.length, 1, 'member removal should persist the fresh meeting snapshot immediately');
});

test('remove-meeting-sub rejects non-members, the last member, and active turns without closing sessions', () => {
  const cases = [
    {
      overrides: {},
      sessionId: 'outside',
      mode: 'idle',
      reason: 'not_member',
    },
    {
      overrides: { subSessions: ['s1'], participants: [0], slotSpecs: [{ kind: 'claude' }] },
      sessionId: 's1',
      mode: 'idle',
      reason: 'last_member',
    },
    {
      overrides: {},
      sessionId: 's2',
      mode: 'group',
      reason: 'turn_in_progress',
    },
    {
      overrides: {},
      sessionId: 's2',
      mode: 'throws',
      reason: 'turn_state_unavailable',
    },
  ];

  for (const item of cases) {
    const ipc = createFakeIpc();
    const meetingManager = createFakeMeetingManager(item.overrides);
    const closed = [];
    registerMeetingIpc(ipc, {
      getHubDataDir: () => 'C:\\tmp\\hub',
      groupchat: {
        getOrchestrator() {
          if (item.mode === 'throws') throw new Error('corrupt orchestrator state');
          return { getState: () => ({ currentMode: item.mode }) };
        },
      },
      meetingManager,
      scenes: createFakeScenes(),
      sendToRenderer() {},
      sessionManager: { closeSession: (sid) => closed.push(sid) },
      sessionStore: { deleteSessionFile() {}, cancelDirty() {} },
      stateStore: { save() {}, markRemovedSession() {} },
    });

    const result = ipc.handlers.get('remove-meeting-sub')(null, {
      meetingId: 'meet-1',
      sessionId: item.sessionId,
    });
    assert.deepStrictEqual(result, { ok: false, reason: item.reason });
    assert.deepStrictEqual(closed, []);
  }
});

test('close-meeting closes subs, removes persisted state, cleans groupchat, and emits', () => {
  const ipc = createFakeIpc();
  const meetingManager = createFakeMeetingManager();
  const calls = [];
  const emitted = [];
  registerMeetingIpc(ipc, {
    deleteImmersiveByMeeting: (meetingId) => calls.push(['deleteImmersiveByMeeting', meetingId]),
    getHubDataDir: () => 'C:\\tmp\\hub',
    groupchat: { cleanup: (root, meetingId) => calls.push(['cleanup', root, meetingId]) },
    meetingManager,
    scenes: createFakeScenes(),
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
    sessionManager: { closeSession: (sid) => calls.push(['closeSession', sid]) },
    sessionStore: {
      deleteSessionFile: (sid) => calls.push(['deleteSessionFile', sid]),
      cancelDirty: (sid) => calls.push(['cancelDirty', sid]),
    },
    stateStore: {
      save() {},
      markRemovedSession: (sid) => calls.push(['markRemovedSession', sid]),
      markRemovedMeeting: (meetingId) => calls.push(['markRemovedMeeting', meetingId]),
    },
  });

  const ok = ipc.handlers.get('close-meeting')(null, 'meet-1');
  const missing = ipc.handlers.get('close-meeting')(null, 'missing');

  assert.strictEqual(ok, true);
  assert.strictEqual(missing, false);
  assert.deepStrictEqual(calls, [
    ['closeSession', 's1'],
    ['markRemovedSession', 's1'],
    ['deleteSessionFile', 's1'],
    ['cancelDirty', 's1'],
    ['closeSession', 's2'],
    ['markRemovedSession', 's2'],
    ['deleteSessionFile', 's2'],
    ['cancelDirty', 's2'],
    ['cleanup', 'C:\\tmp\\hub', 'meet-1'],
    ['markRemovedMeeting', 'meet-1'],
    ['deleteImmersiveByMeeting', 'meet-1'],
  ]);
  assert.deepStrictEqual(emitted, [['meeting-closed', { meetingId: 'meet-1' }]]);
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
