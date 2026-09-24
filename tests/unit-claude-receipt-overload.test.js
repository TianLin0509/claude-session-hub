'use strict';
// 2026-09-24 production incident: Anthropic answered 529 Overloaded for
// minutes. Claude Code had the input in its transcript 27 ms after the write,
// but replays the stdout echo only when the model starts streaming, so the Hub
// called the prompt unknown after 60 s, labelled the next one "提交失败", and
// killed the still-retrying writer when that next prompt was sent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClaudeNativeSession, digest } = require('../core/claude-native-session');
const { createClaudeNativeWatcher } = require('../core/claude-native-watcher');
const { probeSubmissionReceipt } = require('../core/claude-receipt-probe');
const { claudeApiRetrySummary } = require('../core/claude-native-runtime');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
const watcher = require('../core/group-chat-watcher');
const fixture = path.join(__dirname, 'fixtures', 'claude-stream.js');

function overloaded(t, { transcript = 'on', retries = 5, gapMs = 100, timeoutMs = 200 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-overload-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_HUB_DATA_DIR: directory,
    CLAUDE_HUB_FIXTURE_TRANSCRIPT: transcript, CLAUDE_HUB_FIXTURE_RETRIES: String(retries),
    CLAUDE_HUB_FIXTURE_RETRY_MS: String(gapMs) };
  const session = new ClaudeNativeSession({ id: 'hub', executable: process.execPath, cwd: directory, env,
    commandArgs: [fixture, '--fixture=overloaded'], submissionTimeoutMs: timeoutMs });
  t.after(async () => { await session.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const retryLines = []; const accepted = [];
  session.on('state', runtime => { const line = claudeApiRetrySummary(runtime); if (line) retryLines.push(line); });
  session.on('lifecycle', event => { if (event.type === 'submission-accepted') accepted.push(event.clientSubmissionId); });
  return { session, directory, retryLines, accepted };
}

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('condition not reached in ' + ms + ' ms');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function ipcFor(native) {
  const manager = { getNativeClaude: () => native, getSession: () => ({ kind: 'claude', runtimeBackend: 'claude-stream-json' }),
    writeToSession() { assert.fail('raw terminal write'); }, getSessionBuffer() { assert.fail('terminal detector'); } };
  watcher.init({ sessionManager: manager });
  const ipc = new Map();
  registerPromptSubmitIpc({ handle: (key, fn) => ipc.set(key, fn) }, { sessionManager: manager });
  return ipc.get('session:send-prompt');
}

test('a prompt the engine recorded is confirmed from its transcript while the API keeps answering 529', async t => {
  const { session, retryLines, accepted } = overloaded(t, { retries: 5, gapMs: 100, timeoutMs: 200 });
  const send = ipcFor(session);
  const receipt = await send({}, { sessionId: 'hub', text: '过载也不许说成失败', clientSubmissionId: 'A' });
  // Confirmed from the first engine frame: long before the echo (≈600 ms)
  // and before the 200 ms deadline.
  const record = session.records.get('A');
  assert.equal(receipt.ok, true); assert.equal(record.status, 'accepted');
  assert.equal(record.receiptSource, 'history');
  assert.ok(record.acceptedAt - record.submittedAt < 200, `accepted after ${record.acceptedAt - record.submittedAt} ms`);
  const done = await createClaudeNativeWatcher(session, { sid: 'hub', submissionId: 'A' }).wait();
  assert.equal(done.status, 'completed');
  assert.equal(session.unreconciled, false);
  // The late echo re-confirms silently: one receipt, not two.
  assert.deepEqual(accepted, ['A']);
  // The retries were visible while they lasted, then cleared.
  assert.ok(retryLines.includes('Claude 服务繁忙（529），引擎自动重试第 5/10 次'), retryLines.join(' | '));
  assert.equal(session.runtime.apiRetry, null);
  assert.equal(claudeApiRetrySummary(session.runtime), '');
});

test('without transcript evidence the deadline still reports unknown, and the send is unconfirmed rather than failed', async t => {
  const { session } = overloaded(t, { transcript: 'off', retries: 3, gapMs: 150, timeoutMs: 150 });
  const send = ipcFor(session);
  const result = await send({}, { sessionId: 'hub', text: '没有证据就不猜', clientSubmissionId: 'B' });
  assert.equal(result.ok, false); assert.equal(result.error, 'CLAUDE_SUBMISSION_TIMEOUT');
  assert.equal(result.unconfirmed, true);
  assert.equal(session.unreconciled, true);
  // The same live writer's exact echo still settles it (existing late-ack path).
  await until(() => session.records.get('B').status === 'completed');
  assert.equal(session.unreconciled, false);
});

test('sending again after a timeout confirms the recorded prompt instead of killing its writer', async t => {
  const { session, directory } = overloaded(t, { transcript: 'off', retries: 20, gapMs: 100, timeoutMs: 150 });
  await assert.rejects(session.submit('第一条', { clientSubmissionId: 'first' }), { code: 'CLAUDE_SUBMISSION_TIMEOUT' });
  assert.equal(session.unreconciled, true);
  const pid = session.pid; const epoch = session.runtime.epoch;
  // The engine's transcript catches up (it had the input all along).
  const record = session.records.get('first');
  const file = path.join(directory, 'projects', path.resolve(directory).replace(/[^A-Za-z0-9]/g, '-'), session.sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: record.userMessageId, sessionId: session.sessionId,
    message: { role: 'user', content: record.content } }) + '\n');
  await session.prepareForNewPrompt();
  assert.equal(session.pid, pid, 'the writer must survive');
  assert.equal(session.runtime.epoch, epoch, 'no reconnect');
  assert.equal(session.unreconciled, false);
  assert.equal(record.status, 'accepted');
  const second = await session.submit('第二条', { clientSubmissionId: 'second' });
  assert.equal(second.sendStatus, 'queued');
  assert.equal((await createClaudeNativeWatcher(session, { sid: 'hub', submissionId: 'first' }).wait()).status, 'completed');
});

