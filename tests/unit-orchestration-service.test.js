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
    orchestration: { enabled: true, memberId: 'm1', sessionId: 's-orch', settings: { roundCap: 3, timeCapMin: 60, ...settings } },
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
    skip: async (id, memberId) => { engineCalls.push(['skip', memberId]); return { status: 'running' }; },
  };
  const restarts = [];
  let restartResult = sid => ({ id: sid, status: 'idle' });
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
    restartSession: async sid => { restarts.push(sid); return restartResult(sid); },
    ensureMemberReady: async (m, memberId) => { restarts.push('wake:' + memberId); },
  });
  t.after(() => service.stop());
  const call = async (name, args = {}, caller = 's-orch') => {
    if(name==='orch_start_workflow' && !service.ledgerFor('mt1').plan)
      await service.invokeTool({name:'orch_propose_plan',arguments:{summary:args.name,segments:[args]},callerSessionId:'s-orch'});
    return service.invokeTool({ name, arguments: args, callerSessionId: caller });
  };
  const addExisting = async (args) => {
    const made = await addMeetingSubInternal('mt1', args.kind, {model:args.model});
    meetingObj.participants=[0];
    const memberId=meetingObj.slotSpecs.at(-1).memberId;
    service.ledgerFor('mt1').roles[memberId]={role:args.role,kind:args.kind};
    return {memberId,session:made.session};
  };
  return { dir, service, call, addExisting, meetingObj, dispatches, engineCalls, busy, writeRun, sent, sessions, restarts,
    advance: ms => { clock += ms; }, setDispatchResult: r => { dispatchResult = r; }, setRestartResult: fn => { restartResult = fn; } };
}
const planArgs = { summary: '调研并实现', team: [{ memberId:'m2', role: '开发位' }, { memberId:'m3', role: '审核位' }],
  segments: [{ name: 'PF 实现', preset: 'development', goal: '实现 PF', acceptance: '单测通过' }] };

test('lightweight: a new task starts with defaults and archives the previous task evidence',async t=>{
  const x=fixture(t,{settings:{roundCap:8,timeCapMin:180}});
  const ledger=x.service.ledgerFor('mt1');
  ledger.status='finished';ledger.budget.roundCap=10;ledger.budget.roundsUsed=10;ledger.budget.timeCapMs=30*60000;
  ledger.plan={version:1,summary:'上一个任务'};ledger.segments=[{name:'旧任务',status:'passed'}];
  x.service.userMessage('mt1',{text:'接下来帮我分析新需求'});
  assert.equal(ledger.budget.roundCap,8);assert.equal(ledger.budget.roundsUsed,0);assert.equal(ledger.budget.timeCapMs,180*60000);
  assert.equal(ledger.plan,null);assert.deepEqual(ledger.segments,[]);assert.equal(ledger.taskHistory[0].budget.roundCap,10);
});

test('only the orchestrator session may call tools; a submitted plan takes effect without any UI confirmation', async t => {
  const x = fixture(t);
  await assert.rejects(x.call('orch_status', {}, 's-other'), /只有编排群里的编排员/);
  await assert.rejects(x.call('orch_add_member', { role: '开发位', kind: 'codex' }), /已有成员/);
  await x.addExisting({role:'',kind:'codex'});await x.addExisting({role:'',kind:'claude'});
  assert.equal((await x.call('orch_status')).status, 'planning');
  await assert.rejects(x.service.invokeTool({ name: 'orch_start_workflow', arguments: { name: 'a', preset: 'research', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] }, callerSessionId: 's-orch' }), /计划工作段/, 'work still has to match a submitted plan');
  const proposed = await x.call('orch_propose_plan', planArgs);
  assert.equal(proposed.status, 'running');
  assert.match(proposed.note, /直接派工/);
  const started = await x.call('orch_start_workflow', { ...planArgs.segments[0], members: ['m2', 'm3'] });
  assert.equal(started.runId, 'run-1');
  await assert.rejects(x.service.userAction('mt1', 'confirm'), /未知操作/, 'there is no confirm button any more');
});

