'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { NativeAgentJournal } = require('../core/native-agent-journal');
const { findNativeClaudeHistory, renameNativeClaudeHistory } = require('../core/claude-native-history');
const fixture = path.join(__dirname, 'fixtures', 'claude-stream.js');

test('explicit recovery preserves unknown identity, rejects stale UI, and never replays it after restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reconcile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = new NativeAgentJournal({ directory, sessionId: 'hub' });
  const s = new ClaudeNativeSession({ executable: process.execPath, commandArgs: [fixture, '--fixture=crash-on-user'],
    persistSubmission: row => journal.saveSubmission(row), persistLifecycle: row => journal.saveLifecycle(row) });
  t.after(() => s.close());
  await assert.rejects(s.submit('原文\n  不丢失', { submissionId: 'old' }));
  const oldClient = s.client; const oldIdentity = s.recoveryRecords()[0];
  s.options.commandArgs = [fixture, '--fixture=hold'];
  await s.reconnect();
  assert.equal(s.runtime.state, 'unknown'); assert.equal(s.runtime.epoch, 2);
  assert.equal(s.recoveryRecords()[0].userMessageId, oldIdentity.userMessageId);
  await assert.rejects(s.submit('new before reconcile'), { code: 'CLAUDE_SUBMISSION_UNKNOWN' });
  const revision = s.runtime.revision;
  oldClient.emit('disconnect', new Error('late old epoch')); oldClient.emit('message', { type: 'system', subtype: 'init', model: 'wrong' });
  assert.equal(s.runtime.revision, revision);
  assert.throws(() => s.reconcile({ ...oldIdentity, resolution: 'do-not-replay' }), { code: 'CLAUDE_STALE_RECONCILIATION' });
  s.reconcile({ ...s.recoveryRecords()[0], resolution: 'do-not-replay' });
  assert.equal(s.runtime.state, 'idle'); assert.equal(s.records.get('old').status, 'unknown');
  const oldPid = s.pid; await s.close();
  const restored = new ClaudeNativeSession({ ...s.options, restoredRuntime: { ...s.runtime, state: 'unknown', childPid: oldPid },
    restoredRecords: new NativeAgentJournal({ directory, sessionId: 'hub' }).list(), sessionId: s.sessionId });
  t.after(() => restored.close());
  await restored.start();
  assert.equal(restored.unreconciled, false);
  assert.equal((await restored.submit('原文\n  不丢失', { submissionId: 'old' })).sendStatus, 'unknown');
  assert.equal(restored.active, null);
  const next = await restored.submit('新的任务', { submissionId: 'new' });
  assert.equal(next.sendStatus, 'accepted');
  assert.notEqual(next.userMessageId, oldIdentity.userMessageId);
});

test('reconnect does not open a second writer if closing the owned transport fails', async t => {
  const s = new ClaudeNativeSession({ executable: process.execPath, commandArgs: [fixture, '--fixture=normal'] });
  t.after(() => s.close()); await s.start();
  const client = s.client; const close = client.close.bind(client);
  client.close = async () => { throw new Error('owned writer still alive'); };
  await assert.rejects(s.reconnect(), /still alive/);
  assert.equal(s.client, client); assert.equal(s.runtime.connection, 'disconnected');
  assert.equal(s.runtime.recoveryReady, false);
  client.close = close;
});

test('restart owns the interrupt gap and cannot send a queued or new prompt before reconnect', async t => {
  const s = new ClaudeNativeSession({ executable: process.execPath, commandArgs: [fixture, '--fixture=hold'] });
  t.after(() => s.close()); await s.submit('A', { submissionId: 'A' });
  await s.submit('B', { submissionId: 'B' });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const interrupt = s.interrupt.bind(s); s.interrupt = () => gate.then(interrupt);
  const restart = s.reconnect({ stopActive: true });
  await assert.rejects(s.reconnect({ stopActive: true }), /重连/);
  await assert.rejects(s.submit('C'), { code: 'CLAUDE_RECONNECTING' });
  release(); await restart;
  assert.equal(s.records.get('B').writeStarted, undefined);
  assert.equal(s.records.get('B').status, 'unknown');
  assert.equal(s.active, null);
});

