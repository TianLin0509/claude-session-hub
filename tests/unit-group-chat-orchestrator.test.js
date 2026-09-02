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
  // 2026-07-28：产物落点跟着 workspace 走。原断言写死 C:\Users\lintian\artifacts\，
  // 等于把「三家 AI 都把报告写回 home」这个 bug 锁成了正确行为。
  assert.ok(text.includes('{msgId}-{name}.html'), 'missing artifact filename template');
  assert.ok(!text.includes('C:\\Users\\lintian\\artifacts'),
    'artifact path must not hardcode the home artifacts dir — it defeats the workspace split');
  assert.ok(text.includes('当前工作目录下的 artifacts\\'),
    'without an explicit workspace the prompt should fall back to a cwd-relative path');
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

test('artifact path follows the meeting workspace when one is set', () => {
  const ws = 'C:\\Vibe\\AI\\AI-HUB-工作区重构与机制排查';
  const text = groupchat.buildSystemPromptText('TestAI', 'general', { workspace: ws });
  assert.ok(text.includes(`${ws}\\artifacts\\{msgId}-{name}.html`),
    'artifact path should be rooted at the meeting workspace');
  assert.ok(!text.includes('C:\\Users\\lintian\\artifacts'), 'home artifacts dir leaked back in');
  // 尾部斜杠不该造成双斜杠
  const withSlash = groupchat.buildSystemPromptText('TestAI', 'general', { workspace: ws + '\\' });
  assert.ok(!withSlash.includes('\\\\artifacts'), 'trailing separator must not double up');
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

test('markDeliveredSilent sets lastDeliveredIdx and writes no messages (no per-act system prompt resend)', () => {
  const { orch } = fresh();
  const before = orch.state.messages.length;
  orch.markDeliveredSilent([{ sid: 's-claude' }, { sid: 's-codex' }]);
  assert.strictEqual(orch.state.messages.length, before, 'silent 标记不写 messages');
  assert.strictEqual(orch.state.lastDeliveredIdx['s-claude'], before - 1);
  // 标记后 buildFirstDelta 走增量，不再带 systemPrompt（点2：投委会每幕不重发完整规则）
  const next2 = orch.buildFirstDelta('s-claude', 'Q', 'SYSPROMPT');
  assert.ok(!next2.startsWith('SYSPROMPT'), 'silent 标记后 buildFirstDelta 不再带 systemPrompt');
  assert.match(next2, /## 用户\nQ\n\n请发言。$/);
});

test('appendCommitteeOutcome writes peer-visible messages without bumping lastDeliveredIdx (committee handoff)', () => {
  const { orch } = fresh();
  const before = orch.state.messages.length;
  const n = orch.appendCommitteeOutcome([
    { sid: 's-claude', speaker: 'Claude', content: '【投委会·末轮辩论】寒武纪追涨 85' },
    { sid: 's-codex', speaker: 'Codex', content: '【投委会·主席总指挥】资金有限先追寒武纪' },
    { sid: 's-x', speaker: 'X', content: '   ' },
  ]);
  assert.strictEqual(n, 2, '写 2 条（空内容跳过）');
  assert.strictEqual(orch.state.messages.length, before + 2);
  // 回归自由聊：用户发问后 buildDelta 把「别的 AI 末轮/主席发言」当新增发言喂给该委员（点6）
  orch.beginTurn('回归自由聊第一问');
  const delta = orch.buildDelta('s-claude', '回归自由聊第一问');
  assert.ok(delta.includes('Codex：【投委会·主席总指挥】资金有限先追寒武纪'), '别的 AI 末轮/主席发言喂给该委员');
  assert.ok(!delta.includes('Claude：【投委会·末轮辩论】'), '自己的发言不重复喂（buildDelta 过滤自身 sid）');
});

test('appendCommitteeSpeeches: 中间幕发言进 messages 供气泡渲染，但 buildDelta 跳过省 token，outcome 保留（阶段二+点6）', () => {
  const { orch } = fresh();
  orch.appendCommitteeSpeeches([{ sid: 's-codex', speaker: 'Codex', content: '建库幕发言原文' }], { act: '建库' });
  orch.appendCommitteeSpeeches([{ sid: 's-codex', speaker: 'Codex', content: '收敛幕主席结论' }], { act: '收敛', outcome: true });
  assert.strictEqual(orch.state.messages.length, 2, '两幕发言都进 messages（群聊气泡渲染靠它）');
  const mid = orch.state.messages.find(m => m.committeeAct === '建库');
  assert.ok(mid && !mid.committeeOutcome, '建库 message 带 committeeAct meta、非 outcome');
  orch.beginTurn('回归自由聊问一句');
  const delta = orch.buildDelta('s-claude', '回归自由聊问一句');
  assert.ok(!delta.includes('建库幕发言原文'), '中间幕发言 buildDelta 跳过（省 token、不灌爆上下文）');
  assert.ok(delta.includes('收敛幕主席结论'), 'outcome（收敛）发言 buildDelta 保留、喂回没看到的 AI（点6）');
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

test('patchTurnResult persists a usable answer before the full turn exists and completeTurn preserves it', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('One member finishes while another is still running.');

  const patched = orch.patchTurnResult(turnNum, 's-codex', {
    status: 'manual_extracted',
    text: 'Recovered before the slow member finished.',
    memberId: 'm2',
    speaker: 'Codex',
  });
  assert.ok(patched && patched.inProgress, '进行中轮次应接受可用结果');
  assert.strictEqual(orch.getState().turns.length, 0, '不得把进行中轮次伪装成已完成 turn');
  let raw = orch.getState().messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(raw.content, 'Recovered before the slow member finished.');
  assert.strictEqual(raw.status, 'manual_extracted');

  orch.completeTurn(turnNum, 'One member finishes while another is still running.', [
    { sid: 's-codex', status: 'completed', text: 'Older automatic text.' },
    { sid: 's-claude', status: 'completed', text: 'Claude result.' },
  ], Object.fromEntries(members.map(m => [m.sid, m])));
  const state = orch.getState();
  assert.strictEqual(state.turns[0].by['s-codex'], 'Recovered before the slow member finished.', '手动救回文本优先于迟到自动结果');
  assert.strictEqual(state.turns[0].byStatus['s-codex'], 'manual_extracted');
  raw = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(raw.content, 'Recovered before the slow member finished.');
});

test('patchTurnResult still rejects a turn that has neither turn record nor user message', () => {
  const { orch } = fresh();
  assert.strictEqual(orch.patchTurnResult(99, 's-codex', {
    status: 'completed',
    text: 'must not cross-write',
  }), null);
});

test('loading an interrupted in-flight turn resets stale group mode to idle but retains recovered messages', () => {
  const meetingId = `gc-reload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fp = groupchat.groupChatStatePath(tmp, meetingId);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({
    schemaVersion: 2,
    meetingId,
    currentTurn: 1,
    currentMode: 'group',
    turns: [],
    aiStats: {},
    lastDeliveredIdx: {},
    messages: [
      { id: 'u1', turnNum: 1, role: 'user', content: 'question' },
      { id: 'a1-m2', turnNum: 1, role: 'assistant', sid: 's-codex', content: 'durable answer', status: 'completed' },
    ],
  }), 'utf8');

  const orch = groupchat.getOrchestrator(tmp, meetingId);
  const state = orch.getState();
  assert.strictEqual(state.currentMode, 'idle', '重启后不能永久停在思考中');
  assert.strictEqual(state.messages[0].interruptedNote, true);
  assert.strictEqual(state.messages[1].content, 'durable answer', '已得到的结果必须保留');
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

// --- 2026-07-12 道雪：completeTurn/patchTurnResult 空文本保护 + statusReason 持久化 ---

test('completeTurn keeps existing answer when a completed result returns empty text (process_exit_clean)', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  const deliveredIdx = orch.state.messages.length - 1;
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'completed', text: '已有答案', deliveredIdx },
  ], { 's-codex': members[1] });
  // PTY 干净退出兜底 settle：completed + 空文本，不得抹掉已有答案
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'completed', text: '', deliveredIdx },
  ], { 's-codex': members[1] });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].by['s-codex'], '已有答案', 'completed 空文本不覆盖已有内容');
  const msg = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(msg.content, '已有答案', '消息正文同样保留');
});

test('completeTurn preserves manual_extracted status when a later empty errored result arrives', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  const deliveredIdx = orch.state.messages.length - 1;
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'manual_extracted', text: '手动救回的答案', deliveredIdx },
  ], { 's-codex': members[1] });
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'errored', text: '', reason: 'pty exit code=1', deliveredIdx },
  ], { 's-codex': members[1] });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].byStatus['s-codex'], 'manual_extracted', '手动同步状态不被空 errored 打回');
  assert.strictEqual(state.turns[0].by['s-codex'], '手动救回的答案');
});

test('completeTurn persists statusReason for empty errored results and message content mirrors by[sid]', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  const deliveredIdx = orch.state.messages.length - 1;
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'errored', text: '', reason: 'auth_required', deliveredIdx },
  ], { 's-codex': members[1] });
  const state = orch.getState();
  const msg = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(msg.status, 'errored');
  assert.strictEqual(msg.statusReason, 'auth_required', '失败原因随消息持久化，供 UI 占位文案解释');
  // 手动补全后 statusReason 撤销
  orch.patchTurnResult(turnNum, 's-codex', { text: '补全内容', status: 'manual_extracted' });
  const after = orch.getState().messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(after.content, '补全内容');
  assert.strictEqual(after.statusReason, undefined, '补全成功后不再显示失败原因');
});

test('completeTurn picks up mid-flight manual patch: message content comes from merged by[sid]', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  const deliveredIdx = orch.state.messages.length - 1;
  // 模拟：本 sid 的 watcher 先 errored settle，用户在整轮未结束时点「同步」patch 了 turn.by
  orch.state.turns.push({ n: turnNum, mode: 'group', userInput: 'Q.', by: {}, byStatus: {}, thinkSecBy: {}, tokensBy: {}, timestamp: Date.now(), meta: { dispatchMode: 'group' } });
  orch.patchTurnResult(turnNum, 's-codex', { text: '飞行中手动同步的答案', status: 'manual_extracted' });
  // 整轮 settle：该 sid 的 result 仍是 errored 空文本
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'errored', text: '', deliveredIdx },
  ], { 's-codex': members[1] });
  const state = orch.getState();
  const msg = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(msg.content, '飞行中手动同步的答案', '消息创建时用合并后的 by[sid]，不丢飞行中 patch');
  assert.strictEqual(state.turns[0].byStatus['s-codex'], 'manual_extracted');
});

test('patchTurnResult refuses to wipe existing content with an empty successful patch', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'completed', text: '完整答案' },
  ], { 's-codex': members[1] });
  orch.patchTurnResult(turnNum, 's-codex', { text: '', status: 'completed' });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].by['s-codex'], '完整答案', '空文本成功态 patch 不清空');
  const msg = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(msg.content, '完整答案');
});

// --- 二轮加固（多方审查 2026-07-12）---

test('patchTurnResult preserves manual_extracted when a later empty patch arrives (guard parity with completeTurn)', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'manual_extracted', text: '手动救回' },
  ], { 's-codex': members[1] });
  orch.patchTurnResult(turnNum, 's-codex', { text: '', status: 'errored' });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].byStatus['s-codex'], 'manual_extracted', '空 errored patch 不打回 manual_extracted');
  assert.strictEqual(state.turns[0].by['s-codex'], '手动救回');
  const msg = state.messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(msg.status, 'manual_extracted');
});

test('completeTurn treats whitespace-only text as empty (trim parity with renderer)', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'completed', text: '真实答案' },
  ], { 's-codex': members[1] });
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'completed', text: '   \n  ' },
  ], { 's-codex': members[1] });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].by['s-codex'], '真实答案', '纯空白文本不覆盖已有答案');
});

test('completeTurn keeps prior thinkSec/tokens when a later empty result reports none', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'completed', text: '答案', thinkSec: 12.5, tokens: { total: 3400 } },
  ], { 's-codex': members[1] });
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'errored', text: '' },
  ], { 's-codex': members[1] });
  const state = orch.getState();
  assert.strictEqual(state.turns[0].thinkSecBy['s-codex'], 12.5, '空结果不清零 thinkSec');
  assert.strictEqual(state.turns[0].tokensBy['s-codex'], 3400, '空结果不清零 tokens');
});

test('completeTurn keeps earlier statusReason when a repeated errored result has no reason', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('Q.');
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'errored', text: '', reason: 'auth_required' },
  ], { 's-codex': members[1] });
  orch.completeTurn(turnNum, 'Q.', [
    { sid: 's-codex', status: 'errored', text: '' },
  ], { 's-codex': members[1] });
  const msg = orch.getState().messages.find(m => m.role === 'assistant' && m.sid === 's-codex');
  assert.strictEqual(msg.statusReason, 'auth_required', '迟到的无 reason errored 不抹掉已有失败原因');
});

test('exact in-flight prompts and send receipts are durable until turn settlement', () => {
  const { meetingId, orch } = fresh();
  const { turnNum } = orch.beginTurn('long user question');
  const exactPrompt = 'SYSTEM RULES\n\n## 用户\nlong user question\n\nHERO';
  orch.recordTurnPrompt(turnNum, 's-codex', exactPrompt, {
    workflowRun: { runId: 'serial-run-1', kind: 'serial', stepIndex: 0, attempt: 1, targetMemberIds: ['m2'] },
  });
  orch.setSendStatus(turnNum, 's-codex', 'enter_retry', { acknowledgementSource: 'task_started' });
  const active = orch.getActivePrompt(turnNum, 's-codex');
  assert.strictEqual(active.prompt, exactPrompt);
  const diskBefore = JSON.parse(fs.readFileSync(groupchat.groupChatStatePath(tmp, meetingId), 'utf8'));
  assert.strictEqual(diskBefore.schemaVersion, 3);
  assert.strictEqual(diskBefore.pendingPrompts[String(turnNum)]['s-codex'].prompt, exactPrompt);
  assert.strictEqual(diskBefore.pendingPrompts[String(turnNum)]['s-codex'].status, 'enter_retry');
  assert.strictEqual(diskBefore.pendingPrompts[String(turnNum)]['s-codex'].workflowRun.runId, 'serial-run-1');

  orch.completeTurn(turnNum, 'long user question', [
    { sid: 's-codex', status: 'completed', text: 'answer' },
  ], { 's-codex': members[1] }, {}, {
    dispatchMode: 'serial',
    workflowRun: { runId: 'serial-run-1', kind: 'serial', stepIndex: 0, attempt: 1, targetMemberIds: ['m2'] },
  });
  const settled = orch.getState();
  assert.strictEqual(settled.pendingPrompts[String(turnNum)], undefined, 'settled turn clears transient prompt receipt');
  assert.strictEqual(settled.messages.find(m => m.sid === 's-codex').sourcePrompt, exactPrompt, 'assistant card keeps the exact prompt for audit/retry');
  assert.strictEqual(settled.turns[0].meta.workflowSteps[0].runId, 'serial-run-1');
  assert.strictEqual(settled.turns[0].meta.workflowSteps[0].results[0].textLength, 6);
  const leftovers = fs.readdirSync(path.dirname(groupchat.groupChatStatePath(tmp, meetingId)))
    .filter(name => name.includes(meetingId) && name.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'atomic state writes leave no temp files');
});

test('reusing an interrupted turn clears the stale restart badge without duplicating the user message', () => {
  const { orch } = fresh();
  const first = orch.beginTurn('resume me');
  const user = orch.state.messages.find(message => message.id === `u${first.turnNum}`);
  user.interruptedNote = true;
  const resumed = orch.beginTurn('internal step prompt', { turnNum: first.turnNum, appendUserMessage: false });
  assert.strictEqual(resumed.didAppendUserMessage, false);
  assert.strictEqual(orch.state.messages.filter(message => message.role === 'user').length, 1);
  assert.strictEqual(user.interruptedNote, undefined);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