test('transcript probe: exact identity and content only, tail window never guesses', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = randomUUID(); const userMessageId = randomUUID();
  const content = [{ type: 'text', text: '正文' }];
  const matches = row => digest(row.message.content) === digest(content);
  const file = path.join(directory, 'h.jsonl');
  const probe = (options) => probeSubmissionReceipt(file, { sessionId, userMessageId, matches }, options);
  assert.equal(await probeSubmissionReceipt(null, { sessionId, userMessageId, matches }), 'history-missing');
  assert.equal(await probe(), 'history-missing');
  fs.writeFileSync(file, JSON.stringify({ type: 'attachment', parentUuid: userMessageId }) + '\n');
  assert.equal(await probe(), 'not-found');
  const row = JSON.stringify({ type: 'user', uuid: userMessageId, sessionId, message: { role: 'user', content } });
  fs.appendFileSync(file, row + '\n' + JSON.stringify({ type: 'system', subtype: 'api_error' }) + '\n');
  assert.equal(await probe(), 'received');
  // A row cut by the tail window is not evidence.
  assert.equal(await probe({ tailBytes: row.length }), 'not-found');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: userMessageId, sessionId: randomUUID(), message: { content } }) + '\n');
  assert.equal(await probe(), 'mismatch');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: userMessageId, sessionId, message: { content: '别的' } }) + '\n');
  assert.equal(await probe(), 'mismatch');
});

test('a mismatched transcript row neither confirms nor raises a content alarm', async t => {
  const { session, directory } = overloaded(t, { transcript: 'off', retries: 20, gapMs: 100, timeoutMs: 150 });
  const pending = session.submit('原文', { clientSubmissionId: 'M' });
  await until(() => session.records.get('M')?.writeStarted);
  const record = session.records.get('M');
  const file = path.join(directory, 'projects', path.resolve(directory).replace(/[^A-Za-z0-9]/g, '-'), session.sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: record.userMessageId, sessionId: session.sessionId,
    message: { role: 'user', content: [{ type: 'text', text: '被改过' }] } }) + '\n');
  await assert.rejects(pending, { code: 'CLAUDE_SUBMISSION_TIMEOUT' });
  assert.equal(record.status, 'unknown');
});

test('the composer names an engine retry instead of a silent working line', () => {
  const runtime = { state: 'starting', userMessageId: 'u1',
    apiRetry: { attempt: 3, maxRetries: 10, status: 529, userMessageId: 'u1' } };
  assert.equal(claudeApiRetrySummary(runtime), 'Claude 服务繁忙（529），引擎自动重试第 3/10 次');
  assert.equal(claudeApiRetrySummary({ ...runtime, apiRetry: { ...runtime.apiRetry, status: 429 } }), 'Claude 请求限流（429），引擎自动重试第 3/10 次');
  assert.equal(claudeApiRetrySummary({ ...runtime, apiRetry: { attempt: 1, maxRetries: 10, status: null, userMessageId: 'u1' } }),
    'Claude 连接不稳定，引擎自动重试第 1/10 次');
  // A retry that belongs to an earlier turn, or a settled turn, says nothing.
  assert.equal(claudeApiRetrySummary({ ...runtime, userMessageId: 'u2' }), '');
  assert.equal(claudeApiRetrySummary({ ...runtime, state: 'completed' }), '');
  const { buildComposerStatusModel } = require('../core/session-status-summary');
  const session = { id: 's', kind: 'claude', runtimeBackend: 'claude-stream-json', status: 'running',
    nativeRuntime: { ...runtime, connection: 'connected', startedAt: 0 } };
  const model = buildComposerStatusModel(session, { runtime: { state: 'running', provider: 'Claude' } });
  assert.match(model.text, /^Claude 服务繁忙（529），引擎自动重试第 3\/10 次/);
});

test('an unconfirmed send with a live writer is stated calmly: no 待核对, no button, not a warning', () => {
  const { buildComposerStatusModel } = require('../core/session-status-summary');
  const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');
  const session = { id: 's', kind: 'claude', runtimeBackend: 'claude-stream-json', status: 'running',
    nativeRuntime: { state: 'unknown', connection: 'connected', requests: [], reason: 'Claude 未确认本条输入，提交状态待核对',
      submission: { sendStatus: 'unknown', submissionId: 'x' } } };
  const model = buildComposerStatusModel(session, { runtime: deriveSessionRuntimeStatus(session) });
  assert.equal(model.text, 'Claude 未确认收到上一条，可直接继续发送');
  assert.equal(model.action, null);
  assert.equal(model.state, 'ready');
  assert.doesNotMatch(model.text + model.detail, /待核对/);
  // An unconfirmed stop is different: sending is gated, so the button stays.
  const stop = { ...session, nativeRuntime: { ...session.nativeRuntime, submission: null, cancellation: { status: 'unknown' } } };
  assert.equal(buildComposerStatusModel(stop, { runtime: deriveSessionRuntimeStatus(stop) }).action?.kind, 'claude-reconcile');
});
