'use strict';

const assert = require('assert');
const {
  createMeetingSubAdder,
  registerMeetingCreateIpc,
} = require('../main/ipc/meeting-create-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function createFakeMeetingManager() {
  const calls = [];
  const meetings = new Map();
  return {
    calls,
    addSubSession(meetingId, sid) {
      calls.push(['addSubSession', meetingId, sid]);
      const meeting = meetings.get(meetingId);
      if (!meeting) return null;
      meeting.subSessions = [...(meeting.subSessions || []), sid];
      return { ...meeting, subSessions: [...meeting.subSessions] };
    },
    closeMeeting(meetingId) {
      calls.push(['closeMeeting', meetingId]);
      meetings.delete(meetingId);
      return [];
    },
    createMeeting(opts) {
      calls.push(['createMeeting', opts]);
      const meeting = { id: opts.id || 'm1', ...opts, subSessions: [] };
      meetings.set(meeting.id, meeting);
      return { ...meeting, subSessions: [] };
    },
    getMeeting(meetingId) {
      calls.push(['getMeeting', meetingId]);
      const meeting = meetings.get(meetingId);
      return meeting ? { ...meeting, subSessions: [...(meeting.subSessions || [])] } : null;
    },
    setMeeting(meeting) {
      meetings.set(meeting.id, { ...meeting, subSessions: [...(meeting.subSessions || [])] });
    },
    setSlotSpecs(meetingId, specs) {
      calls.push(['setSlotSpecs', meetingId, specs]);
      const meeting = meetings.get(meetingId);
      if (meeting) meeting.slotSpecs = specs;
    },
  };
}

function createBaseDeps(overrides = {}) {
  const calls = [];
  const meetingManager = createFakeMeetingManager();
  return {
    calls,
    fs: { mkdirSync: (...args) => calls.push(['mkdirSync', ...args]) },
    getHookPort: () => 4567,
    getHubDataDir: () => 'C:\\hub',
    getMeetingWorkspaceDir: (meetingId) => `C:\\isolated\\${meetingId}`,
    getSlotPromptName: (slotId) => `slot:${slotId}`,
    groupchat: { cleanup: (...args) => calls.push(['cleanup', ...args]) },
    hookToken: 'token',
    isClaudeFamily: (kind) => ['claude', 'deepseek', 'glm'].includes(kind),
    isCodexBaseKind: (kind) => ['codex', 'codex-resume'].includes(kind),
    isIsolatedHub: () => true,
    kindLabels: { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' },
    meetingManager,
    path: require('path'),
    registerSessionForTap: (session) => calls.push(['registerSessionForTap', session.id]),
    scenes: {
      buildResearchMcpEntryForCodex: (...args) => ({ args }),
      writeResearchMcpConfig: (...args) => {
        calls.push(['writeResearchMcpConfig', ...args]);
        return 'C:\\hub\\mcp.json';
      },
    },
    sendToRenderer: (channel, payload) => calls.push(['sendToRenderer', channel, payload]),
    sessionManager: {
      createSession(kind, opts) {
        calls.push(['createSession', kind, opts]);
        return { id: `${kind}-sid-${calls.filter(c => c[0] === 'createSession').length}`, kind, opts };
      },
      closeSession: (sid) => calls.push(['closeSession', sid]),
    },
    slotIds: ['slot-a', 'slot-b', 'slot-c'],
    ...overrides,
  };
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((err) => {
      console.error(`  FAIL ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

console.log('Running meeting create IPC contract tests...');

test('registers create-meeting and add-meeting-sub', () => {
  const ipc = createFakeIpc();
  registerMeetingCreateIpc(ipc, createBaseDeps());

  assert.ok(ipc.handlers.has('create-meeting'));
  assert.ok(ipc.handlers.has('add-meeting-sub'));
});

test('add-meeting-sub assigns slot title, isolated workspace, and Claude MCP config', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  deps.meetingManager.setMeeting({ id: 'm1', groupChat: true, scene: 'research', subSessions: [] });
  registerMeetingCreateIpc(ipc, deps);

  const result = await ipc.handlers.get('add-meeting-sub')(null, { meetingId: 'm1', kind: 'claude', model: 'opus' });

  assert.strictEqual(result.session.kind, 'claude');
  assert.strictEqual(result.session.opts.title, 'Claude 1');
  assert.strictEqual(result.session.opts.cwd, 'C:\\isolated\\m1');
  assert.strictEqual(result.session.opts.model, 'opus');
  assert.strictEqual(result.session.opts.mcpConfigFile, 'C:\\hub\\mcp.json');
  assert.deepStrictEqual(deps.calls.filter(call => call[0] === 'writeResearchMcpConfig'), [
    ['writeResearchMcpConfig', 'C:\\hub', 'm1', 4567, 'token', 'claude'],
  ]);
  assert.strictEqual(deps.calls.filter(call => call[0] === 'sendToRenderer').length, 2);
});

test('add-meeting-sub applies Codex research MCP entries without overwriting explicit cwd', async () => {
  const addSub = createMeetingSubAdder(createBaseDeps({
    meetingManager: (() => {
      const manager = createFakeMeetingManager();
      manager.setMeeting({ id: 'm1', groupChat: true, scene: 'research', subSessions: ['s0'] });
      return manager;
    })(),
  }));

  const result = await addSub('m1', 'codex', { cwd: 'C:\\custom' });

  assert.strictEqual(result.session.opts.cwd, 'C:\\custom');
  assert.strictEqual(result.session.opts.title, 'Codex 2');
  assert.strictEqual(result.session.opts.codexBypassApprovals, true);
  assert.deepStrictEqual(result.session.opts.codexMcpEntries, [{ args: ['m1', 4567, 'token'] }]);
});

test('create-meeting with slots emits final meeting once and persists slot specs', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerMeetingCreateIpc(ipc, deps);

  const meeting = await ipc.handlers.get('create-meeting')(null, {
    title: 'Room',
    scene: 'research',
    slots: [
      { index: 0, kind: 'claude', model: 'opus' },
      { index: 1, kind: 'codex', model: 'gpt-5.5' },
    ],
  });

  assert.deepStrictEqual(meeting.subSessions, ['claude-sid-1', 'codex-sid-2']);
  assert.deepStrictEqual(meeting.slotSpecs, [
    { index: 0, kind: 'claude', model: 'opus' },
    { index: 1, kind: 'codex', model: 'gpt-5.5' },
  ]);
  assert.deepStrictEqual(
    deps.calls.filter(call => call[0] === 'sendToRenderer').map(call => call[1]),
    ['session-created', 'meeting-updated', 'session-created', 'meeting-updated', 'meeting-created']
  );
});

test('create-meeting preserves legacy empty-room creation path', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerMeetingCreateIpc(ipc, deps);

  const meeting = await ipc.handlers.get('create-meeting')(null, { scene: 'general' });

  assert.deepStrictEqual(meeting.subSessions, []);
  assert.strictEqual(meeting.groupChat, true);
  assert.strictEqual(meeting.autoTitlePending, true);
  assert.strictEqual(meeting.userRenamed, false);
  assert.deepStrictEqual(
    deps.calls.filter(call => call[0] === 'sendToRenderer').map(call => call[1]),
    ['meeting-created']
  );
});
