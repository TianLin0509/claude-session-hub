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
    isClaudeFamily: (kind) => ['claude', 'claude-resume'].includes(kind),
    isClaudeWebKind: () => false,
    isCodexBaseKind: (kind) => ['codex', 'codex-resume', 'deepseek', 'deepseek-resume'].includes(kind),
    lookupKimiSession: () => null,
    meetingManager: { getMeeting: () => null },
    os: { homedir: () => 'C:\\Users\\tester' },
    path: require('path'),
    readTranscriptTail: async () => null,
    registerSessionForTap: (session) => calls.push(['registerSessionForTap', session.id]),
    scenes: {
      buildAiTeamMcpEntryForCodex: (meetingId, kind) => ({ aiTeamMeetingId: meetingId, aiTeamKind: kind }),
      buildResearchMcpEntryForCodex: (...args) => ({ researchArgs: args }),
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
      completionNotificationEnabled: false,
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

test('dormant Claude night guard resume carries one initial recovery prompt', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerResumeSessionIpc(ipc, deps);

  await ipc.handlers.get('resume-session')(null, {
    hubId: 'claude-night-guard',
    kind: 'claude',
    ccSessionId: 'cc-night-guard',
    cwd: 'C:\\repo',
    nightGuardRecoveryPrompt: 'Continue exactly once.',
  });

  const createCall = deps.calls.find(call => call[0] === 'createSession');
  assert.strictEqual(createCall[2].resumeCCSessionId, 'cc-night-guard');
  assert.strictEqual(createCall[2].claudeInitialPrompt, 'Continue exactly once.');
  assert.strictEqual(createCall[2].useContinue, false);
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
    mcpProfile: 'browser',
    meetingId: 'm1',
    cwd: 'C:\\repo',
  });

  assert.strictEqual(session.opts.resumeTranscriptPath, 'rollout:codex-1');
  assert.strictEqual(session.opts.useResume, true);
  assert.strictEqual(session.opts.codexBypassApprovals, true);
  assert.strictEqual(session.opts.mcpProfile, 'browser');
  assert.strictEqual(session.opts.noInheritCursor, true, 'headless group resumes must keep ConPTY output enabled');
  assert.deepStrictEqual(session.opts.codexMcpEntries, [
    { aiTeamMeetingId: 'm1', aiTeamKind: 'codex' },
    { researchArgs: ['m1', 3456, 'token', 'C:\\hub', { enableChuxin: true }] },
  ]);
  assert.deepStrictEqual(deps.calls.filter(call => call[0] === 'findCodexRolloutBySid'), [
    ['findCodexRolloutBySid', 'codex-1', 'C:\\codex\\sessions'],
  ]);
});

test('resumed Codex None session preserves 1M/Standard and does not restore room MCP', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps({
    meetingManager: {
      getMeeting: () => ({ id: 'm-none', groupChat: true, scene: 'research' }),
    },
  });
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-none',
    kind: 'codex',
    codexSid: 'codex-none',
    currentModel: { id: 'gpt-5.6-sol' },
    mcpProfile: 'none',
    codexSpeedTier: 'standard',
    contextMax: 1_000_000,
    contextEffectiveMax: 828_400,
    contextEffectiveObservedAt: 1_787_500_000_000,
    meetingId: 'm-none',
    cwd: 'C:\\repo',
  });

  assert.equal(session.opts.mcpProfile, 'none');
  assert.equal(session.opts.codexSpeedTier, 'standard');
  assert.equal(session.opts.contextMax, 1_000_000);
  assert.equal(session.opts.contextEffectiveMax, 828_400);
  assert.equal(session.opts.contextEffectiveObservedAt, 1_787_500_000_000);
  assert.equal(session.opts.codexMcpEntries, undefined);
  assert.equal(session.opts.codexBypassApprovals, undefined);
});

test('new and pre-migration DeepSeek sessions resume on their own runtime', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerResumeSessionIpc(ipc, deps);

  const current = await ipc.handlers.get('resume-session')(null, {
    hubId: 'ds-current', kind: 'deepseek', codexSid: 'ds-codex-1', cwd: 'C:\\repo',
  });
  assert.strictEqual(current.opts.useResume, true);
  assert.strictEqual(current.opts.codexSid, 'ds-codex-1');
  assert.strictEqual(current.opts.resumeCCSessionId, undefined);
  assert.strictEqual(current.opts.resumeTranscriptPath, 'rollout:ds-codex-1');

  const legacy = await ipc.handlers.get('resume-session')(null, {
    hubId: 'ds-legacy', kind: 'deepseek', ccSessionId: 'ds-cc-1', model: 'deepseek-v4-pro[1m]', cwd: 'C:\\repo',
  });
  assert.strictEqual(legacy.opts.deepseekLegacyClaude, true);
  assert.strictEqual(legacy.opts.resumeCCSessionId, 'ds-cc-1');
  assert.strictEqual(legacy.opts.codexSid, null);
  assert.strictEqual(legacy.opts.resumeTranscriptPath, 'transcript:ds-cc-1');
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

test('repairs a persisted Codex subagent binding to its top-level parent session', async () => {
  const ipc = createFakeIpc();
  const parentSid = '019f49ff-cd9c-7a82-a730-0231f092a2e8';
  const deps = createBaseDeps({
    isCodexSubagentRolloutPath: (rolloutPath) => rolloutPath === 'C:\\codex\\subagent.jsonl',
    readCodexRolloutMeta: () => ({
      id: '019f516d-1111-7111-8111-111111111111',
      thread_source: 'subagent',
      parent_thread_id: parentSid,
    }),
  });
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-subagent-parent',
    kind: 'codex',
    codexSid: '019f516d-1111-7111-8111-111111111111',
    transcriptPath: 'C:\\codex\\subagent.jsonl',
    cwd: 'C:\\repo',
  });

  assert.strictEqual(session.opts.codexSid, parentSid);
  assert.strictEqual(session.opts.codexResumePicker, false);
  assert.strictEqual(session.opts.resumeTranscriptPath, `rollout:${parentSid}`);
});

