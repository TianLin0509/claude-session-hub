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
  assert.ok(text.includes('自由发言：可赞同'), 'missing colon in free-speech rule');
  assert.ok(text.includes('反问用户'), 'missing reverse-ask hint merged into rule 1');
  assert.ok(text.includes('独到 > 全面'), 'missing 独到 rule');
  assert.ok(text.includes('未实际调用不许说"已核实"'), 'missing anti-hallucination rule');
  assert.ok(text.includes('简单问题直答'), 'missing simple-answer fast path');
  assert.ok(text.includes('plan -> .arena'), 'missing arrow before artifact path');
  assert.ok(text.includes('-> recap'), 'missing arrow before recap');
  assert.ok(text.includes('msg-{msgId}-{name}.html'), 'missing file naming template');
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

test('buildDelta keeps historical user messages for a late participant but excludes current user message from added section', () => {
  const { orch } = fresh();
  orch.state.messages = [
    { id: 'u1', role: 'user', speaker: '用户', content: 'Q1: 背景问题', sid: null },
    { id: 'a1-claude', role: 'assistant', speaker: 'Claude', content: 'R1: 回答背景问题', sid: 's-claude' },
    { id: 'u2', role: 'user', speaker: '用户', content: 'Q2: 当前追问', sid: null },
  ];

  const delta = orch.buildDelta('s-codex', 'Q2: 当前追问');
  const beforeUser = delta.split('## 用户')[0];
  assert.ok(beforeUser.includes('用户：Q1: 背景问题'));
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
