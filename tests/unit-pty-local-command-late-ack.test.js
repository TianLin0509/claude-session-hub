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
  assert.equal(manager.listenerCount('claude-identity-switched'), 0, 'observer released after the late confirmation');
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
  assert.equal(manager.listenerCount('claude-identity-switched'), 0);
});
