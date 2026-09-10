'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { createClaudeNativeWatcher } = require('../core/claude-native-watcher');
const { getSessionRuntimeTruth, applySessionRuntimeObservation } = require('../core/session-runtime-truth');
const watcher = require('../core/group-chat-watcher');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
function session(mode = 'normal') {
  return new ClaudeNativeSession({ id: 'hub', executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures', 'claude-stream.js'), '--fixture=' + mode] });
}
test('ordinary and group dispatch use pipe; raw writes and terminal detectors are unreachable', async t => {
  const native = session(); t.after(() => native.close());
  const manager = { getNativeClaude: () => native, getSession: () => ({ kind: 'claude', runtimeBackend: 'claude-stream-json' }),
    writeToSession() { assert.fail('raw terminal write'); }, getSessionBuffer() { assert.fail('terminal detector'); } };
  watcher.init({ sessionManager: manager });
  const ipc = new Map();
  registerPromptSubmitIpc({ handle: (key, fn) => ipc.set(key, fn) }, { sessionManager: manager });
  const first = await ipc.get('session:send-prompt')({}, { sessionId: 'hub', text: '甲\n乙', clientSubmissionId: 'ordinary' });
  assert.equal(first.mode, 'claude-stream-json'); assert.equal(first.enterAttempts, 0);
  const done = createClaudeNativeWatcher(native, { sid: 'hub', submissionId: 'ordinary' });
  assert.equal((await done.wait()).status, 'completed');
  const second = await watcher.sendToPty('hub', '下一阶段', 'claude', { clientSubmissionId: 'phase' });
  assert.equal(second.submissionId, 'phase');
  assert.equal(await watcher.waitCliReady('hub', 'claude'), true);
  assert.equal(await watcher.checkHostShellTakeover('hub'), false);
  assert.equal((await watcher.resendCurrentPrompt({ sid: 'hub' })).reason, 'native-reconciliation-required');
});
test('A completion cannot settle queued B; B carries its own UUID and result', async t => {
  const native = session('hold'); t.after(() => native.close());
  const a = await native.submit('相同正文', { clientSubmissionId: 'A' });
  const b = await native.submit('相同正文', { clientSubmissionId: 'B' });
  assert.equal(b.sendStatus, 'queued');
  const progress = [];
  const w = createClaudeNativeWatcher(native, { sid: 'hub', submissionId: 'B', attemptId: 'B', onProgress: event => progress.push(event) });
  const done = w.wait();
  assert.equal(progress[0].status, 'queued');
  await native.interrupt();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('B not accepted')), 3000);
    const inspect = event => { if (event.type === 'submission-accepted' && event.clientSubmissionId === 'B') {
      clearTimeout(timer); native.off('lifecycle', inspect); resolve(); } };
    native.on('lifecycle', inspect);
  });
  assert.equal(w.isSettled(), false);
  assert.equal(progress.at(-1).status, 'accepted');
  assert.ok(progress.every(event => event.userMessageId === b.userMessageId));
  assert.ok(progress.every(event => event.providerTurnId === null));
  native.emit('lifecycle', { type: 'agent-turn-complete', clientSubmissionId: 'A', text: 'old answer' });
  assert.equal(w.isSettled(), false);
  await native.interrupt();
  const result = await done;
  assert.equal(result.status, 'interrupted'); assert.equal(result.userMessageId, b.userMessageId);
  assert.notEqual(result.userMessageId, a.userMessageId);
});
test('empty final result is complete even when watcher attaches after provider result', async t => {
  const native = session('empty-result'); t.after(() => native.close());
  const ended = new Promise(resolve => native.on('lifecycle', e => e.type === 'agent-turn-complete' && resolve()));
  await native.submit('空回答', { clientSubmissionId: 'empty' }); await ended;
  const result = await createClaudeNativeWatcher(native, { sid: 'hub', submissionId: 'empty' }).wait();
  assert.equal(result.status, 'completed'); assert.equal(result.text, '');
});
test('legacy waiting/footer/timeout truth cannot replace native revision', () => {
  const session = { runtimeBackend: 'claude-stream-json', status: 'running', needsUserInput: true,
    nativeRuntime: { state: 'completed', revision: 20, epoch: 2, turnId: 'B', observedAt: 123 } };
  const result = applySessionRuntimeObservation(session, { state: 'running', source: 'pty-footer', observedAt: Date.now() });
  assert.equal(result.applied, false);
  assert.equal(getSessionRuntimeTruth(session).state, 'completed');
  assert.equal(getSessionRuntimeTruth(session).revision, 20);
  const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');
  assert.equal(deriveSessionRuntimeStatus(session, { isRunning: true }).state, 'completed');
  session.nativeRuntime.state = 'unknown';
  const { buildComposerStatusModel } = require('../core/session-status-summary');
  const composer = buildComposerStatusModel(session, { runtime: deriveSessionRuntimeStatus(session) });
  assert.equal(composer.text, '本条提交待核对');
  assert.notEqual(composer.state, 'ready');
});

