'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClaudeNativeSession } = require('../core/claude-native-session');

function create(t) {
  const s = new ClaudeNativeSession({ id: 'background-test', executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js'), '--fixture=hold'], closeTimeoutMs: 300 });
  t.after(() => s.close());
  return s;
}
function frame(s, value) { s.message({ uuid: randomUUID(), session_id: s.sessionId, ...value }); }
function answer(s, text, extra = {}) { frame(s, { type: 'assistant', message: { id: randomUUID(),
  role: 'assistant', content: [{ type: 'text', text }] }, ...extra }); }
function result(s, origin = { kind: 'human' }, text = 'root answer') {
  frame(s, { type: 'result', subtype: 'success', is_error: false, origin, result: text });
}
function inject(s, kind, text = 'background input') {
  frame(s, { type: 'user', origin: { kind }, message: { role: 'user', content: text } });
}

test('a human result ends that submission even when a delegated task settled before it', async t => {
  const s = create(t); await s.submit('foreground', { submissionId: 'human' });
  frame(s, { type: 'system', subtype: 'task_started', task_id: 'agent', task_type: 'local_agent' });
  frame(s, { type: 'system', subtype: 'task_updated', task_id: 'agent', patch: { status: 'completed' } });
  result(s);
  assert.equal(s.records.get('human').status, 'completed');
  assert.equal(s.runtime.state, 'completed');
  assert.equal(s.client.closed, false);
});

test('a background continuation never settles or supplies text for a later human submission', async t => {
  const s = create(t); const ends = []; s.on('lifecycle', e => { if (e.type === 'agent-turn-complete') ends.push(e); });
  await s.submit('A', { submissionId: 'A' });
  frame(s, { type: 'system', subtype: 'task_started', task_id: 'agent', task_type: 'local_agent' });
  result(s);
  assert.equal(s.runtime.state, 'running');
  assert.equal(s.runtime.backgroundTasks.length, 1);
  await s.submit('B', { submissionId: 'B' });
  inject(s, 'task-notification'); answer(s, 'answer to background task');
  frame(s, { type: 'system', subtype: 'task_notification', task_id: 'agent', status: 'completed' });
  result(s, { kind: 'task-notification' }, 'answer to background task');
  assert.equal(ends.length, 1);
  assert.equal(s.active.submissionId, 'B');
  assert.equal(s.records.get('B').finalText, '');
  const cards = s.transcript();
  assert.ok(cards.some(card => card.nativeActivity && card.text === 'answer to background task'));
  assert.ok(!cards.some(card => card.id === s.active.userMessageId + ':assistant' && card.text.includes('background')));
  answer(s, 'B answer'); result(s, { kind: 'human' }, 'B answer');
  assert.deepEqual(ends.map(e => [e.clientSubmissionId, e.text]), [['A', 'root answer'], ['B', 'B answer']]);
});

test('injected activity remains visible after the human result and survives its own durable snapshot', async t => {
  const s = create(t); const saved = []; s.options.persistActivity = value => saved.push(value);
  await s.submit('A'); result(s);
  inject(s, 'channel'); answer(s, 'channel answer');
  assert.equal(s.runtime.state, 'running');
  result(s, { kind: 'channel' }, 'channel answer');
  assert.equal(s.runtime.state, 'completed');
  assert.equal(saved.at(-1).status, 'completed');
  const recovered = new ClaudeNativeSession({ restoredActivities: saved.slice(-1) });
  assert.ok(recovered.transcript().some(card => card.nativeActivity && card.text === 'channel answer'));
});

test('late child tool output is routed to its spawning submission instead of the active human', async t => {
  const s = create(t); await s.submit('A', { submissionId: 'A' });
  frame(s, { type: 'assistant', message: { id: 'spawn', role: 'assistant', content: [
    { type: 'tool_use', id: 'agent-call', name: 'Agent', input: {} }] } });
  result(s); await s.submit('B', { submissionId: 'B' });
  answer(s, 'late child text', { parent_tool_use_id: 'agent-call' });
  assert.equal(s.records.get('B').messages?.size || 0, 0);
  assert.ok([...s.records.get('A').messages.values()].some(m => m.parent_tool_use_id === 'agent-call'));
});

test('background permission remains pending when the human result arrives', async t => {
  const s = create(t); await s.submit('A'); inject(s, 'channel');
  s.request({ request_id: 'background-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash',
    tool_use_id: 'background-bash', input: { command: 'controlled fixture' } } });
  result(s);
  assert.equal(s.runtime.requests.length, 1);
  assert.equal(s.runtime.requests[0].submissionId, null);
  assert.ok(s.runtime.requests[0].activityId);
  assert.equal(s.runtime.state, 'waiting');
});

test('unknown background activity requires explicit reconciliation and is never replayed', async t => {
  const s = create(t); await s.start(); inject(s, 'channel');
  s.disconnect(new Error('controlled disconnect'));
  await s.reconnect();
  assert.equal(s.runtime.state, 'unknown');
  const pending = s.recoveryRecords();
  assert.equal(pending.length, 1); assert.equal(pending[0].nativeActivity, true);
  await assert.rejects(s.submit('new'), { code: 'CLAUDE_SUBMISSION_UNKNOWN' });
  s.reconcile({ ...pending[0], resolution: 'do-not-replay' });
  assert.equal(s.runtime.state, 'idle');
  assert.equal(s.activities.records.values().next().value.status, 'unknown');
  assert.equal((await s.submit('new')).sendStatus, 'accepted');
});

test('stop addresses known background tasks without inventing their terminal status', async t => {
  const s = create(t); await s.submit('A');
  frame(s, { type: 'system', subtype: 'task_started', task_id: 'agent', task_type: 'local_agent' }); result(s);
  const calls = []; const control = s.client.control.bind(s.client);
  s.client.control = request => { calls.push(request); return control(request); };
  await s.interrupt();
  assert.ok(calls.some(r => r.subtype === 'stop_task' && r.task_id === 'agent'));
  assert.equal(s.tasks.size, 1);
  frame(s, { type: 'system', subtype: 'task_updated', task_id: 'agent', patch: { status: 'killed' } });
  assert.equal(s.tasks.size, 0);
});

test('a completed user receipt does not erase an unfinished task on Hub restart', async t => {
  const s = create(t); await s.submit('A');
  frame(s, { type: 'system', subtype: 'task_started', task_id: 'still-running', task_type: 'local_agent' }); result(s);
  const snapshot = { ...s.runtime }; await s.close();
  const recovered = new ClaudeNativeSession({ executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js'), '--fixture=hold'],
    sessionId: s.sessionId, restoredRuntime: snapshot, closeTimeoutMs: 300 });
  t.after(() => recovered.close());
  await recovered.start();
  assert.equal(recovered.runtime.state, 'unknown');
  assert.equal(recovered.recoveryRecords().length, 1);
  await recovered.reconnect();
  recovered.reconcile({ ...recovered.recoveryRecords()[0], resolution: 'do-not-replay' });
  assert.equal(recovered.runtime.state, 'idle');
});

test('an injected input acknowledgement does not steal the still-running human output segment', async t => {
  const s = create(t); await s.submit('A', { submissionId: 'A' });
  answer(s, 'human prefix');
  inject(s, 'channel');
  answer(s, 'human suffix before human result');
  result(s, { kind: 'human' }, 'human final');
  answer(s, 'channel response'); result(s, { kind: 'channel' }, 'channel final');
  const humanFrames = [...s.records.get('A').messages.values()].map(m => m.message.content[0].text);
  const backgroundFrames = [...s.activities.records.values()][0].messages;
  assert.deepEqual(humanFrames, ['human prefix', 'human suffix before human result']);
  assert.deepEqual([...backgroundFrames.values()].map(m => m.message.content[0].text), ['channel response']);
});
