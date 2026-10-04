'use strict';
// AI 编排服务：用假群聊、假会话、假工作流引擎验证工具门槛、额度、通知排队与重启恢复。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Delivery = require('../core/delivery-workflow');
const Store = require('../core/orchestration/store');
const Rules = require('../core/orchestration/rules');
const { createOrchestrationService } = require('../main/orchestration/service');

const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { settings = {}, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'orch-svc-'));
  let clock = 1_000_000;
  const sessions = new Map([['s-orch', { id: 's-orch', kind: 'claude', title: 'Claude 1', purpose: 'hub-orchestrator', status: 'idle' }]]);
  const busy = new Set();
  const meetingObj = {
    id: 'mt1', groupChat: true, title: '编排群', scene: 'general', workspace: dir, subSessions: ['s-orch'],
    slotSpecs: [{ memberId: 'm1', kind: 'claude' }], participants: [0], serialWorkflow: null,
    orchestration: { enabled: true, memberId: 'm1', sessionId: 's-orch', settings: { requireConfirm: true, roundCap: 3, timeCapMin: 60, ...settings } },
  };
  const meetingManager = {
    getMeeting: id => (id === 'mt1' ? JSON.parse(JSON.stringify(meetingObj)) : null),
    getAllMeetings: () => [JSON.parse(JSON.stringify(meetingObj))],
    updateMeeting: (id, fields) => { Object.assign(meetingObj, JSON.parse(JSON.stringify(fields))); return meetingObj; },
    setParticipants: (id, p) => { meetingObj.participants = p; },
  };
  const dispatches = [];
  let dispatchResult = { status: 'completed', turnNum: 1, results: [{ status: 'completed' }] };
  const dispatcher = { dispatchGroupChatTurn: async (id, args) => { dispatches.push(args); return dispatchResult; } };
  const runFile = path.join(Delivery.directory(dir, 'mt1'), 'run.json');
  const writeRun = run => { fs.mkdirSync(path.dirname(runFile), { recursive: true }); fs.writeFileSync(runFile, JSON.stringify(run)); };
  const engineCalls = [];
  const engine = {
    start: async (id, goal) => { engineCalls.push(['start', goal]); writeRun({ id: 'run-1', kind: meetingObj.serialWorkflow.deliveryKind, status: 'running', createdAt: clock, stages: meetingObj.serialWorkflow.deliveryStages, steps: [{ id: 'st1', index: 0, members: meetingObj.serialWorkflow.deliveryStages[0].members, createdAt: clock, deliveries: {} }] }); return { runId: 'run-1' }; },
    stop: id => { engineCalls.push(['stop']); const r = JSON.parse(fs.readFileSync(runFile, 'utf8')); r.status = 'paused'; writeRun(r); return true; },
    resume: async () => { engineCalls.push(['resume']); return { status: 'running' }; },
    cancel: async () => { engineCalls.push(['cancel']); },
    continueWork: async () => { engineCalls.push(['remind']); return {}; },
  };
  let seq = 1;
  const addMeetingSubInternal = async (id, kind, opts) => {
    seq += 1;
    const sid = 's-' + seq;
    sessions.set(sid, { id: sid, kind, title: `${kind} ${seq}`, status: 'idle', currentModel: { id: opts.model } });
    meetingObj.subSessions.push(sid);
    meetingObj.slotSpecs.push({ memberId: 'm' + seq, kind });
    meetingObj.participants = meetingObj.subSessions.map((_, i) => i);
    return { session: sessions.get(sid), meeting: meetingObj };
  };
  const sent = [];
  const service = createOrchestrationService({
    meetingManager, getHubDataDir: () => dir, now: () => clock,
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: id => busy.has(id) },
    getDispatcher: () => dispatcher, getDeliveryEngine: () => engine, addMeetingSubInternal,
    getMembers: m => m.subSessions.map((sid, i) => ({ sid, memberId: m.slotSpecs[i].memberId, displayName: sessions.get(sid).title, kind: sessions.get(sid).kind, model: null })),
    getDefaults: () => ({}), sendToRenderer: (channel, data) => sent.push([channel, data]), logger: { warn() {}, error() {} },
  });
  t.after(() => service.stop());
  const call = (name, args = {}, caller = 's-orch') => service.invokeTool({ name, arguments: args, callerSessionId: caller });
  return { dir, service, call, meetingObj, dispatches, engineCalls, busy, writeRun, sent, sessions,
    advance: ms => { clock += ms; }, setDispatchResult: r => { dispatchResult = r; } };
}
const planArgs = { summary: '调研并实现', team: [{ role: '开发位', kind: 'codex' }, { role: '审核位', kind: 'claude' }],
  segments: [{ name: 'PF 实现', preset: 'development', goal: '实现 PF', acceptance: '单测通过' }] };

