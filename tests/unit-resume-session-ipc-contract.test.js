'use strict';

const assert = require('assert');
const { registerResumeSessionIpc } = require('../main/ipc/resume-session-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function createBaseDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    defaultCodexSessionsRoot: 'C:\\codex\\sessions',
    findCodexRolloutBySid: (sid, root) => {
      calls.push(['findCodexRolloutBySid', sid, root]);
      return `rollout:${sid}`;
    },
    findTranscriptByCCSessionId: (sid) => {
      calls.push(['findTranscriptByCCSessionId', sid]);
      return `transcript:${sid}`;
    },
    fs: { readdirSync: () => [] },
    getHookPort: () => 3456,
    getHubDataDir: () => 'C:\\hub',
    hookToken: 'token',
    isClaudeFamily: (kind) => ['claude', 'claude-resume', 'deepseek'].includes(kind),
    isClaudeWebKind: () => false,
    isCodexBaseKind: (kind) => ['codex', 'codex-resume'].includes(kind),
    meetingManager: { getMeeting: () => null },
    os: { homedir: () => 'C:\\Users\\tester' },
    path: require('path'),
    readTranscriptTail: async () => null,
    registerSessionForTap: (session) => calls.push(['registerSessionForTap', session.id]),
    scenes: {
      buildAiTeamMcpEntryForCodex: (meetingId, kind) => ({ aiTeamMeetingId: meetingId, aiTeamKind: kind }),
      buildResearchMcpEntryForCodex: (meetingId, port, token) => ({ meetingId, port, token }),
      readCovenantSnapshot: () => 'snapshot covenant',
      writePromptFile: (...args) => {
        calls.push(['writePromptFile', ...args]);
        return 'C:\\hub\\prompt.md';
      },
      writeResearchMcpConfig: (...args) => {
        calls.push(['writeResearchMcpConfig', ...args]);
        return 'C:\\hub\\mcp.json';
      },
    },
    sendToRenderer: (channel, payload) => calls.push(['sendToRenderer', channel, payload.session.id]),
    sessionManager: {
      createSession(kind, opts) {
        calls.push(['createSession', kind, opts]);
        return { id: opts.id, kind, opts };
      },
      getSession: () => null,
      writeToSession() {},
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

console.log('Running resume session IPC contract tests...');

test('registers resume-session and rejects empty meta', async () => {
  const ipc = createFakeIpc();
  registerResumeSessionIpc(ipc, createBaseDeps());

  assert.ok(ipc.handlers.has('resume-session'));
  assert.strictEqual(await ipc.handlers.get('resume-session')(null, null), null);
});

test('resumes Claude-family sessions with transcript lookup and renderer event', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's1',
    kind: 'claude',
    ccSessionId: 'cc-1',
    cwd: 'C:\\repo',
    title: 'Old Claude',
  });

  assert.strictEqual(session.id, 's1');
  assert.deepStrictEqual(deps.calls, [
    ['findTranscriptByCCSessionId', 'cc-1'],
    ['createSession', 'claude', {
      id: 's1',
      title: 'Old Claude',
      cwd: 'C:\\repo',
      meetingId: null,
      model: undefined,
      resumeCCSessionId: 'cc-1',
      resumeTranscriptPath: 'transcript:cc-1',
      useContinue: false,
      useResume: false,
      codexResumePicker: false,
      codexSid: null,
      codexProfile: null,
      geminiChatId: null,
      geminiProjectRoot: null,
      userRenamed: false,
      autoTitleGenerated: true,
      lastMessageTime: undefined,
      lastOutputPreview: undefined,
    }],
    ['registerSessionForTap', 's1'],
    ['sendToRenderer', 'session-created', 's1'],
  ]);
});

test('resume passes manual rename protection into live session', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerResumeSessionIpc(ipc, deps);

  await ipc.handlers.get('resume-session')(null, {
    hubId: 's-renamed',
    kind: 'claude',
    ccSessionId: 'cc-renamed',
    cwd: 'C:\\repo',
    title: 'Claude 1',
    userRenamed: true,
  });

  const createCall = deps.calls.find(call => call[0] === 'createSession');
  assert.strictEqual(createCall[2].userRenamed, true);
  assert.strictEqual(createCall[2].autoTitleGenerated, false);
});

test('resumes Codex group research sessions with MCP entries and rollout path', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps({
    meetingManager: {
      getMeeting: () => ({ id: 'm1', groupChat: true, scene: 'research' }),
    },
  });
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's2',
    kind: 'codex',
    codexSid: 'codex-1',
    codexProfile: 'work',
    meetingId: 'm1',
    cwd: 'C:\\repo',
  });

  assert.strictEqual(session.opts.resumeTranscriptPath, 'rollout:codex-1');
  assert.strictEqual(session.opts.useResume, true);
  assert.strictEqual(session.opts.codexBypassApprovals, true);
  assert.strictEqual(session.opts.noInheritCursor, true, 'headless group resumes must keep ConPTY output enabled');
  assert.deepStrictEqual(session.opts.codexMcpEntries, [
    { aiTeamMeetingId: 'm1', aiTeamKind: 'codex' },
    { meetingId: 'm1', port: 3456, token: 'token' },
  ]);
  assert.deepStrictEqual(deps.calls.filter(call => call[0] === 'findCodexRolloutBySid'), [
    ['findCodexRolloutBySid', 'codex-1', 'C:\\codex\\sessions'],
  ]);
});

test('does not resume a persisted Codex subagent binding as the Hub top-level PTY', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps({
    isCodexSubagentRolloutPath: (rolloutPath) => rolloutPath === 'C:\\codex\\subagent.jsonl',
  });
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-subagent',
    kind: 'codex',
    codexSid: 'subagent-sid',
    transcriptPath: 'C:\\codex\\subagent.jsonl',
    cwd: 'C:\\repo',
  });

  assert.strictEqual(session.opts.resumeTranscriptPath, undefined);
  assert.strictEqual(session.opts.codexSid, null);
  assert.strictEqual(session.opts.codexResumePicker, true);
});

test('resumes single-meeting Gemini with prompt file env and project root cwd', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps({
    meetingManager: {
      getMeeting: () => ({
        id: 'm2',
        groupChat: false,
        scene: 'general',
        covenantText: 'meeting covenant',
        subSessions: ['other', 's3'],
      }),
    },
  });
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's3',
    kind: 'gemini',
    geminiChatId: 'g1',
    geminiProjectRoot: 'C:\\project',
    meetingId: 'm2',
    cwd: 'C:\\fallback',
  });

  assert.strictEqual(session.opts.cwd, 'C:\\project');
  assert.deepStrictEqual(session.opts.extraEnv, { GEMINI_SYSTEM_MD: 'C:\\hub\\prompt.md' });
  assert.deepStrictEqual(deps.calls.filter(call => call[0] === 'writePromptFile'), [
    ['writePromptFile', 'C:\\hub', 'm2', 'general', 'meeting covenant', 'slot-b'],
  ]);
});