test('stray terminal IPC for native sessions reports an error without a raw write or uncaught exception', () => {
  const handlers = new Map(); const errors = [];
  const { registerSessionIpc } = require('../main/ipc/session-handlers');
  registerSessionIpc({ on: (key, fn) => handlers.set(key, fn), handle: (key, fn) => handlers.set(key, fn) }, {
    sessionManager: { getNativeClaude: () => ({ emit: (type, message) => errors.push({ type, message }) }),
      writeToSession() { assert.fail('native raw write'); } },
  });
  for (const data of ['typing', '\x03', '/rename title\r']) handlers.get('terminal-input')({}, { sessionId: 'hub', data });
  assert.equal(errors.length, 3); assert.ok(errors.every(error => error.type === 'action-error'));
});

test('durable completed submissions restore without replay and retain tool output', async t => {
  const fs = require('node:fs'); const os = require('node:os');
  const { NativeAgentJournal } = require('../core/native-agent-journal');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-restore-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = new NativeAgentJournal({ directory, sessionId: 'hub' });
  const native = session('tool-result');
  native.options.persistSubmission = data => journal.saveSubmission(data);
  native.options.persistLifecycle = event => journal.saveLifecycle(event);
  t.after(() => native.close());
  await native.submit('原始输入', { clientSubmissionId: 'restore' });
  await createClaudeNativeWatcher(native, { sid: 'hub', submissionId: 'restore' }).wait();
  await native.close();
  const fresh = session('normal');
  const restored = new ClaudeNativeSession({ ...fresh.options, resumeSessionId: native.sessionId,
    restoredRecords: new NativeAgentJournal({ directory, sessionId: 'hub' }).list(), restoredRuntime: native.runtime });
  t.after(() => restored.close());
  const receipt = await restored.submit('原始输入', { clientSubmissionId: 'restore' });
  assert.equal(receipt.sendStatus, 'completed');
  assert.equal(restored.active, null);
  assert.equal(restored.transcript().filter(turn => turn.role === 'user').length, 1);
  assert.equal(restored.transcript().find(turn => turn.role === 'assistant').toolCalls[0].output, 'file text');
});

test('failed terminal journal commit cannot publish a successful group result', async t => {
  const native = session(); t.after(() => native.close());
  native.options.persistLifecycle = event => {
    if (event.type === 'agent-turn-complete') throw new Error('disk unavailable at final commit');
  };
  await native.submit('需要落盘确认', { clientSubmissionId: 'disk-fail' });
  const result = await createClaudeNativeWatcher(native, { sid: 'hub', submissionId: 'disk-fail' }).wait();
  assert.equal(result.status, 'errored');
  assert.equal(native.runtime.state, 'unknown');
  assert.equal(native.records.get('disk-fail').status, 'unknown');
});

test('group output consumer failure is visible without declaring a protocol disconnect', async t => {
  const native = session('approval'); t.after(() => native.close());
  const errors = []; native.on('action-error', message => errors.push(message));
  await native.submit('output failure', { clientSubmissionId: 'observer' });
  const w = createClaudeNativeWatcher(native, { sid: 'hub', submissionId: 'observer', onPartial() { throw new Error('observer disk full'); } });
  const pending = w.wait();
  native.emit('item', { userMessageId: native.active.userMessageId, message: { type: 'assistant' } });
  assert.equal((await pending).status, 'errored');
  assert.equal(native.unreconciled, false);
  assert.equal(native.runtime.connection, 'connected');
  assert.ok(errors.some(message => message.includes('observer disk full')));
});
