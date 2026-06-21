'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-groupchat-'));
const groupchat = require('../core/group-chat-orchestrator.js');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name);
    console.error(e.stack || e.message);
  }
}

function fresh() {
  const meetingId = `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    meetingId,
    orch: groupchat.getOrchestrator(tmp, meetingId),
  };
}

const members = [
  { sid: 's-claude', index: 0, memberId: 'm1', kind: 'claude', model: 'opus', displayName: 'Claude', aliases: ['m1', 'Claude'] },
  { sid: 's-codex', index: 1, memberId: 'm2', kind: 'codex', model: 'gpt-5.5', displayName: 'Codex', aliases: ['m2', 'Codex'] },
];

console.log('--- group chat orchestrator ---');

test('buildSystemPromptText contains required markers and no banned terms', () => {
  const text = groupchat.buildSystemPromptText('TestAI');
  assert.ok(text.includes('这里是AI群聊'), 'missing group-chat scene framing');
  assert.ok(text.includes('可赞同、反对、追问、反问用户及其他群聊队友'), 'missing peer-interaction hint');
  assert.ok(text.includes('独到见解 > 全面但泛泛而谈'), 'missing 独到见解 rule');
  assert.ok(text.includes('简单问题直答'), 'missing simple-answer fast path');
  assert.ok(text.includes('C:\\Users\\lintian\\artifacts\\{msgId}-{name}.html'), 'missing absolute artifact path template');
  assert.ok(text.includes('贴绝对路径'), 'missing recap-step plain-language hint');
  assert.ok(text.includes('你是TestAI'), 'missing self name substitution');
  assert.ok(!text.includes('皮卡丘'), 'hardcoded member name 皮卡丘 leaked');
  assert.ok(!text.includes('小火龙'), 'hardcoded member name 小火龙 leaked');
  assert.ok(!text.includes('杰尼龟'), 'hardcoded member name 杰尼龟 leaked');
  assert.ok(!text.includes('「同意，无补充」'), 'dead rule "同意无补充" should not be in prompt');
  assert.ok(!text.includes('新观点、新数据'), 'redundant 4-type list should be removed');
  assert.ok(!text.includes('## 成员'), 'member table section should not exist');
  assert.ok(!text.includes('同台'), 'stage concept leaked');
  assert.ok(!text.includes('## 投研场景'), 'research prompt should not leak into general group chat');
});

test('buildSystemPromptText appends lightweight research scene prompt only for research scene', () => {
  const general = groupchat.buildSystemPromptText('TestAI', 'general');
  const research = groupchat.buildSystemPromptText('TestAI', 'research');

  assert.ok(!general.includes('## 投研场景'));
  assert.ok(research.includes('## 投研场景'));
  assert.ok(research.includes('优先补充他人未覆盖的角度、证据缺口或反例'));
  assert.ok(research.includes('尽量挖掘新线索、变量或解释路径'));
  assert.ok(research.includes('事实和数字标来源，未查证就说明不确定'));
  assert.ok(research.includes('先问用户 1-2 个会改变结论的问题'));
  assert.ok(research.includes('stock_market(symbol)、stock_news(symbol)'));
  assert.ok(research.includes('stock_static(symbol) 仅在单只核心标的需要估值/基本面画像时再补'));
  assert.ok(research.includes('不要在同一轮对多只股票批量发 static+market'));
  assert.ok(research.includes('120s 工具超时'));
  assert.ok(research.includes('工具不可用或数据缺失时明确说未查到'));
  assert.ok(!research.includes('cli.py analyze'));
  assert.ok(!research.includes('皮卡丘'));
});

test('buildDelta sends only user input when no other assistant messages are new', () => {
  const { orch } = fresh();
  orch.beginTurn('Explain OFDM pilot contamination.');
  const delta = orch.buildDelta('s-claude', 'Explain OFDM pilot contamination.');
  assert.ok(!delta.includes('## 新增发言'));
  assert.match(delta, /^## 用户\nExplain OFDM pilot contamination\.\n\n请发言。$/);
  assert.ok(!delta.includes('## 成员'));
  assert.ok(!delta.includes('历史摘要账本'));
  assert.ok(!delta.includes('raw://group/'));
});

test('buildDelta excludes user messages from added section because current user text is appended at prompt end', () => {
  const { orch } = fresh();
  orch.state.messages = [
    { id: 'u1', role: 'user', speaker: '你', content: 'Q1: 背景问题', sid: null },
    { id: 'a1-claude', role: 'assistant', speaker: 'Claude', content: 'R1: 回答背景问题', sid: 's-claude' },
    { id: 'u2', role: 'user', speaker: '你', content: 'Q2: 当前追问', sid: null },
  ];

  const delta = orch.buildDelta('s-codex', 'Q2: 当前追问');
  const beforeUser = delta.split('## 用户')[0];
  assert.ok(!beforeUser.includes('你：Q1: 背景问题'));
  assert.ok(beforeUser.includes('Claude：R1: 回答背景问题'));
  assert.ok(!beforeUser.includes('Q2: 当前追问'));
  assert.match(delta, /## 用户\nQ2: 当前追问\n\n请发言。$/);
});

test('buildFirstDelta prepends system prompt only before the sid is delivered', () => {
  const { orch } = fresh();
  orch.beginTurn('Hello');
  const sysText = groupchat.buildSystemPromptText('Claude');
  const first = orch.buildFirstDelta('s-claude', 'Hello', sysText);
  assert.ok(first.startsWith(sysText + '\n\n## 用户\nHello'));
  orch.state.lastDeliveredIdx['s-claude'] = orch.state.messages.length - 1;
  const next = orch.buildFirstDelta('s-claude', 'Again', sysText);
  assert.ok(!next.startsWith('## 规则'));
  assert.match(next, /^## 用户\nAgain\n\n请发言。$/);
});

test('completeTurn records assistant messages and delivery indexes without summaries', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Compare OFDMA and SC-FDMA.');
  const turn = orch.completeTurn(turnNum, 'Compare OFDMA and SC-FDMA.', [
    { sid: 's-claude', status: 'completed', text: 'OFDMA is efficient for downlink scheduling.' },
    { sid: 's-codex', status: 'completed', text: 'SC-FDMA lowers uplink PAPR.' },
  ], Object.fromEntries(members.map(m => [m.sid, m])));

  const state = orch.getState();
  assert.strictEqual(turn.meta.dispatchMode, 'group');
  assert.strictEqual(state.summarySegments, undefined);
  assert.strictEqual(turn.meta.summarySegmentId, undefined);
  assert.strictEqual(turn.meta.rawAnchors, undefined);
  assert.strictEqual(state.messages.length, 3);
  assert.strictEqual(state.lastDeliveredIdx['s-claude'], 2);
  assert.strictEqual(state.lastDeliveredIdx['s-codex'], 2);
});

test('completeTurn can preserve prompt-time delivered index so peers see same-turn replies later', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('First question.');
  const deliveredIdx = orch.state.messages.length - 1;
  orch.completeTurn(turnNum, 'First question.', [
    { sid: 's-claude', status: 'completed', text: 'Claude first reply.', deliveredIdx },
    { sid: 's-codex', status: 'completed', text: 'Codex first reply.', deliveredIdx },
  ], Object.fromEntries(members.map(m => [m.sid, m])));

  orch.beginTurn('Second question.');
  const delta = orch.buildDelta('s-claude', 'Second question.');
  assert.match(delta, /## 新增发言\nCodex：Codex first reply\./);
  assert.ok(!delta.includes('Claude first reply.'));
  assert.match(delta, /## 用户\nSecond question\.\n\n请发言。$/);
});

test('serial workflow can reuse one visible turn and one user message for multiple AI answers', () => {
  const { orch } = fresh();
  const first = orch.beginTurn('Same serial question.');
  const deliveredIdx1 = orch.state.messages.length - 1;
  orch.completeTurn(first.turnNum, 'Same serial question.', [
    { sid: 's-claude', status: 'completed', text: 'Claude serial reply.', deliveredIdx: deliveredIdx1 },
  ], Object.fromEntries(members.map(m => [m.sid, m])), {}, { dispatchMode: 'serial' });

  const second = orch.beginTurn('Same serial question.', {
    turnNum: first.turnNum,
    appendUserMessage: false,
  });
  const delta = orch.buildFirstDelta('s-codex', 'Same serial question.', 'SYS', {
    currentUserMessageAppended: second.didAppendUserMessage,
  });
  assert.ok(delta.includes('Claude：Claude serial reply.'));
  assert.ok(!delta.includes('你：Same serial question.'));

  const deliveredIdx2 = orch.state.messages.length - 1;
  orch.completeTurn(first.turnNum, 'Same serial question.', [
    { sid: 's-codex', status: 'completed', text: 'Codex serial reply.', deliveredIdx: deliveredIdx2 },
  ], Object.fromEntries(members.map(m => [m.sid, m])), {}, { dispatchMode: 'serial' });

  const state = orch.getState();
  assert.strictEqual(state.messages.filter(m => m.role === 'user').length, 1);
  assert.strictEqual(state.messages.filter(m => m.role === 'assistant').length, 2);
  assert.strictEqual(state.turns.length, 1);
  assert.strictEqual(state.turns[0].by['s-claude'], 'Claude serial reply.');
  assert.strictEqual(state.turns[0].by['s-codex'], 'Codex serial reply.');
  assert.strictEqual(state.turns[0].meta.dispatchMode, 'serial');
});

test('completeTurn keeps existing answer when a later errored result returns empty text', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Question that gets answered then errors on resend.');
  const deliveredIdx = orch.state.messages.length - 1;
  const bySid = Object.fromEntries(members.map(m => [m.sid, m]));
  // 第一次 claude 正常答完
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-claude', status: 'completed', text: 'Good full answer.', deliveredIdx },
  ], bySid);
  // 重发 / 串行复用同 turn+sid：这次 errored 且空文本，不应抹掉已有答案
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-claude', status: 'errored', text: '', deliveredIdx },
  ], bySid);
  const state = orch.getState();
  assert.strictEqual(state.turns[0].by['s-claude'], 'Good full answer.', 'turn.by 应保留旧答案');
  const msg = state.messages.find(m => m.role === 'assistant' && m.sid === 's-claude');
  assert.strictEqual(msg.content, 'Good full answer.', 'message.content 应保留旧答案');
  assert.strictEqual(state.turns[0].byStatus['s-claude'], 'errored', '状态仍可更新为 errored');
});

test('patchTurnResult updates final turn and raw assistant message without summary ledger', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Convert this HTML to an editable PPT.');
  orch.completeTurn(turnNum, 'Convert this HTML to an editable PPT.', [
    { sid: 's-codex', status: 'completed', text: '' },
  ], { 's-codex': members[1] });

  const patched = orch.patchTurnResult(turnNum, 's-codex', {
    status: 'completed',
    text: 'Use native PowerPoint shapes for each semantic block.',
  });
  const state = orch.getState();
  const raw = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex' && m.turnNum === turnNum);

  assert.ok(patched);
  assert.strictEqual(patched.by['s-codex'], 'Use native PowerPoint shapes for each semantic block.');
  assert.strictEqual(raw.content, 'Use native PowerPoint shapes for each semantic block.');
  assert.strictEqual(raw.status, 'completed');
  assert.strictEqual(state.summarySegments, undefined);
});

test('searchRaw and readRaw expose indexed original messages', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Massive MIMO channel hardening details.');
  orch.completeTurn(turnNum, 'Massive MIMO channel hardening details.', [
    { sid: 's-codex', status: 'completed', text: 'Channel hardening reduces small-scale fading variance.' },
  ], { 's-codex': members[1] });

  const hits = orch.searchRaw('hardening', 10);
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(h => h.anchor && h.anchor.startsWith('raw://group/')));
  const raw = orch.readRaw(hits[0].id);
  assert.ok(raw);
  assert.ok(String(raw.content).toLowerCase().includes('hardening'));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
