'use strict';
// 2026-09-06：每一次逻辑派发都要有一张可追溯的卡片。
//
// 症状（维护者报）：群聊窗口里只看得到发给工作位的卡片，看不到发给合并位的。
// 根因：一轮只有一条 `u{n}` 用户消息，被工作位那一步占了；评审那一步复用同一轮
//       且 appendUserMessage:false，于是它收到的指令**从来没进过消息流**。
//
// 合并位（Codex 2）明确要求：光证明「新卡片不进 prompt」不算零行为变更，还得验
// 消息序号、上下文投递游标、持久化重载、重试去重，以及两步的卡片不能共用身份。
// 这个文件逐条验这些。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const groupchat = require('../core/group-chat-orchestrator.js');
const { splitDispatchPrompt, recipientText, attemptText, isDispatchCard } = require('../renderer/dispatch-card.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dispatch-cards-'));
let seed = 0;
function fresh() {
  const meetingId = `gc-dispatch-${process.pid}-${++seed}`;
  return { meetingId, orch: groupchat.getOrchestrator(TMP, meetingId) };
}

const BUILDER_SID = 's-builder';
const REVIEWER_SID = 's-reviewer';
const memberBySid = {
  [BUILDER_SID]: { sid: BUILDER_SID, memberId: 'm1', displayName: '工作位 Claude', kind: 'claude' },
  [REVIEWER_SID]: { sid: REVIEWER_SID, memberId: 'm2', displayName: '合并位 Codex', kind: 'codex' },
};

// 走一轮真实的「工作位 → 合并位」派发：两步同一个 turnNum，第二步复用轮次。
function runOneLoopRound(orch, { reviewerAttempt = 1 } = {}) {
  const builderMeta = {
    kind: 'loop', stepIndex: 0, attempt: 1, runId: 'loop-run-1',
    toMemberIds: ['m1'], toLabels: ['工作位 Claude'],
  };
  const begin = orch.beginTurn('工作位指令', { appendUserMessage: true, dispatch: builderMeta });
  orch.completeTurn(begin.turnNum, '工作位指令',
    [{ sid: BUILDER_SID, status: 'completed', text: 'PROGRESS: 做完了' }], memberBySid);

  const reviewerMeta = {
    kind: 'loop', stepIndex: 1, attempt: reviewerAttempt, runId: 'loop-run-1',
    toMemberIds: ['m2'], toLabels: ['合并位 Codex'],
  };
  orch.beginTurn('评审指令', {
    turnNum: begin.turnNum, appendUserMessage: false, dispatch: reviewerMeta,
  });
  const card = orch.appendDispatchMessage(begin.turnNum, '评审指令', reviewerMeta);
  return { turnNum: begin.turnNum, card };
}

test('评审那一步也留下卡片，且与工作位卡片不共用身份', () => {
  const { orch } = fresh();
  const { turnNum } = runOneLoopRound(orch);
  const userCards = orch.state.messages.filter(m => m.role === 'user' && !m.systemNote);
  assert.equal(userCards.length, 2, '一轮里应当有两张卡片：发给工作位的、发给合并位的');

  const [builderCard, reviewerCard] = userCards;
  assert.equal(builderCard.id, `u${turnNum}`);
  assert.equal(reviewerCard.id, `u${turnNum}-d1`, '评审卡片的 id 必须带步号，不能占轮次锚点');
  assert.notEqual(builderCard.id, reviewerCard.id);
  assert.equal(builderCard.dispatch.stepIndex, 0);
  assert.equal(reviewerCard.dispatch.stepIndex, 1);
  assert.deepEqual(reviewerCard.toLabels, ['合并位 Codex'], '卡片要标明发给谁');
  assert.equal(builderCard.dispatch.runId, reviewerCard.dispatch.runId, '同一次 run');
  assert.equal(reviewerCard.content, '评审指令');
});

test('轮次锚点仍是 u{n}：新卡片不参与轮次窗口的上下界推导', () => {
  const { orch } = fresh();
  const { turnNum } = runOneLoopRound(orch);
  // 手工重提取用这两条判据定位轮次窗口，改动不得让它们错位
  const anchor = orch.state.messages.find(m => m.id === `u${turnNum}` && m.role === 'user');
  assert.ok(anchor, 'u{n} 必须仍然存在');
  const laterUser = orch.state.messages.find(m => m.role === 'user' && Number(m.turnNum) > turnNum);
  assert.equal(laterUser, undefined, '同一轮的新卡片不能被当成「下一轮的用户消息」');
});

test('消息序号单调递增，卡片不插队', () => {
  const { orch } = fresh();
  runOneLoopRound(orch);
  const seqs = orch.state.messages.map(m => m.seq);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), 'seq 必须单调不减');
  assert.equal(new Set(seqs).size, seqs.length, 'seq 不能重复');
  assert.equal(orch.state.nextMessageSeq, Math.max(...seqs) + 1);
});

test('新卡片不进任何成员的上下文（投递游标越过它也不改变内容）', () => {
  const { orch } = fresh();
  runOneLoopRound(orch);
  const delta = orch.buildDelta(REVIEWER_SID, '评审指令');
  assert.ok(delta.includes('PROGRESS: 做完了'), '评审仍要看到工作位的回答');
  assert.ok(!delta.includes('工作位指令'), '发给工作位的卡片不能进评审的上下文');
  const afterUserSection = delta.split('## 用户')[1] || '';
  assert.equal((afterUserSection.match(/评审指令/g) || []).length, 1,
    '评审指令只应作为本轮 userInput 出现一次，卡片本身不得被重复灌入');

  // 游标推进到卡片之后，工作位下一轮仍能看到它没看过的发言
  orch.state.lastDeliveredSeq[BUILDER_SID] = 1;
  const builderDelta = orch.buildDelta(BUILDER_SID, '下一轮');
  assert.ok(!builderDelta.includes('评审指令'), '卡片是 user 角色，永远不进 delta');
});

