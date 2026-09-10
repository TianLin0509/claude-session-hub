'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ClaudeNativeSession } = require('../core/claude-native-session');

function session(mode = 'normal', options = {}) {
  return new ClaudeNativeSession({ id: 'hub-test', executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures', 'claude-stream.js'), '--fixture=' + mode],
    initializeTimeoutMs: 2000, submissionTimeoutMs: 2000, closeTimeoutMs: 300, ...options });
}
function terminal(s) {
  return new Promise(resolve => s.on('lifecycle', event => { if (event.type === 'agent-turn-complete') resolve(event); }));
}

test('message echo confirms exact input; execution and completion are separate', async t => {
  const s = session(); t.after(() => s.close());
  const events = []; s.on('lifecycle', e => events.push(e));
  const done = terminal(s);
  const text = '  原文\r\n- 一整条 🧪\n```js\n1\n```  '.repeat(600);
  const receipt = await s.submit(text, { clientSubmissionId: 'unique-submission' });
  assert.equal(receipt.sendStatus, 'accepted');
  assert.equal(receipt.providerTurnId, null);
  const end = await done;
  assert.equal(end.status, 'completed');
  assert.equal(end.clientSubmissionId, 'unique-submission');
  assert.equal(end.userMessageId, receipt.userMessageId);
  assert.equal(s.records.get('unique-submission').text, text);
  assert.deepEqual(events.map(e => e.type), ['submission-accepted', 'agent-turn-started', 'agent-turn-complete']);
});

test('old result before new input echo cannot claim a new message', async t => {
  const s = session('old-result-first'); t.after(() => s.close());
  const diagnostics = []; s.on('diagnostic', d => diagnostics.push(d));
  const done = terminal(s); const receipt = await s.submit('next stage');
  const end = await done;
  assert.equal(end.userMessageId, receipt.userMessageId);
  assert.notEqual(end.providerResultId, 'old-result');
  assert.ok(diagnostics.some(d => d.type === 'unmatched-result'));
});

test('same text twice has two identities; same submission ID never sends twice', async t => {
  const s = session(); t.after(() => s.close());
  const firstEnd = terminal(s);
  const first = await s.submit('same', { submissionId: 'one' }); await firstEnd;
  assert.equal((await s.submit('same', { submissionId: 'one' })).sendStatus, 'completed');
  const secondEnd = terminal(s);
  const second = await s.submit('same', { submissionId: 'two' }); await secondEnd;
  assert.notEqual(first.userMessageId, second.userMessageId);
  await assert.rejects(s.submit('different', { submissionId: 'one' }), { code: 'CLAUDE_CONTENT_MISMATCH' });
});

test('busy session queues the next message without making it accepted', async t => {
  const s = session('hold'); t.after(() => s.close());
  const first = await s.submit('A', { submissionId: 'A' });
  const second = await s.submit('B', { submissionId: 'B' });
  assert.equal(second.sendStatus, 'queued');
  assert.equal(s.active.submissionId, 'A');
  assert.equal(s.records.get('B').accepted, false);
  const done = terminal(s); await s.interrupt(); const ended = await done;
  assert.equal(ended.userMessageId, first.userMessageId);
  assert.equal(ended.status, 'interrupted');
  assert.equal(s.active.submissionId, 'B');
});

test('missing echo becomes unknown without retry or advancing queued work', async t => {
  const s = session('no-echo', { submissionTimeoutMs: 40 }); t.after(() => s.close());
  await assert.rejects(s.submit('only once'), { code: 'CLAUDE_SUBMISSION_TIMEOUT' });
  assert.equal(s.runtime.state, 'unknown');
  assert.equal(s.records.size, 1);
  await assert.rejects(s.submit('later'), { code: 'CLAUDE_SUBMISSION_UNKNOWN' });
});

test('body mismatch stays visible and prohibits resend', async t => {
  const s = session('mismatch'); t.after(() => s.close());
  await assert.rejects(s.submit('expected'), { code: 'CLAUDE_CONTENT_MISMATCH' });
  assert.equal(s.runtime.submission.sendStatus, 'content-mismatch');
  assert.equal(s.unreconciled, true);
});

for (const mode of ['foreign-result', 'background-result']) {
  test(mode + ' cannot finish current user submission', async t => {
    const s = session(mode); t.after(() => s.close());
    let completions = 0; s.on('lifecycle', e => { if (e.type === 'agent-turn-complete') completions++; });
    const diagnostic = new Promise(resolve => s.on('diagnostic', d => {
      if (d.type === 'foreign-session' || d.type === 'background-result') resolve();
    }));
    await s.submit('current'); await diagnostic;
    assert.equal(completions, 0);
    assert.ok(s.active);
  });
}

