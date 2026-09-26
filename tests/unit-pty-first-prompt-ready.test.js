'use strict';
// 2026-09-25 真机：刚启动的 PTY CLI 画出提示符后、输入还没真正就绪时粘贴，
// Codex 只收到最后一个字、Claude 整条丢失。新会话的第一条先等一次就绪；
// 早已在跑的会话（输入框就摆在用户面前）不能被这条等待拖住。
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const watcher = require('../core/group-chat-watcher.js');

function harness({ createdAt, readyAfterChecks }) {
  const sessionManager = new EventEmitter();
  let checks = 0, ready = false, seq = 0;
  const writes = [];
  Object.assign(sessionManager, {
    getSession: sid => ({ id: sid, kind: 'codex', transcriptKind: 'codex', createdAt }),
    getGroupChatReady: () => ready,
    setGroupChatReady(_sid, value) { ready = value; },
    getGroupChatLastActivity: () => writes.length,
    getSessionBuffer: () => '',
    getAgentTurnStartSeq: () => seq,
    writeToSession(sid, data) {
      writes.push({ at: checks, data });
      if (data === '\r') { seq += 1; setImmediate(() => sessionManager.emit('agent-turn-started', { sessionId: sid, seq, signalSource: 'test-ack' })); }
    },
  });
  watcher.init({ sessionManager, transcriptTap: new EventEmitter(),
    cliReadyDetector: { isReady: () => { checks += 1; return checks >= readyAfterChecks; } },
    bracketedPasteSettleMs: 5, agentTurnStartAckMs: 60, agentTurnStartRecoveryMs: 40 });
  return { sessionManager, writes, checks: () => checks, ready: () => ready };
}

test('a freshly spawned CLI is not typed into before it reports ready', async () => {
  const h = harness({ createdAt: Date.now(), readyAfterChecks: 4 });
  const result = await watcher.sendToPty('sid-fresh', '第一条', 'codex', { requireReady: false });
  assert.equal(result.sendStatus, 'ok');
  assert.ok(h.checks() >= 4, 'waited for the ready detector');
  assert.equal(h.writes[0].at >= 4, true, 'nothing was written before ready');
  assert.equal(h.ready(), true, 'readiness is remembered for later sends');
});

test('a long-running session sends immediately even if it was never marked ready', async () => {
  const h = harness({ createdAt: Date.now() - 10 * 60 * 1000, readyAfterChecks: Number.POSITIVE_INFINITY });
  const started = Date.now();
  const result = await watcher.sendToPty('sid-old', '继续', 'codex', { requireReady: false });
  assert.equal(result.sendStatus, 'ok');
  assert.equal(h.checks(), 0);
  assert.ok(Date.now() - started < 3000);
});

test('a startup choice dialog keeps the first prompt unsent instead of feeding it to the dialog', async () => {
  const sessionManager = new EventEmitter();
  const writes = [];
  Object.assign(sessionManager, {
    getSession: sid => ({ id: sid, kind: 'codex', transcriptKind: 'codex', createdAt: Date.now() }),
    getGroupChatReady: () => false, setGroupChatReady() {},
    getGroupChatLastActivity: () => 0, getSessionBuffer: () => '› 1. Try new model\n  press enter to confirm',
    getAgentTurnStartSeq: () => 0, writeToSession: (sid, data) => writes.push(data),
  });
  watcher.init({ sessionManager, transcriptTap: new EventEmitter(), firstPromptReadyMs: 300,
    cliReadyDetector: { isReady: () => false, isChoiceDialogVisible: () => true } });
  await assert.rejects(watcher.sendToPty('sid-dialog', '第一条', 'codex', { requireReady: false }),
    error => error.notSent === true && error.code === 'cli-choice-pending');
  assert.deepEqual(writes, [], 'nothing typed into the dialog');
});
