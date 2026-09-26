'use strict';
// PTY Codex 的 hook 决定卡片绑定哪个 rollout、什么时候算「开始干活」。
// 子代理与嵌套进程绝不能改绑；完成事件只走 rollout，避免未读翻倍。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCodexPtyHookHandler, isPtyCodexSession } = require('../main/codex-pty-hook');

function harness({ boundSid = null, hostShell = false, rolloutBound = true, subagentPaths = [] } = {}) {
  const calls = [];
  const session = { id: 'hub-1', kind: 'codex', agentRuntime: 'pty', runtimeBackend: null,
    codexSid: boundSid, transcriptPath: boundSid ? `C:/s/rollout-${boundSid}.jsonl` : null };
  const sessionManager = {
    updateSessionMeta: (id, patch) => { calls.push(['meta', patch]); Object.assign(session, patch); return { ...session }; },
    noteAgentTurnStarted: (id, event) => calls.push(['turn-started', event.signalSource]),
    isHostShellActive: () => hostShell,
    _refreshOpenIdentity: () => calls.push(['ownership']),
  };
  const tap = new EventEmitter();
  tap.bindCodexFromHook = async (id, options) => { calls.push(['bind', options.codexSid, options.rebind]); return true; };
  tap.notePrompt = () => calls.push(['note-prompt']);
  tap.getCodexRolloutPath = () => (rolloutBound ? session.transcriptPath : null);
  tap.on('turn-complete', ev => calls.push(['turn-complete', ev.signalSource]));
  const sent = [];
  const handle = createCodexPtyHookHandler({ sessionManager, transcriptTap: tap,
    sendToRenderer: (channel, payload) => sent.push([channel, payload]),
    readCodexRolloutMeta: file => (subagentPaths.includes(file) ? { source: { subagent: {} } } : { id: 'x' }),
    isCodexTopLevelRolloutMeta: meta => !meta.source, logger: { warn() {} }, now: () => 1000 });
  return { session, calls, sent, handle };
}

test('first hook binds the exact rollout and confirms the submitted turn', async () => {
  const h = harness({ rolloutBound: false });
  const outcome = await h.handle(h.session, 'prompt', { claudeSessionId: 'T1', transcriptPath: 'C:/s/rollout-T1.jsonl', prompt: '你好' });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(h.calls.filter(c => c[0] === 'bind'), [['bind', 'T1', false]]);
  assert.ok(h.calls.some(c => c[0] === 'turn-started' && c[1] === 'codex-user-prompt-submit'));
  const hook = h.sent.find(([channel]) => channel === 'hook-event')[1];
  assert.equal(hook.event, 'prompt');
  assert.equal(hook.claudeSessionId, null, 'a Codex thread id must never be stored as a Claude session id');
});

test('subagent and nested-process events never rebind the session', async () => {
  const h = harness({ boundSid: 'T1', subagentPaths: ['C:/s/rollout-SUB.jsonl'] });
  assert.deepEqual(await h.handle(h.session, 'tool-start', { agentId: 'sub', claudeSessionId: 'SUB' }), { ignored: 'subagent' });
  assert.deepEqual(await h.handle(h.session, 'stop', { claudeSessionId: 'SUB', transcriptPath: 'C:/s/rollout-SUB.jsonl' }), { ignored: 'subagent' });
  // CLI 里嵌套跑 codex exec：新的 session_id、source=startup，而 TUI 仍在运行。
  assert.deepEqual(await h.handle(h.session, 'session-start', { claudeSessionId: 'N1', transcriptPath: 'C:/s/rollout-N1.jsonl', source: 'startup' }),
    { ignored: 'foreign-session' });
  assert.equal(h.session.codexSid, 'T1');
  assert.ok(!h.calls.some(c => c[0] === 'bind'));
});

test('/new and a relaunch after the CLI exited move the session to the new thread', async () => {
  const cleared = harness({ boundSid: 'T1' });
  await cleared.handle(cleared.session, 'session-start', { claudeSessionId: 'T2', transcriptPath: 'C:/s/rollout-T2.jsonl', source: 'clear' });
  assert.equal(cleared.session.codexSid, 'T2');
  assert.deepEqual(cleared.calls.filter(c => c[0] === 'bind'), [['bind', 'T2', true]]);
  const relaunched = harness({ boundSid: 'T1', hostShell: true });
  await relaunched.handle(relaunched.session, 'session-start', { claudeSessionId: 'T3', transcriptPath: 'C:/s/rollout-T3.jsonl', source: 'startup' });
  assert.equal(relaunched.session.codexSid, 'T3');
});

test('stop completes through the rollout; the hook only substitutes when no rollout is bound', async () => {
  const bound = harness({ boundSid: 'T1' });
  await bound.handle(bound.session, 'stop', { claudeSessionId: 'T1', transcriptPath: bound.session.transcriptPath, lastAssistantMessage: 'x' });
  assert.ok(!bound.calls.some(c => c[0] === 'turn-complete'));
  assert.ok(!bound.sent.some(([channel]) => channel === 'hook-event'), 'stop is not forwarded: unread must not double');
  const unbound = harness({ rolloutBound: false });
  await unbound.handle(unbound.session, 'stop', { lastAssistantMessage: 'answer' });
  assert.deepEqual(unbound.calls.filter(c => c[0] === 'turn-complete'), [['turn-complete', 'codex-stop-hook']]);
});

test('only PTY Codex sessions take this path', () => {
  assert.equal(isPtyCodexSession({ kind: 'codex', agentRuntime: 'pty', runtimeBackend: null }), true);
  assert.equal(isPtyCodexSession({ kind: 'codex', runtimeBackend: 'codex-app-server' }), false);
  assert.equal(isPtyCodexSession({ kind: 'claude', agentRuntime: 'pty' }), false);
});
