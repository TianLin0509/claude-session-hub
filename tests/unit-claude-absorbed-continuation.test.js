'use strict';
// 2026-09-23 生产事故的回归：一个会话在 5 小时的主回合里收到 80 条后台任务
// 通知，其中 77 条被 CLI 在回合中途「就地吸收」（原生 transcript 记作
// queue-operation remove / reason=absorbed_mid_turn）。被吸收的通知不会另开
// 一轮，也就永远不会回一条属于它自己的 result —— Hub 却为每条都开了一条后台
// 活动记录。后果是三件事同时发生：
//   1. 归属歧义（ambiguous）让整轮输出一帧都不进卡片，界面上什么都看不到；
//   2. 77 条永远 pending 的活动把状态钉死在假的「工作中」，长达 2 小时 16 分；
//   3. 停止请求拿不到确认，超时后 cancellation 不清，提交、核对、再停止全被
//      它挡住，会话只能靠关掉重开才能恢复。
// 这个文件按这三件事各守一条。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { buildComposerStatusModel } = require('../core/session-status-summary');
const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');

function create(t, options = {}) {
  const s = new ClaudeNativeSession({ id: 'absorbed-test', executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js'), '--fixture=hold'], closeTimeoutMs: 300, ...options });
  t.after(() => s.close());
  return s;
}
function frame(s, value) { s.message({ uuid: randomUUID(), session_id: s.sessionId, ...value }); }
function answer(s, text, extra = {}) {
  frame(s, { type: 'assistant', message: { id: randomUUID(), role: 'assistant',
    content: [{ type: 'text', text }] }, ...extra });
}
function result(s, origin = { kind: 'human' }, text = 'root answer') {
  frame(s, { type: 'result', subtype: 'success', is_error: false, origin, result: text });
}
// 引擎在主回合中途注入的任务通知：一条 user 帧，没有配套的 result。
function notify(s, taskId) {
  frame(s, { type: 'user', origin: { kind: 'task-notification' },
    message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n</task-notification>` } });
}

test('回合进行中被吸收的任务通知并入本轮，不开一条等不到结局的后台活动', async t => {
  const s = create(t);
  await s.submit('长任务', { submissionId: 'A' });
  answer(s, '先起三个后台编译');
  for (let i = 0; i < 77; i++) { notify(s, 'task-' + i); answer(s, '第 ' + i + ' 条通知后的进展'); }
  assert.equal(s.activities.records.size, 0, '被吸收的通知不产生后台活动记录');
  assert.equal(s.runtime.backgroundActivities.length, 0);
  // 归属没有歧义，所以每一帧都当场进卡片 —— 这正是用户看不到任何输出的那一项。
  assert.equal(s.activities.ambiguous, false);
  assert.equal(s.records.get('A').messages.size, 78, '78 条 assistant 帧全部落在本轮');
  assert.equal(s.runtime.state, 'running');
  result(s, { kind: 'human' }, '全部编译完成');
  assert.equal(s.records.get('A').status, 'completed');
  // 结算之后必须真的回到已完成，而不是被后台活动钉成「工作中」。
  assert.equal(s.runtime.state, 'completed');
  assert.equal(s.runtime.backgroundActivities.length, 0);
  assert.equal((await s.submit('下一条')).sendStatus, 'accepted', '后续消息仍能发出去');
});

test('引擎空闲时到达的任务通知仍然是自己的一轮', async t => {
  const s = create(t);
  await s.submit('A', { submissionId: 'A' }); result(s);
  notify(s, 'idle-task');
  answer(s, '后台任务的回答');
  result(s, { kind: 'task-notification' }, '后台任务的回答');
  const activities = [...s.activities.records.values()];
  assert.equal(activities.length, 1);
  assert.equal(activities[0].status, 'completed');
  assert.equal(s.runtime.state, 'completed');
});

test('注入回合没有结局就开下一轮时，判它待核对而不是永远显示工作中', async t => {
  const s = create(t);
  await s.submit('A', { submissionId: 'A' }); result(s);
  notify(s, 'first');
  answer(s, '第一条后台输出');
  assert.equal(s.runtime.state, 'running', '第一条注入回合确实在跑');
  // 引擎一次只跑一轮：第二条注入开始，就证明第一条不会再有结果了。
  notify(s, 'second');
  const abandoned = [...s.activities.records.values()].filter(r => r.status === 'unknown');
  assert.equal(abandoned.length, 1, '上一条被判 unknown，而不是留在 running');
  assert.equal(abandoned[0].messages.size, 1, '它已经收下的正文不会被撤销');
  assert.equal(s.activities.live().length, 1, '同一时刻最多只有一条在跑的注入回合');
  result(s, { kind: 'task-notification' }, '第二条后台输出');
  // 2026-09-24 用户决定：注入回合是引擎自己的续跑，不再要人核对。结果仍记 unknown
  // （不编造成功），但当场登记 do-not-replay —— 不亮「待核对」，也不挡发送。
  assert.equal(abandoned[0].status, 'unknown');
  assert.equal(abandoned[0].reconciliation?.history, 'engine-internal');
  assert.notEqual(s.runtime.state, 'unknown');
  assert.equal(s.recoveryRecords().length, 0);
  assert.equal(s.activities.pending().length, 0);
  assert.equal((await s.submit('继续')).sendStatus, 'accepted');
});

test('放弃上一条注入回合时，不许顺手把人类回合的正文一起改嫁过去', async t => {
  const s = create(t);
  await s.submit('A', { submissionId: 'A' });
  answer(s, '人类回合的前半段');
  // channel 是另一场对话，不并轮 —— 所以它会和还在跑的人类回合同时存在。
  frame(s, { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '远端提问一' } });
  answer(s, '远端回答一');
  // 第二条 channel 注入会放弃第一条。此刻 segment 里同时躺着人类回合和第一条
  // 注入的帧，整段改嫁就等于把用户这一轮的回答算到被放弃的活动名下。
  frame(s, { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '远端提问二' } });
  const [first] = [...s.activities.records.values()];
  assert.equal(first.status, 'unknown');
  assert.deepEqual([...s.records.get('A').messages.values()].map(m => m.message.content[0].text),
    ['人类回合的前半段'], '人类回合的帧仍然只属于人类回合');
  assert.deepEqual([...first.messages.values()].map(m => m.message.content[0].text),
    ['远端回答一'], '被放弃的注入回合保留自己的正文，不多不少');
});

test('停止超时之后是「结果待核对」，核对这条出路不许被它自己挡住', async t => {
  const s = create(t, { cancelTimeoutMs: 60 });
  await s.start();
  notify(s, 'stuck');
  answer(s, '后台输出');
  await s.interrupt();
  assert.equal(s.runtime.cancellation.status, 'pending');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(s.runtime.cancellation.status, 'unknown');
  assert.match(s.runtime.reason, /停止未在期限/);
  // 既有契约不变：没确认的停止之后不许再发送。
  await assert.rejects(s.submit('不许重发'), /正在停止/);
  // 但状态不能再报「工作中」，否则界面上连核对按钮都没有。
  assert.equal(s.runtime.state, 'unknown');
  const session = { id: 'hub', kind: 'claude', runtimeBackend: 'claude-stream-json', nativeRuntime: s.runtime };
  const status = buildComposerStatusModel(session, { runtime: deriveSessionRuntimeStatus(session) });
  assert.deepEqual(status.action, { kind: 'claude-reconcile', label: '核对上次任务' });
  // 核对是这个状态唯一的出口，它必须能跑。
  await s.reconcileFromHistory({ source: 'user' });
  assert.equal(s.cancellation, null);
  assert.equal(s.runtime.state, 'idle');
  assert.equal((await s.submit('恢复之后')).sendStatus, 'accepted');
});