for (const [mode, expected] of [['error-result', 'failed'], ['empty-result', 'completed']]) {
  test(mode + ' has a real terminal state independent of text', async t => {
    const s = session(mode); t.after(() => s.close());
    const done = terminal(s); await s.submit('test');
    assert.equal((await done).status, expected);
  });
}

test('approval uses pending request; denial is returned without bypass', async t => {
  const s = session('approval'); t.after(() => s.close());
  const waiting = new Promise(resolve => s.on('state', state => { if (state.state === 'waiting') resolve(state); }));
  await s.submit('needs permission');
  const state = await waiting;
  assert.equal(state.requests[0].params.toolName, 'Bash');
  const done = terminal(s);
  await s.respond(state.requests[0].id, { behavior: 'deny', message: '拒绝' });
  await done;
  await assert.rejects(s.respond(state.requests[0].id, { behavior: 'allow' }), { code: 'CLAUDE_STALE_REQUEST' });
});

test('failed durable submission never writes input to the engine', async t => {
  let writes = 0;
  const s = session('echo-only', { persistSubmission: async () => { throw new Error('disk full'); } });
  t.after(() => s.close()); await s.start();
  const write = s.client.write.bind(s.client);
  s.client.write = message => { if (message.type === 'user') writes++; return write(message); };
  await assert.rejects(s.submit('must be durable'), /disk full/);
  assert.equal(writes, 0);
  assert.equal(s.runtime.submission.sendStatus, 'rejected');
});

test('crashed process leaves an unconfirmed submission unknown', async t => {
  const s = session('crash-on-user'); t.after(() => s.close());
  await assert.rejects(s.submit('submitted before crash'), /Claude/);
  assert.equal(s.runtime.state, 'unknown');
  assert.equal(s.active.status, 'unknown');
});

test('restored unfinished state is not silently replayed or marked idle', async t => {
  const s = session('normal', { restoredRuntime: { epoch: 4, state: 'running' } });
  t.after(() => s.close()); await s.start();
  assert.equal(s.runtime.epoch, 5);
  assert.equal(s.runtime.state, 'unknown');
  await assert.rejects(s.submit('new'), { code: 'CLAUDE_SUBMISSION_UNKNOWN' });
});

test('queued receipt is durable before returning to the caller', async t => {
  const saved = [];
  const s = session('hold', { persistSubmission: async data => saved.push(data) });
  t.after(() => s.close());
  await s.submit('A', { submissionId: 'a' });
  const queued = await s.submit('B', { submissionId: 'b' });
  assert.equal(queued.sendStatus, 'queued');
  assert.ok(saved.some(data => data.submissionId === 'b' && data.text === 'B' && data.sendStatus === 'queued'));
});

test('tool results are output items, not a second user receipt', async t => {
  const s = session('tool-result'); t.after(() => s.close());
  const items = []; const accepted = [];
  s.on('item', item => items.push(item));
  s.on('lifecycle', e => { if (e.type === 'submission-accepted') accepted.push(e); });
  const done = terminal(s); await s.submit('read'); await done;
  assert.equal(accepted.length, 1);
  assert.ok(items.some(item => item.message.message?.content?.some(block => block.type === 'tool_result')));
});

test('delegated work keeps stream open after the root and preserves its separate follow-up', async t => {
  const s = session('delegated'); t.after(() => s.close());
  const states = []; s.on('state', state => states.push(state.state));
  const background = new Promise(resolve => s.on('diagnostic', d => { if (d.type === 'background-result') resolve(); }));
  const done = terminal(s); await s.submit('delegate'); const end = await done;
  assert.equal(end.result.origin.kind, 'human');
  await background;
  assert.equal(s.tasks.size, 0);
  assert.ok(s.transcript().some(turn => turn.nativeActivity));
  assert.ok(states.includes('running'));
  assert.equal(s.client.closed, false);
});

test('long streams cannot evict completed result identities and let an old result finish the next prompt', async t => {
  const s = session('hold'); t.after(() => s.close());
  await s.submit('A');
  const old = { type: 'result', subtype: 'success', is_error: false, session_id: s.sessionId,
    uuid: 'old-completed-result', origin: { kind: 'human' }, result: 'A answer' };
  s.message(old); await s.submit('B', { submissionId: 'B' });
  for (let i = 0; i < 4100; i++) s.message({ type: 'system', subtype: 'status', uuid: 'noise-' + i, session_id: s.sessionId });
  s.message(old);
  assert.equal(s.active?.submissionId, 'B');
  assert.equal(s.records.get('B').status, 'accepted');
});

