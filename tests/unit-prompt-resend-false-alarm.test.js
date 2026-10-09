'use strict';
// 「暂未确认 agent 收到消息，请核对后台或点击补发」误报（2026-10-10 用户反馈：经常出现、很烦）。
//
// 下方输入框的发送带「提交回执」：只认 CLI 回报的逐字原文。AI 还在回答时新消息会排队，
// 回报要等上一轮结束；长粘贴、改写过的文本也对不上 —— 于是消息明明进去了，却亮「补发」。
// 规则改为：只有正向证据才报卡住。
//   - 原文已离开输入框、屏幕在跑 → 记「已送达」（不提示、不补回车）；逐字回报到达仍会升级为「已确认」；
//   - 原文 / 折叠标记还在输入框 → 照旧补一次回车，仍无确认就报卡住；
//   - 屏幕完全没动 → 照旧报卡住。
const assert = require('assert');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const watcher = require(path.join(root, 'core', 'group-chat-watcher.js'));
const { PromptSubmissionReceipts } = require(path.join(root, 'core', 'prompt-submission-receipts.js'));
const { applyPromptReceipt, beginPromptDelivery } = require(path.join(root, 'renderer', 'prompt-delivery-state.js'));

function harness({ screenReadsRunning, pendingText = null }) {
  let enters = 0;
  class SM extends EventEmitter {
    constructor() { super(); this.setMaxListeners(0); this.buf = ''; }
    getSession() { return { id: 's', transcriptKind: 'claude', kind: 'claude', cwd: process.cwd() }; }
    getGroupChatReady() { return true; }
    setGroupChatReady() {}
    getGroupChatLastActivity() { return Date.now(); }
    getGroupChatOutputBytes() { return this.buf.length; }
    getAgentTurnStartSeq() { return 0; }
    getSessionBuffer() { return this.buf; }
    writeToSession(sid, data) {
      if (data === '\r') enters += 1;
      // 永远不发逐字回报：只靠屏幕区分几种情形。
      let frame = screenReadsRunning ? '\n✻ Thinking… (3s · esc to interrupt)\n' : '\n> \n';
      if (pendingText !== null) frame = '\x1b[2J\x1b[H' + frame.replace(/\n/g, '\r\n') + `> ${pendingText}\r\n`;
      this.buf += frame;
      this.emit('output', { sessionId: sid, data: frame });
    }
  }
  watcher.init({ sessionManager: new SM(), transcriptTap: new EventEmitter(), cliReadyDetector: { isReady: () => true },
    agentTurnStartAckMs: 150, agentTurnStartRecoveryMs: 150, enableSendDiagnostics: true });
  const updates = [];
  const receipts = new PromptSubmissionReceipts(u => updates.push(u));
  return { receipts, updates, get enters() { return enters; } };
}

async function send(h, prompt) {
  const receipt = h.receipts.begin('s', 'submission-1', prompt, Date.now() - 10);
  const result = await watcher.sendToPty('s', prompt, 'claude', { submissionReceipt: receipt });
  h.receipts.finish(receipt, result);
  return { result, receipt };
}

test('message left the input box while the agent is busy: delivered, no resend prompt, no extra Enter', async () => {
  const h = harness({ screenReadsRunning: true });
  const { result, receipt } = await send(h, '帮我再补充一下第二部分');
  assert.strictEqual(h.enters, 1, '已经在跑的 TUI 不能再按回车');
  assert.notStrictEqual(result.sendStatus, 'stuck', '原文离开输入框、屏幕在跑，不该提示补发');
  assert.strictEqual(result.acknowledgementSource, 'pty-input-cleared');
  assert.strictEqual(receipt.status, 'delivered', '记作已送达，而不是已确认');
  assert.strictEqual(receipt.started, false, '已送达不等于逐字确认');
  // 之后逐字回报到达：升级为已确认。
  assert.strictEqual(h.receipts.observe({ sessionId: 's', text: '帮我再补充一下第二部分', submittedAt: Date.now(), signalSource: 'claude-user-prompt-submit' }), true);
  assert.strictEqual(receipt.status, 'confirmed');
  // 渲染层：已送达不亮补发横幅（markFloatingInputStuck 把 delivered 当作无需提示）。
  const state = beginPromptDelivery('submission-1');
  assert.strictEqual(applyPromptReceipt(state, { clientSubmissionId: 'submission-1', status: 'delivered' }), true);
  assert.strictEqual(state.status, 'delivered');
});

test('the prompt still sitting in the input box is a real failure: one recovery Enter, then stuck', async () => {
  const prompt = '请检查这次发送';
  const h = harness({ screenReadsRunning: true, pendingText: prompt });
  const { result, receipt } = await send(h, prompt);
  assert.strictEqual(h.enters, 2, '原文还在输入框：补一次回车');
  assert.strictEqual(result.sendStatus, 'stuck');
  assert.strictEqual(receipt.status, 'unconfirmed', '仍提示补发');
});

test('a screen that never moved is still reported', async () => {
  const h = harness({ screenReadsRunning: false });
  const { result, receipt } = await send(h, 'x'.repeat(200));
  assert.strictEqual(result.sendStatus, 'stuck');
  assert.strictEqual(receipt.status, 'unconfirmed');
});

test('renderer: delivered receipts never raise the resend banner', () => {
  const src = require('fs').readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /\['pending', 'confirmed', 'delivered', 'queued'\]\.includes\(delivery\.status\)/);
  assert.match(src, /\['confirmed', 'delivered', 'queued'\]\.includes\(state\.status\)\) clearFloatingInputStuck\(bar\)/);
});