test('a live previous Hub owner blocks native takeover without stopping it', async t => {
  const s = new ClaudeNativeSession({ executable: process.execPath, commandArgs: [fixture],
    restoredRuntime: { state: 'completed', epoch: 2, ownerPid: process.ppid, childPid: null } });
  t.after(() => s.close());
  await assert.rejects(s.start(), { code: 'CLAUDE_WRITER_ACTIVE' });
  assert.equal(s.client, null);
});

test('native history follows explicit Claude config root and exact UUID across project buckets', t => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'native-history-'));
  t.after(() => fs.rmSync(config, { recursive: true, force: true }));
  const id = randomUUID(); const directory = path.join(config, 'projects', 'old-cwd');
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, id + '.jsonl');
  fs.writeFileSync(file, '{}\n');
  assert.equal(findNativeClaudeHistory(id, { cwd: config, env: { CLAUDE_CONFIG_DIR: config } }), file);
  assert.equal(findNativeClaudeHistory(randomUUID(), { cwd: config, env: { CLAUDE_CONFIG_DIR: config } }), null);
});

test('native rename appends official metadata without creating or rewriting conversation history', t => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'native-rename-'));
  t.after(() => fs.rmSync(config, { recursive: true, force: true }));
  const id = randomUUID(); const options = { cwd: config, env: { CLAUDE_CONFIG_DIR: config } };
  assert.deepEqual(renameNativeClaudeHistory(id, ' 新名称 ', options), { status: 'deferred' });
  assert.equal(fs.existsSync(path.join(config, 'projects')), false);
  assert.throws(() => renameNativeClaudeHistory(id, '  ', options));
  const directory = path.join(config, 'projects', 'old-project'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, id + '.jsonl');
  const history = JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: '保留正文' } }) + '\n';
  fs.writeFileSync(file, history, 'utf8');
  assert.equal(renameNativeClaudeHistory(id, ' 新名称 ', options).status, 'synced');
  assert.equal(fs.readFileSync(file, 'utf8'), history + JSON.stringify({ type: 'custom-title', customTitle: '新名称', sessionId: id }) + '\n');
});

test('a live old Hub may release one session without exiting; stale PID alone is not ownership', async t => {
  const ownership = require('../core/native-session-ownership');
  const original = ownership.assertNoOtherHubOwner;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-released-owner-'));
  const options = { ownership: true, nativeProvider: 'claude', executable: process.execPath,
    commandArgs: [fixture, '--fixture=hold'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_HUB_DATA_DIR: directory },
    restoredRuntime: { state: 'completed', epoch: 2, ownerPid: process.ppid, childPid: null } };
  const denied = new ClaudeNativeSession(options), allowed = new ClaudeNativeSession(options);
  t.after(async () => { ownership.assertNoOtherHubOwner = original;
    await denied.close(); await allowed.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  ownership.assertNoOtherHubOwner = async () => ({ checkedPids: [] });
  await assert.rejects(denied.start(), { code: 'CLAUDE_WRITER_ACTIVE' });
  ownership.assertNoOtherHubOwner = async () => ({ checkedPids: [process.ppid] });
  await allowed.start();
  assert.equal(allowed.runtime.connection, 'connected');
});

test('two Claude drivers cannot claim the same provider session and takeover waits for release', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-writer-owner-'));
  const options = { id: 'card', ownership: true, nativeProvider: 'claude', sessionId: randomUUID(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_HUB_DATA_DIR: directory },
    executable: process.execPath, commandArgs: [fixture, '--fixture=hold'] };
  const first = new ClaudeNativeSession(options), second = new ClaudeNativeSession(options);
  t.after(async () => { await first.close(); await second.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await first.start();
  await assert.rejects(second.start(), /另一个进程/);
  assert.equal(second.client, null);
  await first.close();
  await second.reconnect();
  assert.equal(second.runtime.connection, 'connected');
  assert.equal(second.sessionId, options.sessionId);
});
