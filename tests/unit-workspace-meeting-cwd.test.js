'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMeetingSubAdder } = require('../main/ipc/meeting-create-handlers.js');

async function run() {
  const meeting = {
    id: 'm1',
    groupChat: true,
    scene: 'general',
    workspace: 'C:\\Workspaces\\Projects\\demo',
    subSessions: [],
    participants: [],
    slotSpecs: [],
  };
  let captured = null;
  const meetingManager = {
    getMeeting() { return meeting; },
    addSubSession(_id, sessionId) {
      meeting.subSessions.push(sessionId);
      return { ...meeting, subSessions: [...meeting.subSessions] };
    },
    setParticipants() { return meeting; },
    setSlotSpecs() { return meeting; },
  };
  const add = createMeetingSubAdder({
    fs,
    getHookPort: () => null,
    getHubDataDir: () => 'C:\\isolated-hub',
    getMeetingWorkspaceDir: id => path.join('C:\\isolated-hub', id),
    getSlotPromptName: () => 'slot',
    groupchat: {},
    hookToken: 'test',
    isClaudeFamily: () => false,
    isCodexBaseKind: () => false,
    isIsolatedHub: () => false,
    kindLabels: { claude: 'Claude' },
    logger: { warn() {} },
    meetingManager,
    path,
    registerSessionForTap() {},
    scenes: {},
    sendToRenderer() {},
    sessionManager: {
      createSession(kind, opts) {
        captured = { kind, opts };
        return { id: 's1', kind, cwd: opts.cwd, currentModel: null };
      },
      closeSession() {},
    },
    slotIds: ['slot1'],
  });

  await add('m1', 'claude');
  assert(captured);
  assert.strictEqual(captured.opts.cwd, meeting.workspace);
  console.log('unit-workspace-meeting-cwd: PASS');
}

run().catch(err => { console.error(err); process.exitCode = 1; });
