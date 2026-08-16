'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findCodexRolloutByCwd,
  findCodexRolloutBySid,
  isUsableCodexRolloutPath,
  parseCodexRolloutToTurns,
} = require('../core/codex-transcript-parser.js');
const { CodexTap } = require('../core/transcript-tap.js');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers.js');

function makeTmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hub-card-isolation-${label}-`));
}

function rolloutFilename(startAt, sid) {
  const stamp = startAt.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
  return `rollout-${stamp}-${sid}.jsonl`;
}

function writeRollout(root, {
  cwd,
  sid,
  startAt = new Date(),
  threadSource = 'user',
  source = 'cli',
  extraMeta = {},
  userMessage = null,
  answer = null,
}) {
  const dayDir = path.join(
    root,
    String(startAt.getFullYear()),
    String(startAt.getMonth() + 1).padStart(2, '0'),
    String(startAt.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dayDir, { recursive: true });
  const rolloutPath = path.join(dayDir, rolloutFilename(startAt, sid));
  const lines = [{
    timestamp: startAt.toISOString(),
    type: 'session_meta',
    payload: {
      id: sid,
      session_id: sid,
      timestamp: startAt.toISOString(),
      cwd,
      originator: 'codex-tui',
      source,
      thread_source: threadSource,
      ...extraMeta,
    },
  }];
  if (userMessage) {
    lines.push({
      timestamp: new Date(startAt.getTime() + 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: userMessage },
    });
  }
  if (answer) {
    lines.push({
      timestamp: new Date(startAt.getTime() + 200).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: answer, duration_ms: 100 },
    });
  }
  fs.writeFileSync(rolloutPath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return rolloutPath;
}

test('CodexTap never binds a Hub top-level session to a Codex subagent rollout', async (t) => {
  const root = makeTmpRoot('subagent');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const tap = new CodexTap({ sessionsRoot: root, pollIntervalMs: 60_000 });
  t.after(async () => {
    tap.unregisterSession('hub-session');
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  tap.registerSession('hub-session', { cwd });
  const now = new Date();
  const subagentPath = writeRollout(root, {
    cwd,
    sid: '019faaaa-0000-7000-8000-000000000001',
    startAt: now,
    threadSource: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: '019fparent-0000-7000-8000-000000000000' } } },
    extraMeta: {
      parent_thread_id: '019fparent-0000-7000-8000-000000000000',
      agent_path: '/root/audit',
    },
    userMessage: 'another conversation',
  });
  await tap._tryBind(subagentPath);
  assert.equal(tap.getRolloutPath('hub-session'), null);

  const topLevelPath = writeRollout(root, {
    cwd,
    sid: '019fbbbb-0000-7000-8000-000000000002',
    startAt: new Date(now.getTime() + 10),
    userMessage: 'the Hub conversation',
  });
  await tap._tryBind(topLevelPath);
  assert.equal(tap.getRolloutPath('hub-session'), topLevelPath);
});

test('prompt-required Codex session rejects an unmatched top-level rollout even when it is the only pending session', async (t) => {
  const root = makeTmpRoot('prompt');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const tap = new CodexTap({ sessionsRoot: root, pollIntervalMs: 60_000 });
  t.after(async () => {
    tap.unregisterSession('hub-meeting');
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  tap.registerSession('hub-meeting', { cwd, requirePromptMatch: true });
  tap.notePrompt('hub-meeting', 'prompt owned by this Hub meeting');
  const now = new Date();
  const outsiderPath = writeRollout(root, {
    cwd,
    sid: '019fcccc-0000-7000-8000-000000000003',
    startAt: now,
    userMessage: 'unrelated top-level prompt',
  });
  await tap._tryBind(outsiderPath);
  assert.equal(tap.getRolloutPath('hub-meeting'), null);

  const ownedPath = writeRollout(root, {
    cwd,
    sid: '019fdddd-0000-7000-8000-000000000004',
    startAt: new Date(now.getTime() + 10),
    userMessage: 'prompt owned by this Hub meeting',
  });
  await tap._tryBind(ownedPath);
  assert.equal(tap.getRolloutPath('hub-meeting'), ownedPath);
});

test('a late competing bind cannot replace the rollout already owned by a Hub session', async (t) => {
  const root = makeTmpRoot('late-bind');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const tap = new CodexTap({ sessionsRoot: root, pollIntervalMs: 60_000 });
  t.after(async () => {
    tap.unregisterSession('hub-owned');
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const now = new Date();
  const ownedPath = writeRollout(root, {
    cwd,
    sid: '019faaaa-1111-7000-8000-000000000011',
    startAt: now,
    userMessage: 'owned',
  });
  const competingPath = writeRollout(root, {
    cwd,
    sid: '019fbbbb-1111-7000-8000-000000000012',
    startAt: new Date(now.getTime() + 10),
    userMessage: 'competing',
  });

  assert.equal(await tap._bindRolloutToHubSession('hub-owned', ownedPath), true);
  assert.equal(await tap._bindRolloutToHubSession('hub-owned', competingPath), false);
  assert.equal(tap.getRolloutPath('hub-owned'), ownedPath);
});

test('cwd fallback ignores a newer Codex subagent rollout', async (t) => {
  const root = makeTmpRoot('cwd');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));

  const now = new Date();
  const topLevelPath = writeRollout(root, {
    cwd,
    sid: '019feeee-0000-7000-8000-000000000005',
    startAt: now,
    userMessage: 'top-level',
  });
  const subagentPath = writeRollout(root, {
    cwd,
    sid: '019fffff-0000-7000-8000-000000000006',
    startAt: new Date(now.getTime() + 100),
    threadSource: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    userMessage: 'subagent',
  });
  const topMtime = new Date(now.getTime() + 500);
  const subMtime = new Date(now.getTime() + 1000);
  fs.utimesSync(topLevelPath, topMtime, topMtime);
  fs.utimesSync(subagentPath, subMtime, subMtime);

  assert.equal(findCodexRolloutByCwd(cwd, root), topLevelPath);
});

test('cwd fallback chooses the top-level rollout closest to the requested spawn time', async (t) => {
  const root = makeTmpRoot('cwd-nearest');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));

  const spawnAt = Date.now();
  const ownedPath = writeRollout(root, {
    cwd,
    sid: '019f0001-0000-7000-8000-000000000009',
    startAt: new Date(spawnAt + 100),
    userMessage: 'owned session',
  });
  const laterUnrelatedPath = writeRollout(root, {
    cwd,
    sid: '019f0002-0000-7000-8000-000000000010',
    startAt: new Date(spawnAt + 5000),
    userMessage: 'later unrelated session',
  });
  fs.utimesSync(ownedPath, new Date(spawnAt + 100), new Date(spawnAt + 100));
  fs.utimesSync(laterUnrelatedPath, new Date(spawnAt + 5000), new Date(spawnAt + 5000));

  assert.equal(findCodexRolloutByCwd(cwd, root, { sinceMs: spawnAt }), ownedPath);
});

test('transcript IPC ignores live and renderer rollout paths that disagree with the authoritative codexSid', async (t) => {
  const root = makeTmpRoot('ipc');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));

  const now = new Date();
  const correctSid = '019f1111-0000-7000-8000-000000000007';
  const wrongPath = writeRollout(root, {
    cwd,
    sid: '019f2222-0000-7000-8000-000000000008',
    startAt: now,
    userMessage: 'wrong question',
    answer: 'wrong answer',
  });
  const correctPath = writeRollout(root, {
    cwd,
    sid: correctSid,
    startAt: new Date(now.getTime() + 10),
    userMessage: 'correct question',
    answer: 'correct answer',
  });
  const patches = [];
  const session = {
    id: 'hub-ipc',
    kind: 'codex',
    cwd,
    codexSid: correctSid,
    transcriptPath: wrongPath,
    codexSessionsRoot: root,
    codexAllowMtimeFallback: false,
  };
  const result = await parseSessionTranscript({
    hubSessionId: session.id,
    transcriptPath: wrongPath,
    kind: 'codex',
  }, {
    defaultCodexSessionsRoot: root,
    defer: async () => {},
    findCodexRolloutByCwd,
    findCodexRolloutBySid,
    findTranscriptByCCSessionId: () => null,
    isCodexCliKind: kind => kind === 'codex',
    isUsableCodexRolloutPath,
    parseClaudeTranscriptToTurns: async () => [],
    parseCodexRolloutToTurns,
    sessionManager: { getSession: () => session },
    transcriptTap: { getCodexRolloutPath: () => wrongPath },
    updateSessionTranscriptBinding: (_hubId, patch) => patches.push(patch),
  });

  assert.equal(result.error, null);
  assert.equal(result.transcriptPath, correctPath);
  assert.deepEqual(result.turns.map(turn => turn.text), ['correct question', 'correct answer']);
  assert.deepEqual(patches, [{ transcriptPath: correctPath }]);
});

test('Claude transcript IPC prefers the main-process session path over a stale renderer path', async () => {
  const session = {
    id: 'hub-claude',
    kind: 'claude',
    transcriptPath: 'C:\\claude\\authoritative.jsonl',
    ccSessionId: 'authoritative',
  };
  const parsedPaths = [];
  const result = await parseSessionTranscript({
    hubSessionId: session.id,
    transcriptPath: 'C:\\claude\\stale-renderer.jsonl',
    kind: 'claude',
  }, {
    defer: async () => {},
    findTranscriptByCCSessionId: () => null,
    isCodexCliKind: () => false,
    parseClaudeTranscriptToTurns: async (transcriptPath) => {
      parsedPaths.push(transcriptPath);
      return [{ id: 'a1', role: 'assistant', text: 'authoritative answer' }];
    },
    sessionManager: { getSession: () => session },
    transcriptTap: { getCodexRolloutPath: () => null },
    updateSessionTranscriptBinding: () => {},
  });

  assert.equal(result.error, null);
  assert.equal(result.transcriptPath, session.transcriptPath);
  assert.deepEqual(parsedPaths, [session.transcriptPath]);
});