test('only the orchestrator session may call tools; nothing is dispatched before the plan is confirmed', async t => {
  const x = fixture(t);
  await assert.rejects(x.call('orch_status', {}, 's-other'), /只有编排群里的编排员/);
  await assert.rejects(x.call('orch_add_member', { role: '开发位', kind: 'codex' }), /确认/);
  const proposed = await x.call('orch_propose_plan', planArgs);
  assert.equal(proposed.status, 'awaiting_confirm');
  await assert.rejects(x.call('orch_start_workflow', { name: 'a', preset: 'research', goal: 'g', acceptance: 'a', members: ['m2'] }), /确认/);
  await x.service.userAction('mt1', 'confirm');
  assert.equal((await x.call('orch_status')).status, 'running');
  await wait(10);
  assert.equal(x.dispatches.length, 1, 'the confirmation is delivered to the orchestrator');
  assert.deepEqual(x.dispatches[0].targetMemberIds, ['m1']);
  assert.equal(x.dispatches[0].appendUserMessage, false);
  assert.match(x.dispatches[0].userInput, /已确认计划 v1/);
});

test('members are capped at three, keep the orchestrator as the only recipient, and roles are recorded', async t => {
  const x = fixture(t, { settings: { requireConfirm: false } });
  const a = await x.call('orch_add_member', { role: '开发位', kind: 'codex', tier: 'fast' });
  await x.call('orch_add_member', { role: '审核位', kind: 'claude', tier: 'fast' });
  await x.call('orch_add_member', { role: '复核', kind: 'claude', tier: 'fast' });
  await assert.rejects(x.call('orch_add_member', { role: '多余', kind: 'codex' }), /成员已满/);
  assert.equal(a.memberId, 'm2');
  assert.deepEqual(x.meetingObj.participants, [0]);
  const status = await x.call('orch_status');
  assert.equal(status.members.find(m => m.memberId === 'm2').role, '开发位');
  assert.match(Rules.rulesFor(x.dir, x.meetingObj, 'm1'), /你是本群的编排员/);
  assert.match(Rules.rulesFor(x.dir, x.meetingObj, 'm2'), /开发位/);
});

test('development workflows need different backends unless justified, and start with acceptance and no-merge terms', async t => {
  const x = fixture(t, { settings: { requireConfirm: false } });
  await x.call('orch_add_member', { role: '开发位', kind: 'claude', tier: 'fast' });
  await x.call('orch_add_member', { role: '审核位', kind: 'claude', tier: 'fast' });
  const args = { name: 'PF', preset: 'development', goal: '实现 PF 调度', acceptance: '单测覆盖零速率', members: ['m2', 'm3'] };
  await assert.rejects(x.call('orch_start_workflow', args), /不同后端/);
  await assert.rejects(x.call('orch_start_workflow', { ...args, members: ['m1', 'm3'] }), /编排员不参与/);
  const started = await x.call('orch_start_workflow', { ...args, sameKindReason: '实测只有 Claude 可用' });
  assert.equal(started.runId, 'run-1');
  assert.equal(x.meetingObj.serialWorkflow.deliveryKind, 'file');
  assert.deepEqual(x.meetingObj.serialWorkflow.deliveryStages.map(s => s.members[0]), ['m2', 'm2', 'm3']);
  assert.match(x.engineCalls[0][1], /单测覆盖零速率/);
  assert.match(x.engineCalls[0][1], /验证不通过不得合并/);
  await assert.rejects(x.call('orch_start_workflow', { ...args, sameKindReason: 'x' }), /已有工作段在进行/);
});

