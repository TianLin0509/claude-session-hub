'use strict';
// 返工 R6：/compact 期间提交的 /clear 要等压缩结束才执行，确认常常晚于 15s 期限。
// 期限内没确认 → 如实报「未确认」；迟到的确认只收敛这一条提交（按 clientSubmissionId），
// 更新命令历史，从不重发。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const watcher = require('../core/group-chat-watcher');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');

function setup(t, { ackMs = 40 } = {}) {
  const original = watcher.sendToPty;
  const writes = [];
  watcher.sendToPty = async (sessionId, text, kind, options) => {
    writes.push(text);
    const confirmation = await options.localCommandObserver.wait(ackMs);
    return { ok: confirmation.ok, sendStatus: confirmation.ok ? 'ok' : 'stuck', message: confirmation.message,
      enterAttempts: 1, acknowledgementSource: 'local-command' };
  };
  t.after(() => { watcher.sendToPty = original; });
  const manager = new EventEmitter();
  manager.getSession = id => ({ id, kind: 'claude', agentRuntime: 'pty', runtimeBackend: null });
  manager.writeToSession = () => {};
  const sent = [], finished = [];
  const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); } };
  const handle = registerPromptSubmitIpc(ipc, {
    sessionManager: manager, transcriptTap: null, sendToRenderer: (ch, payload) => sent.push([ch, payload]),
    logger: { log() {}, warn() {} },
    commandTranscriptStore: { begin: () => ({ duplicate: false }), finish: (sid, id, result) => finished.push([sid, id, result]) },
  });
  t.after(() => handle?.dispose?.());
  const send = (text, id) => ipc.handlers.get('session:send-prompt')({}, { sessionId: 'hub', text, clientSubmissionId: id });
  return { manager, sent, finished, writes, send };
}
const receipts = sent => sent.filter(([ch]) => ch === 'session:prompt-receipt').map(([, p]) => p);

test('a /clear confirmed after the deadline clears exactly its own resend prompt', async t => {
  const { manager, sent, finished, writes, send } = setup(t);
  const result = await send('/clear', 'sub-clear');
  assert.equal(result.ok, false);
  assert.equal(result.unconfirmed, true, 'a missed deadline is unknown, not failed');
  assert.equal(receipts(sent).length, 0);
  // 压缩结束后 /clear 才真正执行，身份切换姗姗来迟。
  manager.emit('claude-identity-switched', { sessionId: 'other-hub', to: 'x' });
  manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'new-id' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(receipts(sent), [{ sessionId: 'hub', clientSubmissionId: 'sub-clear', status: 'confirmed', source: 'late-local-command-ack' }]);
  assert.deepEqual(finished.at(-1).slice(0, 2), ['hub', 'sub-clear']);
  assert.equal(finished.at(-1)[2].ok, true, 'command history records the late success');
  assert.deepEqual(writes, ['/clear'], 'never re-sent');
  assert.deepEqual(require('../core/claude-local-command-acks').localCommandAcksFor(manager).pending('hub', 'clear'), [], 'ticket released after the late confirmation');
});

test('a late /compact confirmation does not touch a later, genuinely different submission', async t => {
  const { manager, sent, send } = setup(t);
  await send('/compact', 'sub-compact');
  await send('/clear', 'sub-clear');
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['sub-compact'], 'only the compact submission converges');
});

test('confirmation within the deadline needs no late receipt; ordinary prompts are unaffected', async t => {
  const { manager, sent, send } = setup(t, { ackMs: 2000 });
  setTimeout(() => manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'n' }), 30);
  const result = await send('/clear', 'sub-fast');
  assert.equal(result.ok, true);
  assert.equal(result.unconfirmed, undefined);
  assert.equal(receipts(sent).length, 0);
  assert.deepEqual(require('../core/claude-local-command-acks').localCommandAcksFor(manager).pending('hub', 'clear'), []);
});

// ---- 第 5 轮 R7：一个确认只能收敛一条提交（同类命令排队、执行周期去重、参数对应）----

test('reviewer repro: one legacy compact ack confirms only the earliest of two different /compact submissions', async t => {
  const { manager, sent, send } = setup(t);
  await send('/compact preserve first topic', 'first');
  await send('/compact preserve second topic', 'second');
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['first']);
});

test('PreCompact with custom_instructions confirms the submission with those arguments, not the oldest one', async t => {
  const { manager, sent, send } = setup(t);
  await send('/compact preserve first topic', 'first');
  await send('/compact  preserve   second topic', 'second');
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'start', cycleId: 'p2', args: 'preserve second topic', trigger: 'manual' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['second'], 'matched by arguments (whitespace-normalised)');
  // 参数对不上任何等待中的提交：证据不足，不确认。
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'start', cycleId: 'p3', args: 'something else', trigger: 'manual' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['second']);
});

test('one execution cycle confirms one submission: the matching SessionStart(compact) cannot confirm the next', async t => {
  const { manager, sent, send } = setup(t);
  await send('/compact', 'c1');
  await send('/compact', 'c2');
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'start', cycleId: 'P', args: '', trigger: 'manual' });
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'end', cycleId: 'P' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['c1'], 'PreCompact + SessionStart of cycle P confirm only c1');
  // 一个只有结束、没有开始的周期：证据不足，不确认。
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'end', cycleId: 'Q' });
  // 自动压缩不是用户命令。
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'start', cycleId: 'A', args: '', trigger: 'auto' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['c1']);
  // 下一个真正的新周期才收敛 c2。
  manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact', phase: 'start', cycleId: 'R', args: '', trigger: 'manual' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['c1', 'c2']);
});

test('two queued /clear: one identity switch confirms only the first; /resume switches confirm none', async t => {
  const { manager, sent, send } = setup(t);
  await send('/clear', 'k1');
  await send('/clear', 'k2');
  manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'a', source: 'clear', cycleId: 'q1' });
  manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'a', source: 'clear', cycleId: 'q1' }); // 同一周期的重复
  manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'b', source: 'resume', cycleId: 'q2' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['k1']);
  manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'c', source: 'clear', cycleId: 'q3' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent).map(r => r.clientSubmissionId), ['k1', 'k2']);
});

test('signals for another session never confirm this session', async t => {
  const { manager, sent, send } = setup(t);
  await send('/compact', 'mine');
  manager.emit('claude-local-command-ack', { sessionId: 'other', command: 'compact', phase: 'start', cycleId: 'x', args: '', trigger: 'manual' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(receipts(sent), []);
});