test('同一步重试不重复造卡，只更新不了内容也不会多出一张', () => {
  const { orch } = fresh();
  const { turnNum } = runOneLoopRound(orch);
  const again = orch.appendDispatchMessage(turnNum, '评审指令（第二次传输重试）', {
    kind: 'loop', stepIndex: 1, attempt: 2, runId: 'loop-run-1', toLabels: ['合并位 Codex'],
  });
  const cards = orch.state.messages.filter(m => m.role === 'user');
  assert.equal(cards.length, 2, '第 2 次传输重试不得再造一张卡');
  assert.equal(again.id, `u${turnNum}-d1`, '重试拿到的是同一张卡');
});

test('持久化重载后卡片与其身份都还在', () => {
  const { meetingId, orch } = fresh();
  const { turnNum } = runOneLoopRound(orch);
  groupchat._private.resetCache();
  const reloaded = groupchat.getOrchestrator(TMP, meetingId);
  const card = reloaded.state.messages.find(m => m.id === `u${turnNum}-d1`);
  assert.ok(card, '重载后卡片必须还在');
  assert.equal(card.dispatch.stepIndex, 1);
  assert.deepEqual(card.toLabels, ['合并位 Codex']);
  assert.equal(card.role, 'user');
  // 重载后再取 delta，仍然不能把卡片灌给别人
  assert.ok(!reloaded.buildDelta(BUILDER_SID, 'x').includes('评审指令'));
});

test('轮次回滚会连卡片一起清掉，不留孤儿', () => {
  const { orch } = fresh();
  const { turnNum } = runOneLoopRound(orch);
  orch.rollbackTurn(turnNum);
  assert.equal(orch.state.messages.filter(m => Number(m.turnNum) === turnNum).length, 0);
});

test('普通群聊消息完全不受影响（没有 dispatch 身份就不加任何字段）', () => {
  const { orch } = fresh();
  const begin = orch.beginTurn('普通提问');
  const msg = orch.state.messages.find(m => m.id === `u${begin.turnNum}`);
  assert.equal(msg.dispatch, undefined, '普通消息不该多出 dispatch 字段');
  assert.equal(msg.toLabels, undefined);
  assert.equal(isDispatchCard(msg), false);
  assert.equal(orch.appendDispatchMessage(begin.turnNum, 'x', {}), null, '没有步号就不是一次有身份的派发');
});

test('系统提示行：可见、去重、且同样不进上下文', () => {
  const { orch } = fresh();
  const begin = orch.beginTurn('提问');
  const note = orch.appendSystemNote(begin.turnNum, '第 1 次自动续跑 · 原因：额度限制', { kind: 'warn' });
  assert.ok(note && note.systemNote, '要能留下系统提示');
  assert.equal(orch.appendSystemNote(begin.turnNum, '第 1 次自动续跑 · 原因：额度限制').id, note.id,
    '同一条提示重复写入不该刷屏');
  assert.ok(!orch.buildDelta(BUILDER_SID, 'x').includes('自动续跑'), '系统提示不进任何成员的上下文');
});

// ── 角色抬头折叠（纯展示，不动 prompt）────────────────────────────────────
test('工作位 prompt：角色抬头与本轮任务能分开，正文一字不改', () => {
  const prompt = [
    '## 角色：执行者', '工作区：C:/repo', '总目标：修好闸门',
    '步骤职责：读本仓库的 .agents/AUTHOR.md，按它工作。',
    '本轮任务：', '本轮只解决下面的评审阻断项：', '1. 补一条测试',
  ].join('\n');
  const { head, body, mode } = splitDispatchPrompt(prompt);
  assert.equal(mode, 'split');
  assert.ok(head.startsWith('## 角色：执行者'));
  assert.ok(body.startsWith('本轮任务：'), '本轮真正要看的内容不折');
  assert.equal((head + '\n' + body).replace(/\s/g, ''), prompt.replace(/\s/g, ''),
    '折叠只是显示切分，内容不得丢失或改写');
});

test('评审 prompt：整段常驻角色文本，整体折叠', () => {
  const prompt = '## 你的角色：评审\n' + 'x'.repeat(400);
  const { head, body, mode } = splitDispatchPrompt(prompt);
  assert.equal(mode, 'all');
  assert.equal(body, '');
  assert.equal(head.length, prompt.length);
});

test('短消息和普通提问不折叠', () => {
  assert.equal(splitDispatchPrompt('帮我看下这个 bug').mode, 'plain');
  assert.equal(splitDispatchPrompt('## 标题\n两行而已').mode, 'plain');
});

test('角标文案', () => {
  assert.equal(recipientText({ toLabels: ['合并位 Codex'] }), '发给 合并位 Codex');
  assert.equal(recipientText({ toLabels: ['A', 'B'] }), '发给 A、B');
  assert.equal(recipientText({}), '');
  assert.equal(attemptText({ dispatch: { attempt: 2 } }), '第 2 次派发');
  assert.equal(attemptText({ dispatch: { attempt: 1 } }), '');
});

console.log('unit-groupchat-dispatch-cards OK');
