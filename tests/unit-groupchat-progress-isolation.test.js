'use strict';
/**
 * 过程汇报（UPDATE / progress_update）不得占用「本轮该席位的正式答复」这个位置。
 *
 * 被坑出来的：开发工作台要实时进展，于是把 Agent 半路写的 `UPDATE: xxx` 也存成了一条
 * 群聊消息。但 completeTurn / patchTurnResult 找「第 N 轮某席位说了什么」用的条件是
 * 「role=assistant + turnNum 匹配 + sid 匹配」，过程汇报三条全中，而且它出现得更早，
 * 于是每次都被优先命中：
 *
 *   1) 本轮跑空（超时 / errored / 干净退出无正文）时，结算把过程汇报当成已有答案捞回来，
 *      这一轮的 by[sid] 被归档成半路的一句进展 —— 记录失真，且会作为「新增发言」发给队友。
 *   2) 正常有答复时，答复直接改写那条过程汇报消息，本轮再也没有 a{n}-{memberId} 身份；
 *      同轮重发过一次就会留下两条并列的助手消息。
 *
 * 这类问题不报错、测试也不红，只会让群聊记录悄悄记错。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groupchat = require('../core/group-chat-orchestrator.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-progress-isolation-'));
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  OK ' + name); }

console.log('--- groupchat progress isolation ---');

// 起一个已派发、且席位已写过一条过程汇报的轮次。
function withProgress(id) {
  const orch = groupchat.getOrchestrator(root, id);
  const { turnNum, runId } = orch.beginTurn('请实现功能 X');
  orch.recordTurnPrompt(turnNum, 's-claude', '任务全文', { runId, memberId: 'm1', kind: 'claude' });
  assert.equal(
    orch.recordProgressUpdate('s-claude', '已复现问题，正在写测试', Date.now() + 5, 'Claude 1', { hubSessionId: 's-claude' }),
    true, '测试前提：过程汇报应当被记录');
  return { orch, turnNum, runId };
}
const answers = orch => orch.state.messages.filter(m => m.role === 'assistant' && m.status !== 'progress_update');
const updates = orch => orch.state.messages.filter(m => m.status === 'progress_update');

test('空结果结算：过程汇报不得被归档成该席位本轮的答复', () => {
  const { orch, turnNum } = withProgress('gc-empty-settle');
  orch.completeTurn(turnNum, '请实现功能 X',
    [{ sid: 's-claude', text: '', status: 'errored', reason: 'timeout' }],
    { 's-claude': { memberId: 'm1', displayName: 'Claude 1' } });
  const turn = orch.state.turns.find(t => t.n === turnNum);
  assert.ok(!String(turn.by['s-claude'] || '').includes('UPDATE:'),
    '本轮跑空时把过程汇报当成答案存档了：' + turn.by['s-claude']);
  assert.equal(turn.byStatus['s-claude'], 'errored', '空结果的状态必须如实记 errored');
});

test('空结果结算：patchTurnResult 也不得拿过程汇报当已有答案', () => {
  const { orch, turnNum } = withProgress('gc-empty-patch');
  orch.patchTurnResult(turnNum, 's-claude', { text: '', status: 'errored', memberId: 'm1', speaker: 'Claude 1' });
  const answer = answers(orch).find(m => m.sid === 's-claude');
  assert.ok(answer, '应当另起一条正式答复消息，而不是改写过程汇报');
  assert.ok(!String(answer.content || '').includes('UPDATE:'), '答复气泡里出现了过程汇报：' + answer.content);
  assert.equal(updates(orch).length, 1, '过程汇报本身要原样保留在群聊里');
  assert.ok(String(updates(orch)[0].content).includes('UPDATE:'), '过程汇报的正文不该被改写');
});

test('正常结算：答复另起消息并保留 a{n}-{memberId} 身份', () => {
  const { orch, turnNum } = withProgress('gc-normal');
  orch.completeTurn(turnNum, '请实现功能 X',
    [{ sid: 's-claude', text: 'PROGRESS: 做完了\nVERIFIED: 7 项通过', status: 'completed', finality: 'provider_final' }],
    { 's-claude': { memberId: 'm1', displayName: 'Claude 1' } });
  const answer = orch.state.messages.find(m => m.id === `a${turnNum}-m1`);
  assert.ok(answer, '正式答复丢了 a' + turnNum + '-m1 身份，被写进了过程汇报那条消息');
  assert.equal(answer.status, 'completed');
  assert.ok(answer.content.startsWith('PROGRESS:'));
  assert.equal(updates(orch).length, 1, '过程汇报应当独立保留，不被答复覆写');
  assert.equal(orch.state.turns.find(t => t.n === turnNum).by['s-claude'], answer.content);
});

test('同轮重发一次：只留一条正式答复，不出现并列的重复气泡', () => {
  const { orch, turnNum, runId } = withProgress('gc-resend');
  orch.recordTurnPrompt(turnNum, 's-claude', '重发全文', { runId, memberId: 'm1', kind: 'claude' });
  orch.recordProgressUpdate('s-claude', '重发后重新开始', Date.now() + 20, 'Claude 1', { hubSessionId: 's-claude' });
  orch.completeTurn(turnNum, '请实现功能 X',
    [{ sid: 's-claude', text: '最终答复正文', status: 'completed', finality: 'provider_final' }],
    { 's-claude': { memberId: 'm1', displayName: 'Claude 1' } });
  const settled = answers(orch).filter(m => m.sid === 's-claude' && Number(m.turnNum) === turnNum);
  assert.equal(settled.length, 1, '同一席位同一轮出现了 ' + settled.length + ' 条正式答复');
  assert.equal(settled[0].content, '最终答复正文');
  assert.equal(settled[0].id, `a${turnNum}-m1`);
});

test('先 patch 后 completeTurn：仍然复用同一条正式答复，不新增气泡', () => {
  const { orch, turnNum } = withProgress('gc-patch-then-complete');
  orch.patchTurnResult(turnNum, 's-claude', { text: '先到的结果', status: 'completed', memberId: 'm1', speaker: 'Claude 1' });
  orch.completeTurn(turnNum, '请实现功能 X',
    [{ sid: 's-claude', text: '最终答复正文', status: 'completed', finality: 'provider_final' }],
    { 's-claude': { memberId: 'm1', displayName: 'Claude 1' } });
  const settled = answers(orch).filter(m => m.sid === 's-claude' && Number(m.turnNum) === turnNum);
  assert.equal(settled.length, 1, '先到结果与最终结算必须落在同一条消息上');
  assert.equal(settled[0].content, '最终答复正文');
});

console.log('\n通过 ' + pass + ' / 失败 0');