test('review verdicts reach the orchestrator, budget exhaustion pauses the workflow, and a grant resumes dispatch', async t => {
  const x = fixture(t, { settings: { requireConfirm: false, roundCap: 2 } });
  await x.call('orch_add_member', { role: '开发位', kind: 'codex', tier: 'fast' });
  await x.call('orch_add_member', { role: '审核位', kind: 'claude', tier: 'fast' });
  await x.call('orch_start_workflow', { name: 'PF', preset: 'development', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const stages = x.meetingObj.serialWorkflow.deliveryStages;
  const d = (m, outcome, n) => ({ [m]: { memberId: m, outcome, path: `/runs/step-${n}/${m}/${outcome === 'rework' ? '需返工' : '已交付'}.md` } });
  const base = [{ id: 'a', index: 0, members: ['m2'], deliveries: d('m2', 'ready', 1) }, { id: 'b', index: 1, members: ['m2'], deliveries: d('m2', 'ready', 2) }, { id: 'c', index: 2, members: ['m3'], deliveries: d('m3', 'rework', 3) }];
  x.writeRun({ id: 'run-1', kind: 'file', status: 'running', stages, steps: [...base, { id: 'd', index: 1, members: ['m2'], createdAt: 1, deliveries: {} }] });
  x.service.reconcile('mt1');
  await wait(10);
  assert.ok(x.dispatches.some(a => /审核判定需返工/.test(a.userInput)), 'rework verdict is announced');
  x.writeRun({ id: 'run-1', kind: 'file', status: 'running', stages, steps: [...base, { id: 'd', index: 1, members: ['m2'], deliveries: d('m2', 'ready', 4) }, { id: 'e', index: 2, members: ['m3'], deliveries: d('m3', 'rework', 5) }, { id: 'f', index: 1, members: ['m2'], createdAt: 1, deliveries: {} }] });
  x.service.reconcile('mt1');
  let status = await x.call('orch_status');
  assert.equal(status.status, 'halted');
  assert.equal(status.halt.reason, 'budget_rounds');
  assert.ok(x.engineCalls.some(c => c[0] === 'stop'), 'Hub pauses the workflow itself');
  await assert.rejects(x.call('orch_control_workflow', { action: 'continue' }), /已暂停|额度/);
  await x.call('orch_report', { kind: 'need_decision', summary: '两轮都被判返工，建议再给 2 轮' });
  await x.service.userAction('mt1', 'grant', { rounds: 2 });
  status = await x.call('orch_status');
  assert.equal(status.status, 'running');
  assert.equal(status.budget.roundCap, 4);
  await x.call('orch_control_workflow', { action: 'continue' });
  assert.ok(x.engineCalls.some(c => c[0] === 'resume'));
});

test('notices wait while the orchestrator is busy or the user just spoke, and two empty wakes halt for a decision', async t => {
  const x = fixture(t, { settings: { requireConfirm: false } });
  x.busy.add('s-orch');
  x.service.ledgerFor('mt1');
  const L = require('../core/orchestration/ledger');
  L.enqueue(x.service.ledgerFor('mt1'), 'n1', '第一条');
  assert.equal(await x.service.deliver('mt1'), false);
  x.busy.delete('s-orch');
  x.service.userMessage('mt1', { text: '进展如何' });
  assert.equal(await x.service.deliver('mt1'), false, 'quiet period right after the user speaks');
  x.advance(6000);
  assert.equal(await x.service.deliver('mt1'), true);
  assert.equal(x.dispatches.length, 1);
  L.enqueue(x.service.ledgerFor('mt1'), 'n2', '第二条');
  await x.service.deliver('mt1');
  L.enqueue(x.service.ledgerFor('mt1'), 'n3', '第三条');
  await x.service.deliver('mt1');
  const status = await x.call('orch_status');
  assert.equal(status.status, 'halted');
  assert.equal(status.halt.reason, 'no_progress');
  assert.match(x.dispatches.at(-1).userInput, /暂停派活/);
  x.setDispatchResult({ status: 'no_sent' });
  L.enqueue(x.service.ledgerFor('mt1'), 'n4', '第四条');
  await x.service.deliver('mt1');
  assert.equal(x.service.ledgerFor('mt1').notices.find(n => n.key === 'n4').state, 'queued', 'failed delivery is retried, not dropped');
});

test('final report is refused until every segment has a reviewer conclusion', async t => {
  const x = fixture(t, { settings: { requireConfirm: false } });
  await assert.rejects(x.call('orch_report', { kind: 'final', summary: '都好了' }), /不能结项/);
  await x.call('orch_add_member', { role: '调研', kind: 'codex', tier: 'fast' });
  await x.call('orch_add_member', { role: '收口', kind: 'claude', tier: 'fast' });
  await x.call('orch_start_workflow', { name: '调研', preset: 'research', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  await assert.rejects(x.call('orch_report', { kind: 'final', summary: '都好了' }), /没结束/);
  const stages = x.meetingObj.serialWorkflow.deliveryStages;
  x.writeRun({ id: 'run-1', kind: 'serial', status: 'done', stages, steps: stages.map((s, i) => ({ id: 's' + i, index: i, members: s.members, deliveries: Object.fromEntries(s.members.map(m => [m, { memberId: m, outcome: 'ready', path: `/r/${i}/${m}/已交付.md` }])) })) });
  x.service.reconcile('mt1');
  const result = await x.call('orch_report', { kind: 'final', summary: '调研完成，结论见文件' });
  assert.equal(result.status, 'finished');
});

test('asking a member is blocked while it works in the workflow and the answer file is announced', async t => {
  const x = fixture(t, { settings: { requireConfirm: false } });
  await x.call('orch_add_member', { role: '开发位', kind: 'codex', tier: 'fast' });
  await x.call('orch_add_member', { role: '审核位', kind: 'claude', tier: 'fast' });
  await x.call('orch_start_workflow', { name: 'PF', preset: 'development', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  await assert.rejects(x.call('orch_ask_member', { memberId: 'm2', question: '进度？' }), /正在工作流里干活/);
  const ask = await x.call('orch_ask_member', { memberId: 'm3', question: '审查重点？' });
  const sentAsk = x.dispatches.find(a => a.workflowRun?.kind === 'orchestration');
  assert.equal(sentAsk.workflowRun.runId, ask.askId);
  assert.deepEqual(sentAsk.targetMemberIds, ['m3']);
  await assert.rejects(x.call('orch_ask_member', { memberId: 'm3', question: '再问' }), /没回答的提问/);
  const fakeOrch = { state: { messages: [
    { role: 'user', turnNum: 7, dispatch: { kind: 'orchestration', runId: ask.askId } },
    { role: 'assistant', turnNum: 7, memberId: 'm3', sid: 's-3', answer: { state: 'delivered' } },
  ] }, answerFileFor: () => ({ ready: '/answers/turn-7/m3/回答.md' }) };
  x.service.onAnswersChanged('mt1', fakeOrch);
  const status = await x.call('orch_status');
  assert.equal(status.asks[0].status, 'answered');
  assert.equal(status.asks[0].answerPath, '/answers/turn-7/m3/回答.md');
});

test('user words confirm a pending plan; naming a member copies the orchestrator', async t => {
  const x = fixture(t);
  await x.call('orch_propose_plan', planArgs);
  x.service.userMessage('mt1', { text: '确认' });
  assert.equal((await x.call('orch_status')).status, 'running');
  x.service.userMessage('mt1', { text: '@m2 先看测试', direct: ['m2'] });
  assert.ok(x.service.ledgerFor('mt1').notices.some(n => /直接对 m2 说/.test(n.text)));
});

test('a restarted Hub marks unconfirmed notices and tells the orchestrator about the active segment', async t => {
  const first = fixture(t, { settings: { requireConfirm: false } });
  await first.call('orch_add_member', { role: '开发位', kind: 'codex', tier: 'fast' });
  await first.call('orch_add_member', { role: '审核位', kind: 'claude', tier: 'fast' });
  await first.call('orch_start_workflow', { name: 'PF', preset: 'development', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const ledger = first.service.ledgerFor('mt1');
  const L = require('../core/orchestration/ledger');
  L.enqueue(ledger, 'pending', '未确认送达的通知');
  L.markSending(ledger, [ledger.notices.at(-1).id]);
  Store.save(first.dir, ledger);
  const second = fixture(t, { settings: { requireConfirm: false }, dataDir: first.dir });
  second.meetingObj.serialWorkflow = first.meetingObj.serialWorkflow;
  second.service.tickMeeting('mt1');
  await wait(10);
  const text = second.dispatches.map(a => a.userInput).join('\n');
  assert.match(text, /可能已送达/);
  assert.match(text, /Hub 已重启/);
});

test('ending orchestration pauses the workflow and stops notices; resuming restores the room', async t => {
  const x = fixture(t, { settings: { requireConfirm: false } });
  await x.call('orch_add_member', { role: '开发位', kind: 'codex', tier: 'fast' });
  await x.call('orch_add_member', { role: '审核位', kind: 'claude', tier: 'fast' });
  await x.call('orch_start_workflow', { name: 'PF', preset: 'development', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const view = await x.service.userAction('mt1', 'end');
  assert.equal(view.status, 'ended');
  assert.ok(x.engineCalls.some(c => c[0] === 'stop'));
  await assert.rejects(x.call('orch_ask_member', { memberId: 'm3', question: 'x' }), /编排已结束/);
  const before = x.dispatches.length;
  require('../core/orchestration/ledger').enqueue(x.service.ledgerFor('mt1'), 'late', '结束后的通知');
  assert.equal(await x.service.deliver('mt1'), false);
  assert.equal(x.dispatches.length, before);
  assert.equal((await x.service.userAction('mt1', 'resume')).status, 'running');
});
