'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const watcher = require('../core/group-chat-watcher.js');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers.js');

function createFakeIpc() {
  const handlers = new Map();
  return { handlers, handle(channel, fn) { handlers.set(channel, fn); } };
}

const quietLogger = { warn() {}, log() {} };

// 真实 sessionManager 的最小替身：够 sendToPty 的快路径跑完，
// 并把每次 writeToSession 记成带会话归属的时间线，方便验证串行化。
function createHarness({ kind = 'claude', ackOnEnter = 1 } = {}) {
  const sessionManager = new EventEmitter();
  const timeline = [];
  const enters = new Map();
  const seqs = new Map();
  let activity = 0;
  Object.assign(sessionManager, {
    getSession: sid => (sid.startsWith('gone') ? null : { id: sid, kind, transcriptKind: kind }),
    getGroupChatReady: () => false,   // 故意为 false：验证 requireReady:false 真的跳过冷启动
    setGroupChatReady() {},
    getGroupChatLastActivity: () => activity,
    getSessionBuffer: () => '',
    getAgentTurnStartSeq: sid => seqs.get(sid) || 0,
    writeToSession(sid, data) {
      activity += 1;
      timeline.push({ sid, data });
      if (data !== '\r') return;
      const count = (enters.get(sid) || 0) + 1;
      enters.set(sid, count);
      if (count !== ackOnEnter) return;
      const seq = (seqs.get(sid) || 0) + 1;
      seqs.set(sid, seq);
      setImmediate(() => sessionManager.emit('agent-turn-started', {
        sessionId: sid, seq, signalSource: 'test-ack',
      }));
    },
  });
  watcher.init({
    sessionManager,
    transcriptTap: new EventEmitter(),
    cliReadyDetector: { isReady: () => false },  // 若真去等 ready，就会卡满 60s 暴露问题
    bracketedPasteSettleMs: 5,
    agentTurnStartAckMs: 60,
    agentTurnStartRecoveryMs: 40,
  });
  const ipc = createFakeIpc();
  registerPromptSubmitIpc(ipc, { sessionManager, logger: quietLogger });
  return { sessionManager, ipc, timeline, enters };
}

test('an AI session goes through the closed loop and reports the acknowledgement', async () => {
  const h = createHarness({ kind: 'claude', ackOnEnter: 1 });
  const started = Date.now();
  const result = await h.ipc.handlers.get('session:send-prompt')(null, {
    sessionId: 'sid-1', text: '写一段自检脚本',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'closed-loop');
  assert.equal(result.sendStatus, 'ok');
  assert.equal(result.acknowledgementSource, 'test-ack');
  assert.equal(result.enterAttempts, 1, '拿到确认就不该补第二次回车');
  // requireReady:false 生效的证据：cliReadyDetector 永远返回 false，
  // 若还走冷启动这里会是 60s 而不是毫秒级。
  assert.ok(Date.now() - started < 5000, '普通会话不得走 60s 冷启动 ready 轮询');
});

test('a missing acknowledgement surfaces as stuck instead of silent success', async () => {
  const h = createHarness({ kind: 'claude', ackOnEnter: Number.POSITIVE_INFINITY });
  const result = await h.ipc.handlers.get('session:send-prompt')(null, {
    sessionId: 'sid-2', text: 'x'.repeat(200),
  });
  assert.equal(result.ok, true);
  assert.equal(result.sendStatus, 'stuck', '没等到语义确认必须如实上报，前端才能亮补发按钮');
  assert.equal(result.enterAttempts, 2, '一次首发 + 一次有界补发');
});

test('a plain shell session bypasses the paste machinery entirely', async () => {
  const h = createHarness({ kind: 'powershell' });
  const result = await h.ipc.handlers.get('session:send-prompt')(null, {
    sessionId: 'sid-shell', text: 'Get-Date',
  });
  assert.equal(result.mode, 'plain-shell');
  assert.deepEqual(h.timeline, [{ sid: 'sid-shell', data: 'Get-Date\r' }],
    '宿主 shell 没有 paste-detect，多等一秒都是纯损失');
});

test('concurrent sends on one session serialize instead of interleaving chunks', async () => {
  // 分块投喂引入的新风险：两条 payload 并发写同一个 PTY 会交错成乱码。
  const h = createHarness({ kind: 'codex', ackOnEnter: 1 });
  const send = h.ipc.handlers.get('session:send-prompt');
  const a = 'A'.repeat(9000);
  const b = 'B'.repeat(9000);
  const [ra, rb] = await Promise.all([
    send(null, { sessionId: 'sid-race', text: a }),
    send(null, { sessionId: 'sid-race', text: b }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  const stream = h.timeline.filter(w => w.sid === 'sid-race').map(w => w.data).join('');
  const firstA = stream.indexOf('A');
  const lastA = stream.lastIndexOf('A');
  const firstB = stream.indexOf('B');
  const lastB = stream.lastIndexOf('B');
  assert.ok(firstA >= 0 && firstB >= 0, '两条 payload 都要写出去');
  const disjoint = lastA < firstB || lastB < firstA;
  assert.ok(disjoint, '两条 payload 的字节区间不得交错');
});

test('different sessions still run in parallel', async () => {
  const h = createHarness({ kind: 'claude', ackOnEnter: 1 });
  const send = h.ipc.handlers.get('session:send-prompt');
  const results = await Promise.all(
    Array.from({ length: 6 }, (_v, i) => send(null, { sessionId: `sid-p${i}`, text: `prompt ${i}` })),
  );
  assert.equal(results.filter(r => r.ok && r.sendStatus === 'ok').length, 6);
});

test('resend replays the remembered prompt and refuses when there is nothing to replay', async () => {
  const h = createHarness({ kind: 'claude', ackOnEnter: 1 });
  const send = h.ipc.handlers.get('session:send-prompt');
  const resend = h.ipc.handlers.get('session:resend-prompt');

  assert.deepEqual(await resend(null, { sessionId: 'sid-r' }), { ok: false, error: 'no-prompt' },
    '没发过东西就点补发，不能凭空提交一个空输入框');

  await send(null, { sessionId: 'sid-r', text: '第一行标题\n正文若干' });
  const result = await resend(null, { sessionId: 'sid-r' });
  assert.equal(result.ok, true);
  assert.ok(['enter_only', 'rewrite_full'].includes(result.mode));
});

test('bad requests and dead sessions are rejected, not written blindly', async () => {
  const h = createHarness();
  const send = h.ipc.handlers.get('session:send-prompt');
  assert.equal((await send(null, { sessionId: '', text: 'x' })).error, 'bad-request');
  assert.equal((await send(null, { sessionId: 'sid', text: '' })).error, 'bad-request');
  assert.equal((await send(null, { sessionId: 'gone-1', text: 'x' })).error, 'no-session');
  assert.equal(h.timeline.length, 0, '任何一条非法请求都不该产生 PTY 写入');
});