test('existing members keep the orchestrator as the only recipient and plan roles are recorded', async t => {
  const x = fixture(t);
  const a = await x.addExisting({ role: '开发位', kind: 'codex', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
  await x.addExisting({ role: '复核', kind: 'claude', tier: 'fast' });
  await assert.rejects(x.call('orch_add_member', { role: '多余', kind: 'codex' }), /已有成员/);
  assert.equal(a.memberId, 'm2');
  assert.deepEqual(x.meetingObj.participants, [0]);
  const status = await x.call('orch_status');
  assert.equal(status.members.find(m => m.memberId === 'm2').role, '开发位');
  assert.match(Rules.rulesFor(x.dir, x.meetingObj, 'm1'), /你是本群的编排员/);
  assert.match(Rules.rulesFor(x.dir, x.meetingObj, 'm2'), /开发位/);
});

test('development uses distinct existing members even with the same backend', async t => {
  const x = fixture(t);
  await x.addExisting({ role: '开发位', kind: 'claude', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
  const args = { name: 'PF', preset: 'development', goal: '实现 PF 调度', acceptance: '单测覆盖零速率', members: ['m2', 'm3'] };
  await x.call('orch_propose_plan',{summary:'开发',segments:[args]});
  await assert.rejects(x.call('orch_start_workflow', { ...args, members: ['m1', 'm3'] }), /编排员不参与/);
  const started = await x.call('orch_start_workflow', { ...args, sameKindReason: '实测只有 Claude 可用' });
  assert.equal(started.runId, 'run-1');
  assert.equal(x.meetingObj.serialWorkflow.deliveryKind, 'file');
  assert.deepEqual(x.meetingObj.serialWorkflow.deliveryStages.map(s => s.members[0]), ['m2', 'm2', 'm3']);
  assert.match(x.engineCalls[0][1], /单测覆盖零速率/);
  assert.match(x.engineCalls[0][1], /验证不通过不得合并/);
  await assert.rejects(x.call('orch_start_workflow', { ...args, sameKindReason: 'x' }), /已有工作段在进行/);
});

test('review verdicts reach the orchestrator, budget exhaustion pauses the workflow, and the user\'s words let the orchestrator grant more', async t => {
  const x = fixture(t, { settings: { roundCap: 2 } });
  await x.addExisting({ role: '开发位', kind: 'codex', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
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
  await assert.rejects(x.call('orch_control_workflow', { action: 'continue' }), /orch_grant_budget/);
  x.service.userMessage('mt1', { text: '行，再给两轮' });
  assert.equal(x.service.ledgerFor('mt1').status, 'halted', 'talking does not lift a budget halt by itself');
  await assert.rejects(x.call('orch_grant_budget', { rounds: 2, sourceQuote: '田哥说随便加' }), /原话/);
  await assert.rejects(x.call('orch_grant_budget', { rounds: 99, sourceQuote: '再给两轮' }), /1–30/);
  const granted = await x.call('orch_grant_budget', { rounds: 2, sourceQuote: '再给两轮' });
  assert.equal(granted.status, 'running');
  assert.equal(granted.budget.roundCap, 4);
  await assert.rejects(x.call('orch_grant_budget', { rounds: 2, sourceQuote: '再给两轮' }), /已经用来追加过/);
  await x.call('orch_control_workflow', { action: 'continue' });
  assert.ok(x.engineCalls.some(c => c[0] === 'resume'));
});

test('notices wait while the orchestrator is busy or the user just spoke, and two empty wakes halt until the user replies', async t => {
  const x = fixture(t);
  x.busy.add('s-orch');
  x.service.ledgerFor('mt1').status = 'running';
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
  assert.match(x.dispatches.at(-1).userInput, /等他在输入框回话/);
  x.setDispatchResult({ status: 'no_sent' });
  L.enqueue(x.service.ledgerFor('mt1'), 'n4', '第四条');
  await x.service.deliver('mt1');
  assert.equal(x.service.ledgerFor('mt1').notices.find(n => n.key === 'n4').state, 'queued', 'failed delivery is retried, not dropped');
  x.service.userMessage('mt1', { text: '你看着办，接着推进' });
  assert.equal(x.service.ledgerFor('mt1').status, 'running', 'the reply lifts the halt; the orchestrator decides what it means');
});

test('final report is refused until every segment has a reviewer conclusion', async t => {
  const x = fixture(t);
  await assert.rejects(x.call('orch_report', { kind: 'final', summary: '都好了' }), /不能结项/);
  await x.addExisting({ role: '调研', kind: 'codex', tier: 'fast' });
  await x.addExisting({ role: '收口', kind: 'claude', tier: 'fast' });
  await x.call('orch_start_workflow', { name: '调研', preset: 'research', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  await assert.rejects(x.call('orch_report', { kind: 'final', summary: '都好了' }), /未完成|审核/);
  const stages = x.meetingObj.serialWorkflow.deliveryStages;
  x.writeRun({ id: 'run-1', kind: 'serial', status: 'done', stages, steps: stages.map((s, i) => ({ id: 's' + i, index: i, members: s.members, deliveries: Object.fromEntries(s.members.map(m => [m, { memberId: m, outcome: 'ready', path: `/r/${i}/${m}/已交付.md` }])) })) });
  x.service.reconcile('mt1');
  const result = await x.call('orch_report', { kind: 'final', summary: '调研完成，结论见文件' });
  assert.equal(result.status, 'finished');
});

test('asking a member is blocked while it works in the workflow and the answer file is announced', async t => {
  const x = fixture(t);
  await x.addExisting({ role: '开发位', kind: 'codex', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
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

test('naming a member copies the orchestrator and does not lift a halt', async t => {
  const x = fixture(t);
  await x.addExisting({role:'',kind:'codex'});await x.addExisting({role:'',kind:'claude'});
  await x.call('orch_propose_plan', planArgs);
  require('../core/orchestration/ledger').halt(x.service.ledgerFor('mt1'), 'need_decision', 'A 还是 B');
  x.service.userMessage('mt1', { text: '@m2 先看测试', direct: ['m2'] });
  assert.ok(x.service.ledgerFor('mt1').notices.some(n => /直接对 m2 说/.test(n.text)));
  assert.equal(x.service.ledgerFor('mt1').status, 'halted');
  x.service.userMessage('mt1', { text: 'B' });
  assert.equal(x.service.ledgerFor('mt1').status, 'running');
});

test('a restarted Hub marks unconfirmed notices and tells the orchestrator about the active segment', async t => {
  const first = fixture(t);
  await first.addExisting({ role: '开发位', kind: 'codex', tier: 'fast' });
  await first.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
  await first.call('orch_start_workflow', { name: 'PF', preset: 'development', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const ledger = first.service.ledgerFor('mt1');
  const L = require('../core/orchestration/ledger');
  L.enqueue(ledger, 'pending', '未确认送达的通知');
  L.markSending(ledger, [ledger.notices.at(-1).id]);
  Store.save(first.dir, ledger);
  const second = fixture(t, { dataDir: first.dir });
  second.meetingObj.serialWorkflow = first.meetingObj.serialWorkflow;
  second.service.tickMeeting('mt1');
  await wait(10);
  const text = second.dispatches.map(a => a.userInput).join('\n');
  assert.match(text, /可能已送达/);
  assert.match(text, /Hub 已重启/);
});

test('ending orchestration pauses the workflow and stops notices; resuming restores the room', async t => {
  const x = fixture(t);
  await x.addExisting({ role: '开发位', kind: 'codex', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
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

test('a member whose turn ended without a delivery is reported to the orchestrator after a short grace', async t => {
  const x = fixture(t);
  await x.addExisting({ role: '调研位', kind: 'claude', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
  await x.call('orch_start_workflow', { name: '调研', preset: 'research', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const stages = x.meetingObj.serialWorkflow.deliveryStages;
  x.writeRun({ id: 'run-1', kind: 'serial', status: 'running', stages, steps: [{ id: 'st1', index: 0, members: ['m2', 'm3'], createdAt: 1,
    dispatches: [{ state: 'settled', chatStatus: 'completed' }], deliveries: { m2: { memberId: 'm2', outcome: 'ready', path: '/r/m2/已交付.md' } } }] });
  x.busy.add('s-3');
  x.service.tickMeeting('mt1');
  x.advance(120000);
  x.service.tickMeeting('mt1');
  assert.ok(!x.service.ledgerFor('mt1').notices.some(n => /没有交付文件/.test(n.text)), 'a member still working is not reported');
  x.busy.delete('s-3');
  x.service.tickMeeting('mt1');
  x.advance(91000);
  x.service.tickMeeting('mt1');
  await wait(10);
  await x.service.deliver('mt1');
  const said = [...x.dispatches.map(a => a.userInput), ...x.service.ledgerFor('mt1').notices.map(n => n.text)].join('\n');
  assert.match(said, /m3（审核位）.*没有交付文件/, 'the idle member is reported once the grace passes');
});

test('review fixes: failed asks are released, finished rooms reopen, repeated pauses still notify, ending restores plain routing', async t => {
  const x = fixture(t);
  await x.addExisting({ role: '开发位', kind: 'codex', tier: 'fast' });
  await x.addExisting({ role: '审核位', kind: 'claude', tier: 'fast' });
  // 1. 发送失败的单独提问不留挂起记录
  x.setDispatchResult({ status: 'no_sent', reason: '会话不可用' });
  await x.call('orch_ask_member', { memberId: 'm3', question: '在吗？' });
  await wait(10);
  const asked = x.service.ledgerFor('mt1').asks.at(-1);
  assert.equal(asked.status, 'failed');
  x.setDispatchResult({ status: 'completed', turnNum: 2, results: [{ status: 'completed' }] });
  await x.call('orch_ask_member', { memberId: 'm3', question: '再问一次' });
  // 2. 同一原因第二次暂停仍会通知编排员
  await x.call('orch_start_workflow', { name: 'PF', preset: 'development', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const L = require('../core/orchestration/ledger');
  const stages = x.meetingObj.serialWorkflow.deliveryStages;
  const run = status => ({ id: 'run-1', kind: 'file', status, error: status === 'paused' ? '成员报告阻塞' : '', stages, steps: [{ id: 'a', index: 0, members: ['m2'], deliveries: {} }] });
  x.writeRun(run('paused')); x.service.reconcile('mt1');
  x.writeRun(run('running')); x.service.reconcile('mt1');
  x.writeRun(run('paused')); x.service.reconcile('mt1');
  const pausedKeys = x.service.ledgerFor('mt1').seen.filter(k => /:paused:/.test(k));
  assert.equal(new Set(pausedKeys).size, 2, 'each pause has its own notice');
  // 3. 结束编排：工作流消息路由关闭；恢复后打开
  await x.service.userAction('mt1', 'end');
  assert.equal(x.meetingObj.serialWorkflow.enabled, false);
  await x.service.userAction('mt1', 'resume');
  assert.equal(x.meetingObj.serialWorkflow.enabled, true);
  // 4. 结项后田哥提出新要求，编排重新开放，编排员可以提交新计划
  const ledger = x.service.ledgerFor('mt1');
  ledger.status = 'finished';
  x.service.userMessage('mt1', { text: '再加一个 RR 与 PF 的对比图' });
  assert.equal(ledger.status, 'running');
  ledger.status = 'finished';
  const plan = await x.call('orch_propose_plan', { summary: '补一张对比图', segments: [{ name: '对比图', preset: 'custom', acceptance: '图里有两条曲线' }] });
  assert.equal(plan.version, 1,'new task uses a fresh plan; prior evidence is archived');
  assert.equal(L.canDispatch(ledger).ok, true);
});

test('the tool endpoint path is known before the bridge starts', t => {
  const x = fixture(t);
  const opts = x.service.launchOptions('codex', 'sid-early');
  assert.match(opts.codexMcpEntries[0].env.HUB_ORCH_ENDPOINT_FILE, /orchestration[\\/]bridge-endpoint\.json$/);
});

test('lightweight: existing roster is fixed and plan roles bind to member IDs', async t => {
  const x=fixture(t);
  await x.addExisting({role:'',kind:'codex'});
  await x.addExisting({role:'',kind:'claude'});
  await assert.rejects(x.call('orch_add_member',{kind:'codex',role:'实现'}),/已有成员|固定/);
  await x.call('orch_propose_plan',{...planArgs,team:[{memberId:'m2',role:'实现位'},{memberId:'m3',role:'审核位'}]});
  assert.equal((await x.call('orch_status')).members.find(m=>m.memberId==='m2').role,'实现位');
  assert.equal(x.meetingObj.subSessions.length,3);
});

test('lightweight: a natural-language budget takes effect with the submitted plan', async t => {
  const x=fixture(t);
  x.service.userMessage('mt1',{text:'做一个小功能，允许10轮以内迭代，最多半小时。'});
  await x.call('orch_propose_plan',{summary:'实现小功能',segments:[{name:'功能',preset:'custom',goal:'功能',acceptance:'通过'}]});
  const after=await x.call('orch_status');
  assert.equal(after.plan.budget.roundCap,10);assert.equal(after.plan.budget.timeCapMin,30);
  assert.equal(after.budget.roundCap,10);assert.equal(after.budget.minutesCap,30);
});

test('lightweight: any reply to the orchestrator lifts a pause; the orchestrator decides what it means', async t => {
  const x=fixture(t);
  const L=require('../core/orchestration/ledger');
  for (const reason of ['user_pause','need_decision','no_progress','runtime_error','repeated_failure']) {
    x.service.ledgerFor('mt1').status='running';
    L.halt(x.service.ledgerFor('mt1'),reason);
    x.service.userMessage('mt1',{text:'deepseek有故障，后续跳过他就行，其他人继续'});
    assert.equal(x.service.ledgerFor('mt1').status,'running',reason);
  }
  L.halt(x.service.ledgerFor('mt1'),'budget_time');
  x.service.userMessage('mt1',{text:'你直接继续'});
  assert.equal(x.service.ledgerFor('mt1').status,'halted','budget needs an explicit grant through orch_grant_budget');
});

test('lightweight: changed acceptance cannot bypass a confirmed plan', async t => {
  const x=fixture(t);
  await x.addExisting({role:'实现',kind:'codex'});await x.addExisting({role:'审核',kind:'claude'});
  await x.call('orch_propose_plan',{...planArgs,team:[]});
  await assert.rejects(x.call('orch_start_workflow',{...planArgs.segments[0],acceptance:'有文件就行',members:['m2','m3']}),/确认计划|验收标准|计划工作段/);
  assert.equal(x.engineCalls.length,0);
});

test('lightweight: full plan coverage is required for final report', async t => {
  const x=fixture(t);
  const L=require('../core/orchestration/ledger');
  await x.call('orch_propose_plan',{summary:'两段',segments:[{name:'A',preset:'custom',goal:'a',acceptance:'a'},{name:'B',preset:'custom',goal:'b',acceptance:'b'}]});
  const l=x.service.ledgerFor('mt1');const s=L.startSegment(l,{...l.plan.segments[0],planSegmentId:l.plan.segments[0].id});
  s.status='completed';s.verdictPath='/a/已交付.md';
  await assert.rejects(x.call('orch_report',{kind:'final',summary:'全部完成'}),/B|计划/);
});

test('lightweight: runtime failures go to the orchestrator to handle; only repeated failures halt for the user', async t => {
  const x=fixture(t);
  await x.addExisting({role:'实现',kind:'codex'});await x.addExisting({role:'审核',kind:'claude'});
  const args={name:'PF',preset:'development',goal:'实现 PF',acceptance:'通过',members:['m2','m3']};
  await x.call('orch_propose_plan',{summary:'PF',segments:[args]});await x.call('orch_start_workflow',args);
  const stages=x.meetingObj.serialWorkflow.deliveryStages;
  const failed=(error)=>({id:'run-1',kind:'file',status:'paused',error,stages,steps:[{id:'s',index:1,members:['m2'],deliveries:{},dispatches:[{state:'settled',chatStatus:'error',receipts:{}}]}]});
  const resumed={id:'run-1',kind:'file',status:'running',stages,steps:[{id:'s',index:1,members:['m2'],deliveries:{}}]};
  x.writeRun(failed('Internal error'));x.service.reconcile('mt1');
  let status=await x.call('orch_status');
  assert.equal(status.status,'running','a runtime failure no longer locks the room');
  assert.match(status.currentRun.error,/Internal error/);assert.ok(status.currentRun.dispatches);
  assert.equal(status.currentRun.recovery.resumeAllowed,true);
  assert.match(status.currentRun.recovery.advice,/orch_restart_member/);
  assert.ok(x.service.ledgerFor('mt1').notices.some(n=>/skip/.test(n.text)&&/orch_restart_member/.test(n.text)),'the pause notice lists the recovery tools');
  await x.call('orch_control_workflow',{action:'continue'});
  for(let i=2;i<=4;i+=1){x.writeRun(resumed);x.service.reconcile('mt1');x.writeRun(failed('Internal error #'+i));x.service.reconcile('mt1');}
  status=await x.call('orch_status');
  assert.equal(status.status,'halted');assert.equal(status.halt.reason,'repeated_failure');
  assert.ok(x.service.ledgerFor('mt1').notices.some(n=>/已故障 4 次/.test(n.text)));
  x.service.userMessage('mt1',{text:'跳过他，其他人继续'});
  assert.equal(x.service.ledgerFor('mt1').status,'running');
  x.writeRun({id:'run-1',kind:'file',status:'paused',error:'成员报告阻塞',stages,steps:[{id:'s',index:1,members:['m2'],deliveries:{m2:{memberId:'m2',outcome:'blocked',path:'/step/m2/阻塞.md'}}}]});
  const blocked=await x.call('orch_status');
  assert.equal(blocked.currentRun.recovery.resumeAllowed,false);
  assert.match(blocked.currentRun.recovery.advice,/取消本段/);
});

test('the orchestrator can restart or wake a member and skip one that cannot recover', async t => {
  const x=fixture(t);
  await x.addExisting({role:'调研',kind:'codex'});await x.addExisting({role:'收口',kind:'claude'});
  await assert.rejects(x.call('orch_restart_member',{memberId:'m1'}),/不能重启自己/);
  await assert.rejects(x.call('orch_restart_member',{memberId:'m9'}),/没有成员/);
  const restarted=await x.call('orch_restart_member',{memberId:'m2'});
  assert.equal(restarted.action,'restarted');assert.deepEqual(x.restarts,['s-2']);
  x.sessions.get('s-3').status='dormant';
  assert.equal((await x.call('orch_restart_member',{memberId:'m3'})).action,'resumed');
  assert.equal(x.restarts.at(-1),'wake:m3');
  x.setRestartResult(()=>({ok:false,message:'旧进程迟迟未退出'}));
  await assert.rejects(x.call('orch_restart_member',{memberId:'m2'}),/迟迟未退出/);
  await assert.rejects(x.call('orch_control_workflow',{action:'skip',memberId:'m2'}),/没有进行中的工作段/);
  await x.call('orch_start_workflow',{name:'调研',preset:'research',goal:'g',acceptance:'a',members:['m2','m3']});
  await assert.rejects(x.call('orch_control_workflow',{action:'skip'}),/memberId/);
  const skipped=await x.call('orch_control_workflow',{action:'skip',memberId:'m2'});
  assert.equal(skipped.ok,true);assert.deepEqual(x.engineCalls.at(-1),['skip','m2']);
  assert.ok(x.service.ledgerFor('mt1').events.some(e=>/跳过 m2/.test(e.text)));
});

test('review: a changed natural-language budget applies with the next plan version',async t=>{
  const x=fixture(t);
  await x.addExisting({role:'实现',kind:'codex'});await x.addExisting({role:'审核',kind:'claude'});
  x.service.userMessage('mt1',{text:'允许10轮以内迭代'});
  await x.call('orch_propose_plan',planArgs);
  assert.equal(x.service.ledgerFor('mt1').budget.roundCap,10);
  x.service.userMessage('mt1',{text:'现在允许12轮以内迭代'});
  await x.call('orch_propose_plan',planArgs);
  assert.equal(x.service.ledgerFor('mt1').budget.roundCap,12);
});

test('review: an unsupported user budget is refused rather than truncated',async t=>{
  const x=fixture(t);
  await x.addExisting({role:'实现',kind:'codex'});await x.addExisting({role:'审核',kind:'claude'});
  await x.call('orch_propose_plan',planArgs);
  x.service.userMessage('mt1',{text:'允许40轮以内迭代'});
  await assert.rejects(x.call('orch_propose_plan',planArgs),/不会静默截断/);
  assert.equal(x.service.ledgerFor('mt1').budget.roundCap,3);
  assert.equal(x.service.ledgerFor('mt1').plan.version,1);
});

test('plan tool reports the Hub round check, and a filework segment runs edit then review without merge terms', async t => {
  const x = fixture(t);
  await x.addExisting({ role: '落盘', kind: 'codex' });
  await x.addExisting({ role: '审核', kind: 'claude' });
  const plan = await x.call('orch_propose_plan', { summary: '调研后落盘', segments: [
    { name: '调研', preset: 'research', goal: 'g', acceptance: 'a' },
    { name: '落盘', preset: 'filework', goal: '写入记忆', acceptance: '审核通过' }] });
  assert.equal(plan.budgetCheck.minRounds, 4);
  assert.equal(plan.budgetCheck.ok, false, 'default 3 rounds cannot finish research (3) + filework (1)');
  assert.match(plan.note, /不够/);
  const y = fixture(t);
  await y.addExisting({ role: '落盘', kind: 'codex' });
  await y.addExisting({ role: '审核', kind: 'claude' });
  await assert.rejects(y.call('orch_start_workflow', { name: '落盘', preset: 'filework', goal: 'g', acceptance: 'a', members: ['m2'] }), /两位/);
  await y.call('orch_start_workflow', { name: '落盘', preset: 'filework', goal: 'g', acceptance: 'a', members: ['m2', 'm3'] });
  const stages = y.meetingObj.serialWorkflow.deliveryStages;
  assert.deepEqual(stages.map(s => [s.members[0], s.after]), [['m2', 'next'], ['m3', 'review']]);
  assert.equal(y.meetingObj.serialWorkflow.deliveryKind, 'serial');
  const goal = y.engineCalls.find(c => c[0] === 'start')[1];
  assert.match(goal, /不合并、不推送/); assert.doesNotMatch(goal, /合并到主干/);
});
