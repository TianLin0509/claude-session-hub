'use strict';
// 返工 R1：PTY 的 Claude/Codex 会话与原生会话共用同一份持久化草稿；
// 以及 R1 真机暴露的迁移缺陷：一轮都没跑过的 Codex 会话恢复时不能落进历史选择框。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-draft-unit-'));
process.env.CLAUDE_HUB_DATA_DIR = dataDir;
delete process.env.CLAUDE_HUB_AGENT_RUNTIME;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { isPtyAgentSession } = require('../core/agent-runtime-mode');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
const { registerResumeSessionIpc } = require('../main/ipc/resume-session-handlers');

function fakeIpc() {
  return { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); }, on() {}, removeHandler() {} };
}

test('isPtyAgentSession only matches sessions launched as PTY agents', () => {
  assert.equal(isPtyAgentSession({ kind: 'codex', agentRuntime: 'pty', runtimeBackend: null }), true);
  assert.equal(isPtyAgentSession({ kind: 'claude', agentRuntime: 'pty' }), true);
  assert.equal(isPtyAgentSession({ kind: 'codex', agentRuntime: 'pty', runtimeBackend: 'codex-app-server' }), false);
  assert.equal(isPtyAgentSession({ kind: 'powershell' }), false);
  assert.equal(isPtyAgentSession(null), false);
});

test('draft IPC persists PTY agent drafts with revisions and still rejects plain terminals', async t => {
  const sessions = {
    'pty-codex': { id: 'pty-codex', kind: 'codex', agentRuntime: 'pty', runtimeBackend: null },
    'native-claude': { id: 'native-claude', kind: 'claude', runtimeBackend: 'claude-stream-json' },
    'shell': { id: 'shell', kind: 'powershell' },
  };
  const ipc = fakeIpc();
  const handle = registerPromptSubmitIpc(ipc, {
    sessionManager: { getSession: id => sessions[id], on() {}, removeListener() {} },
    transcriptTap: { on() {}, removeListener() {} },
    logger: { log() {}, warn() {} },
  });
  t.after(() => handle?.dispose?.());
  const read = id => ipc.handlers.get('native-draft:read')(null, { sessionId: id });
  const save = (id, text, revision) => ipc.handlers.get('native-draft:save')(null, { sessionId: id, text, revision });

  assert.deepEqual(await read('pty-codex'), { ok: true, record: { revision: 0, text: null } });
  assert.deepEqual(await save('pty-codex', '第一版\n🙂', 0), { ok: true, record: { revision: 1, text: '第一版\n🙂' } });
  // 另一个输入栏 / 另一个 Hub 拿着旧 revision 写：拒绝，不覆盖已保存版本。
  const stale = await save('pty-codex', '旧窗口', 0);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'NATIVE_DRAFT_CONFLICT');
  assert.equal((await read('pty-codex')).record.text, '第一版\n🙂');
  // 原生会话照旧。
  assert.equal((await save('native-claude', 'x', 0)).ok, true);
  // 普通终端不走草稿库。
  assert.equal((await read('shell')).ok, false);
});

function resumeDeps(calls) {
  return {
    defaultCodexSessionsRoot: 'C:\\codex\\sessions',
    findCodexRolloutBySid: sid => (sid === 'has-rollout' ? 'C:\\codex\\sessions\\rollout-has-rollout.jsonl' : null),
    findTranscriptByCCSessionId: () => null,
    fs: { readdirSync: () => [] },
    getHookPort: () => 3456,
    getHubDataDir: () => dataDir,
    hookToken: 'token',
    isClaudeFamily: kind => ['claude', 'claude-resume'].includes(kind),
    isCodexBaseKind: kind => ['codex', 'codex-resume', 'deepseek', 'deepseek-resume'].includes(kind),
    lookupKimiSession: () => null,
    logger: { log() {}, warn() {} },
    meetingManager: { getMeeting: () => null },
    os: { homedir: () => 'C:\\Users\\tester' },
    path,
    readTranscriptTail: async () => null,
    registerSessionForTap() {},
    scenes: {},
    sendToRenderer() {},
    sessionManager: { createSession(kind, opts) { calls.push(opts); return { id: opts.id, kind, opts }; }, getSession: () => null },
    slotIds: [],
  };
}
async function resume(meta) {
  const calls = [];
  const ipc = fakeIpc();
  registerResumeSessionIpc(ipc, resumeDeps(calls));
  await ipc.handlers.get('resume-session')(null, { cwd: 'C:\\project', ...meta });
  return calls[0];
}

test('a Codex session that never ran a turn starts fresh instead of opening the history picker', async () => {
  // 原生时代建的：App Server 建过 thread，但一轮没跑、rollout 从未落盘。
  const migrated = await resume({ hubId: 'm1', kind: 'codex', codexSid: 'thread-without-rollout',
    nativeRuntime: { connection: 'connected', state: 'idle', threadId: 'thread-without-rollout', endedTurns: [] } });
  assert.equal(migrated.useResume, false);
  assert.equal(migrated.codexResumePicker, false);
  assert.equal(migrated.codexSid, null);
  // PTY 下开了没聊：没有任何跑过的痕迹。
  const unused = await resume({ hubId: 'p1', kind: 'codex', codexSid: null, nativeRuntime: null,
    lastRunStartedAt: null, lastCompletedAt: null, transcriptPath: null });
  assert.equal(unused.useResume, false);
  assert.equal(unused.codexResumePicker, false);
});

test('any evidence of a past turn keeps the safe resume paths', async () => {
  // 有 id 且有 rollout：精确恢复。
  const bound = await resume({ hubId: 'b1', kind: 'codex', codexSid: 'has-rollout' });
  assert.equal(bound.useResume, true);
  assert.equal(bound.codexSid, 'has-rollout');
  // 跑过（有开始时间）但没绑上 id：绑定失败的老会话，仍走选择框，不能丢历史。
  const ranUnbound = await resume({ hubId: 'r1', kind: 'codex', codexSid: null, lastRunStartedAt: 1790000000000 });
  assert.equal(ranUnbound.codexResumePicker, true);
  // 原生快照里有结束过的轮次：同样不当成「没跑过」。
  const nativeRan = await resume({ hubId: 'n1', kind: 'codex', codexSid: null,
    nativeRuntime: { connection: 'connected', state: 'completed', endedTurns: ['t1'] } });
  assert.equal(nativeRan.codexResumePicker, true);
  // 用户主动选的 Codex Resume 本来就要选择框。
  const picker = await resume({ hubId: 'k1', kind: 'codex-resume', codexSid: null });
  assert.equal(picker.codexResumePicker, true);
});
