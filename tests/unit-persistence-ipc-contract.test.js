'use strict';

const assert = require('assert');
const {
  buildMeetingsForState,
  handlePersistSessions,
  mergeResumeMetaFields,
  registerPersistenceIpc,
} = require('../main/ipc/persistence-handlers.js');

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

function createDeps() {
  const calls = [];
  let lastPersistedSessions = [{
    hubId: 'keep',
    transcriptPath: 'C:\\old\\transcript.jsonl',
    codexSid: 'sid-old',
    currentModel: 'opus',
    userRenamed: true,
  }, {
    hubId: 'removed-session',
  }];
  let lastPersistedSessionIds = new Set(['keep', 'removed-session']);
  let lastPersistedMeetingIds = new Set(['meet-1', 'removed-meeting']);
  const immersiveByMeeting = { 'meet-1': true };

  return {
    calls,
    bootWasClean: true,
    getImmersiveByMeeting: () => immersiveByMeeting,
    getLastPersistedMeetingIds: () => lastPersistedMeetingIds,
    getLastPersistedSessionIds: () => lastPersistedSessionIds,
    getLastPersistedSessions: () => lastPersistedSessions,
    meetingManager: {
      getAllMeetings() {
        calls.push(['getAllMeetings']);
        return [{ id: 'meet-1', scene: 'research' }];
      },
      getMeeting(id) {
        calls.push(['getMeeting', id]);
        if (id !== 'meet-1') return null;
        return {
          id,
          scene: 'research',
          mode: 'free',
          groupChat: true,
          groupMode: 'deliberation',
          groupRecentRawN: 5,
          userRenamed: true,
          autoTitlePending: false,
          autoTitleGenerated: true,
          participants: [0, 2],
          slotSpecs: [{ kind: 'codex' }],
          covenantText: 'authoritative covenant',
        };
      },
    },
    meetingStore: {
      deleteMeetingFile(id) { calls.push(['deleteMeetingFile', id]); },
      cancelDirty(id) { calls.push(['cancelMeetingDirty', id]); },
      markDirty(id, meeting) { calls.push(['markMeetingDirty', id, meeting]); },
    },
    sessionStore: {
      deleteSessionFile(id) { calls.push(['deleteSessionFile', id]); },
      cancelDirty(id) { calls.push(['cancelSessionDirty', id]); },
      markDirty(id, session) { calls.push(['markSessionDirty', id, session]); },
    },
    setLastPersistedMeetingIds(ids) {
      calls.push(['setLastPersistedMeetingIds', [...ids]]);
      lastPersistedMeetingIds = ids;
    },
    setLastPersistedSessionIds(ids) {
      calls.push(['setLastPersistedSessionIds', [...ids]]);
      lastPersistedSessionIds = ids;
    },
    setLastPersistedSessions(sessions) {
      calls.push(['setLastPersistedSessions', sessions]);
      lastPersistedSessions = sessions;
    },
    stateStore: {
      markRemovedMeeting(id) { calls.push(['markRemovedMeeting', id]); },
      markRemovedSession(id) { calls.push(['markRemovedSession', id]); },
      save(state) { calls.push(['save', state]); },
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

console.log('Running persistence IPC contract tests...');

test('registers dormant and persist channels', () => {
  const ipc = createFakeIpc();
  const deps = createDeps();
  registerPersistenceIpc(ipc, deps);

  assert.ok(ipc.handlers.has('get-dormant-sessions'));
  assert.ok(ipc.listeners.has('persist-sessions'));
  assert.deepStrictEqual(ipc.handlers.get('get-dormant-sessions')(), {
    sessions: deps.getLastPersistedSessions(),
    wasCleanShutdown: true,
  });
});

test('mergeResumeMetaFields preserves resume metadata and user rename flag', () => {
  const incoming = [{ hubId: 'keep', title: 'Renderer', transcriptPath: null, userRenamed: false }];

  mergeResumeMetaFields(incoming, [{
    hubId: 'keep',
    transcriptPath: 'C:\\old\\transcript.jsonl',
    currentModel: 'opus',
    userRenamed: true,
  }]);

  assert.strictEqual(incoming[0].transcriptPath, 'C:\\old\\transcript.jsonl');
  assert.strictEqual(incoming[0].currentModel, 'opus');
  assert.strictEqual(incoming[0].userRenamed, true);
});

test('buildMeetingsForState fills missing meeting fields from manager', () => {
  const deps = createDeps();

  const meetings = buildMeetingsForState([{ id: 'meet-1', title: 'Renderer' }], deps.meetingManager);

  assert.strictEqual(meetings[0].scene, 'research');
  assert.strictEqual(meetings[0].mode, 'free');
  assert.strictEqual(meetings[0].groupChat, true);
  assert.deepStrictEqual(meetings[0].participants, [0, 2]);
  assert.strictEqual(meetings[0].covenantText, 'authoritative covenant');
});

test('handlePersistSessions performs removed diff, per-id writes, immersive merge, and state save', () => {
  const deps = createDeps();
  const incomingSessions = [{ hubId: 'keep', title: 'Renderer', transcriptPath: null }];
  const incomingMeetings = [{ id: 'meet-1', title: 'Meeting renderer' }];

  const ok = handlePersistSessions(incomingSessions, incomingMeetings, deps);

  assert.strictEqual(ok, true);
  assert.strictEqual(incomingSessions[0].transcriptPath, 'C:\\old\\transcript.jsonl');
  assert.ok(deps.calls.some(call => call[0] === 'markRemovedSession' && call[1] === 'removed-session'));
  assert.ok(deps.calls.some(call => call[0] === 'deleteSessionFile' && call[1] === 'removed-session'));
  assert.ok(deps.calls.some(call => call[0] === 'markRemovedMeeting' && call[1] === 'removed-meeting'));
  assert.ok(deps.calls.some(call => call[0] === 'deleteMeetingFile' && call[1] === 'removed-meeting'));
  assert.ok(deps.calls.some(call => call[0] === 'markSessionDirty' && call[1] === 'keep'));

  const saved = deps.calls.find(call => call[0] === 'save')[1];
  assert.strictEqual(saved.cleanShutdown, false);
  assert.strictEqual(saved.sessions, incomingSessions);
  assert.strictEqual(saved.meetings[0].immersive, true);
  assert.strictEqual(saved.immersiveByMeeting['meet-1'], true);
});

test('handlePersistSessions ignores invalid session lists', () => {
  const deps = createDeps();

  assert.strictEqual(handlePersistSessions(null, [], deps), false);
  assert.ok(!deps.calls.some(call => call[0] === 'save'));
});

console.log('All persistence IPC contract tests passed.');
