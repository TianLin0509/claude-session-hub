'use strict';
/**
 * 极简（单席位）开发群聊：实现报告不能被自己的评审顶掉。
 *
 * 2026-09-07 合并位复现的阻断项。机制在持久化这一层：一轮里每位成员只有一格
 * （orchestrator 的 `turn.by[sid]`，消息流里也只有一条该 sid 的 assistant 消息）。
 * 双席位时工作位和合并位是两个 sid，同一轮里各占各的格子，互不相干；
 * 极简时是同一个 sid，一旦评审复用同一轮，它的 RESULT 会直接盖掉刚落盘的 PROGRESS ——
 * 群聊里那条实现报告消失，工作台的交付卡（summarizeGroupState 的 card）跟着变 null，
 * 而流程仍然显示 done。**丢数据但一路绿灯**，所以必须钉死。
 *
 * 修法是不动存储结构，让评审在同席位时另起一轮（见 main/groupchat/loop-engine.js）。
 * 本文件验的就是这条修法在真实 orchestrator + 真实工作台摘要上确实成立。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groupchat = require('../core/group-chat-orchestrator');
const Feed = require('../core/dev-workbench-feed');

const BUILD_TEXT = 'PROGRESS: 已改好\nVERIFIED: 单测 3 条\nRISK: 无\nREPORT: 无';
const REVIEW_TEXT = 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 跑了 dry-run\nNEXT: 无';
const MEMBER = { s1: { memberId: 'm1', displayName: '席位' } };
const DISPATCH = { kind: 'loop', stepIndex: 1, attempt: 1, runId: 'r1', toMemberIds: ['m1'], toLabels: ['席位'] };

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('solo-loop-report-preserved');

function newOrch(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `solo-loop-${tag}-`));
  return groupchat.getOrchestrator(root, `solo-${tag}`);
}

test('复用同一轮 = 实现报告被自己的评审覆盖（这就是要修掉的行为）', () => {
  const orch = newOrch('same');
  const n = orch.beginTurn('改一句文案').turnNum;
  orch.completeTurn(n, '实现指令', [{ sid: 's1', text: BUILD_TEXT, status: 'completed' }], MEMBER);
  assert.equal(Feed.summarizeGroupState(orch.state).card.progress, '已改好', '实现报告先落盘');

  orch.completeTurn(n, '评审指令', [{ sid: 's1', text: REVIEW_TEXT, status: 'completed' }], MEMBER);
  assert.match(orch.state.turns[0].by.s1, /^RESULT: PASS/, '同轮同席位：格子只剩评审那份');
  assert.equal(orch.state.messages.filter(m => m.role === 'assistant').length, 1, '消息流里也只剩一条');
  const summary = Feed.summarizeGroupState(orch.state);
  assert.equal(summary.card, null, '工作台交付卡随之丢失');
  assert.equal(summary.review.decision, 'pass', '而裁决还在——所以流程会一路绿灯地丢数据');
});

test('评审另起一轮 = 实现报告和裁决都留得住（修完的行为）', () => {
  const orch = newOrch('split');
  const n1 = orch.beginTurn('改一句文案').turnNum;
  orch.completeTurn(n1, '实现指令', [{ sid: 's1', text: BUILD_TEXT, status: 'completed' }], MEMBER);

  // 引擎在同席位时的做法：新起一轮、不追加用户消息，指令靠派发卡片进消息流。
  const n2 = orch.beginTurn('评审指令', { appendUserMessage: false, dispatch: DISPATCH }).turnNum;
  assert.notEqual(n2, n1, '必须是新的一轮');
  orch.appendDispatchMessage(n2, '评审指令', DISPATCH);
  orch.completeTurn(n2, '评审指令', [{ sid: 's1', text: REVIEW_TEXT, status: 'completed' }], MEMBER);

  assert.match(orch.state.turns[0].by.s1, /^PROGRESS: /, '实现那一轮原样保留');
  assert.match(orch.state.turns[1].by.s1, /^RESULT: PASS/, '评审落在自己那一轮');
  assert.equal(orch.state.messages.filter(m => m.role === 'assistant').length, 2, '群聊里两条都在');

  const summary = Feed.summarizeGroupState(orch.state);
  assert.equal(summary.card.progress, '已改好', '交付卡还在');
  assert.equal(summary.review.decision, 'pass', '裁决也在');
  assert.deepEqual(summary.timeline.map(item => item.kind), ['handoff', 'review'],
    '纪事按顺序两条都有：先交付、后审核');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