test('uses the persisted Codex profile root when an old session has no stored rollout root', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps({
    resolveCodexSessionsRoot: (meta) => meta.codexProfile === 'second'
      ? 'C:\\codex-second\\sessions'
      : 'C:\\codex\\sessions',
  });
  registerResumeSessionIpc(ipc, deps);

  await ipc.handlers.get('resume-session')(null, {
    hubId: 's-profile-root', kind: 'codex', codexSid: 'codex-second-1',
    codexProfile: 'second', cwd: 'C:\\repo',
  });

  assert.deepStrictEqual(deps.calls.filter(call => call[0] === 'findCodexRolloutBySid'), [
    ['findCodexRolloutBySid', 'codex-second-1', 'C:\\codex-second\\sessions'],
  ]);
});

test('publishes the authoritative session after transcript registration repairs metadata', async () => {
  const ipc = createFakeIpc();
  let authoritative = null;
  let published = null;
  const deps = createBaseDeps({
    sessionManager: {
      createSession(kind, opts) {
        return { id: opts.id, kind, codexSid: opts.codexSid, transcriptPath: opts.resumeTranscriptPath };
      },
      getSession: () => authoritative,
      writeToSession() {},
    },
    registerSessionForTap(session) {
      authoritative = {
        ...session,
        codexSid: 'codex-repaired',
        transcriptPath: 'C:\\codex\\sessions\\repaired.jsonl',
        codexSessionsRoot: 'C:\\codex\\sessions',
      };
    },
    sendToRenderer(_channel, payload) {
      published = payload.session;
    },
  });
  registerResumeSessionIpc(ipc, deps);

  const result = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-authoritative', kind: 'codex', codexSid: 'codex-old', cwd: 'C:\\repo',
  });

  assert.strictEqual(result, authoritative);
  assert.strictEqual(published, authoritative);
  assert.strictEqual(published.codexSid, 'codex-repaired');
  assert.strictEqual(published.transcriptPath, 'C:\\codex\\sessions\\repaired.jsonl');
});

test('provider-native ids replace stale persisted transcript paths during resume', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerResumeSessionIpc(ipc, deps);

  const claude = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-claude-stale', kind: 'claude', ccSessionId: 'cc-new',
    transcriptPath: 'C:\\old\\claude.jsonl', cwd: 'C:\\repo',
  });
  assert.strictEqual(claude.opts.resumeTranscriptPath, 'transcript:cc-new');

  const codex = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-codex-stale', kind: 'codex', codexSid: 'codex-new',
    transcriptPath: 'C:\\old\\rollout.jsonl', cwd: 'C:\\repo',
  });
  assert.strictEqual(codex.opts.resumeTranscriptPath, 'rollout:codex-new');
});

test('Kimi resume reconciles a stale wire binding even when cwd is already correct', async () => {
  const ipc = createFakeIpc();
  const path = require('path');
  const currentCwd = path.resolve('C:\\repo');
  const indexedDir = path.resolve('C:\\kimi\\sessions\\session-new');
  const deps = createBaseDeps({
    fs: { existsSync: (candidate) => path.resolve(candidate) === currentCwd },
    lookupKimiSession: () => ({ workDir: currentCwd, sessionDir: indexedDir }),
  });
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 's-kimi-stale', kind: 'kimi-resume', kimiSid: 'session-new',
    cwd: currentCwd,
    kimiSessionDir: path.resolve('C:\\kimi\\sessions\\session-old'),
    transcriptPath: path.resolve('C:\\kimi\\sessions\\session-old\\agents\\main\\wire.jsonl'),
  });
  const indexedWire = path.join(indexedDir, 'agents', 'main', 'wire.jsonl');
  assert.strictEqual(session.opts.cwd, currentCwd, 'already-correct cwd should stay unchanged');
  assert.strictEqual(session.opts.kimiSessionDir, indexedDir);
  assert.strictEqual(session.opts.resumeTranscriptPath, indexedWire);
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

test('gemini-resume keeps its exact native id instead of degrading to latest', async () => {
  const ipc = createFakeIpc();
  const deps = createBaseDeps();
  registerResumeSessionIpc(ipc, deps);

  const session = await ipc.handlers.get('resume-session')(null, {
    hubId: 'g-exact',
    kind: 'gemini-resume',
    geminiChatId: '3eab55d9-8019-4485-a47e-07f93e288be5',
    geminiProjectRoot: 'C:\\project',
    cwd: 'C:\\project',
  });

  assert.strictEqual(session.opts.useResume, true);
  assert.strictEqual(session.opts.geminiChatId, '3eab55d9-8019-4485-a47e-07f93e288be5');
  assert.strictEqual(session.opts.geminiProjectRoot, 'C:\\project');
});