test('scheduled-trigger result cannot settle delegated work and task_updated killed is terminal', async t => {
  const s = session('hold'); t.after(() => s.close());
  await s.submit('delegate', { submissionId: 'root' });
  s.message({ type: 'system', subtype: 'task_started', session_id: s.sessionId, task_id: 'one', task_type: 'local_agent' });
  s.message({ type: 'result', subtype: 'success', is_error: false, session_id: s.sessionId, origin: { kind: 'human' } });
  s.message({ type: 'system', subtype: 'task_updated', session_id: s.sessionId, task_id: 'one', patch: { status: 'killed' } });
  assert.equal(s.tasks.size, 0);
  assert.equal(s.records.get('root').status, 'completed');
  await s.submit('next', { submissionId: 'next' });
  s.message({ type: 'result', subtype: 'success', is_error: false, session_id: s.sessionId,
    origin: { kind: 'task-notification', subkind: 'scheduled-trigger' }, result: 'unrelated scheduled answer' });
  assert.ok(s.active);
  s.message({ type: 'result', subtype: 'success', is_error: false, session_id: s.sessionId,
    origin: { kind: 'task-notification' }, result: 'delegated continuation' });
  assert.equal(s.active.submissionId, 'next');
  assert.equal(s.records.get('next').finalText, '');
});

test('closing while a queued message is being persisted cannot return queued success', async t => {
  let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const persisting = new Promise(resolve => { entered = resolve; });
  const s = session('hold', { persistSubmission: async data => {
    if (data.text === 'B') { entered(); await barrier; }
  } });
  t.after(() => s.close());
  await s.submit('A');
  const pending = s.submit('B'); pending.catch(() => undefined);
  await persisting; await s.close(); release();
  await assert.rejects(pending, { code: 'CLAUDE_CLOSED' });
});

test('stop before durable handoff cannot write the prompt after the stop', async t => {
  let release; let entered; let writes = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const persisting = new Promise(resolve => { entered = resolve; });
  const s = session('hold', { persistSubmission: async data => {
    if (data.sendStatus === 'submitting') { entered(); await barrier; }
  } });
  t.after(() => s.close()); await s.start();
  const write = s.client.write.bind(s.client);
  s.client.write = message => { if (message.type === 'user') writes++; return write(message); };
  const pending = s.submit('must not be sent'); pending.catch(() => undefined);
  await persisting; await s.interrupt(); release();
  await assert.rejects(pending, { code: 'CLAUDE_SUBMISSION_CANCELLED' });
  assert.equal(writes, 0);
  assert.equal(s.runtime.state, 'interrupted');
});

test('startup cancellation closes only the owned child and unblocks start', async t => {
  const s = session('no-init'); t.after(() => s.close());
  const starting = s.start(); starting.catch(() => undefined);
  const cancelled = await s.interrupt();
  await assert.rejects(starting, { code: 'CLAUDE_CLOSED' });
  assert.equal(cancelled.cancelledStartup, true);
  assert.equal(s.runtime.state, 'interrupted');
  assert.equal(s.closed, true);
});

test('completion observers see the committed terminal snapshot', async t => {
  const s = session(); t.after(() => s.close());
  const observed = [];
  s.on('lifecycle', e => { if (e.type === 'agent-turn-complete') observed.push(s.runtime.state); });
  const done = terminal(s); await s.submit('finish'); await done;
  assert.deepEqual(observed, ['completed']);
});

test('model change blocks new input until control acknowledgement and rejects changing a busy session', async t => {
  const s = session('hold'); t.after(() => s.close()); await s.start();
  let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const changing = new Promise(resolve => { entered = resolve; });
  const control = s.client.control.bind(s.client);
  s.client.control = async request => {
    if (request.subtype === 'set_model') { entered(); await barrier; }
    return control(request);
  };
  const change = s.setModel('new-model'); await changing;
  const input = s.submit('uses new model');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.records.size, 0);
  release(); await change; await input;
  assert.equal(s.runtime.actualModel, 'new-model');
  await assert.rejects(s.setModel('another-model'), /等待/);
});

test('failed pre-send cancellation journal remains unknown and rejects the pending submit', async t => {
  let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const persisting = new Promise(resolve => { entered = resolve; });
  const s = session('hold', { persistSubmission: async data => {
    if (data.sendStatus === 'submitting') { entered(); await barrier; }
  }, persistLifecycle: event => { if (event.type === 'submission-cancelled') throw new Error('cancel disk full'); } });
  t.after(() => s.close());
  const pending = s.submit('cancelled'); pending.catch(() => undefined);
  await persisting; await s.interrupt(); release();
  await assert.rejects(pending, /cancel disk full/);
  assert.equal(s.runtime.state, 'unknown');
  assert.equal(s.active.status, 'unknown');
});
