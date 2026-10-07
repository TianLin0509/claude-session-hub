'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../core/orchestration/ledger');
const Prompt = require('../core/orchestration/prompt');

const plan = (extra = {}) => ({ summary: '做 PF 调度器并出报告', team: [{ role: '开发位', kind: 'codex' }, { role: '审核位', kind: 'claude' }],
  segments: [{ name: 'PF 实现', preset: 'development', goal: '实现', acceptance: '单测通过' }], ...extra });
const fileRun = (steps, status = 'running') => ({
  id: 'run-1', kind: 'file', status, error: status === 'paused' ? '已完成 3 轮审查仍需返工' : '',
  stages: [{ name: '开题', after: 'next' }, { name: '实现与自测', after: 'next' }, { name: '独立审查与合并', after: 'review' }],
  steps,
});
// 已有计划、正在编排中的账本。
const running = settings => Object.assign(Ledger.create('m', settings), { status: 'running' });
const step = (index, member, outcome, n) => ({ id: 'st' + n, index, members: [member], createdAt: 1, deliveries: outcome ? { [member]: { memberId: member, outcome, path: `/d/step-${n}/${member}/${outcome === 'rework' ? '需返工' : '已交付'}.md` } } : {} });

test('settings clamp to safe ranges and a new ledger waits for the first plan', () => {
  const s = Ledger.normalizeSettings({ roundCap: 999, timeCapMin: 1, maxMembers: 9, requireConfirm: true });
  assert.equal(s.roundCap, 30); assert.equal(s.timeCapMin, 15); assert.equal(s.maxMembers, 3); assert.equal('requireConfirm' in s, false);
  assert.equal(Ledger.create('m', {}).status, 'planning');
});

test('a plan takes effect when submitted; revisions take effect too; a halt stays until the user speaks', () => {
  const l = Ledger.create('m', {});
  assert.equal(Ledger.canDispatch(l).ok, true, 'the orchestrator may ask members before planning');
  assert.throws(() => Ledger.proposePlan(l, plan({ segments: [{ name: '无标准', preset: 'research' }] })), /验收标准/);
  assert.throws(() => Ledger.proposePlan(l, plan({ team: [1, 2, 3, 4].map(i => ({ role: 'r' + i })) })), /最多 3 位/);
  Ledger.proposePlan(l, plan({ team: [{ memberId: 'm2', role: '开发位' }], budget: { roundCap: 5, timeCapMin: 60 } }));
  assert.equal(l.status, 'running');
  assert.deepEqual(l.roles.m2, { role: '开发位', kind: '' });
  assert.equal(l.budget.roundCap, 5); assert.equal(l.budget.timeCapMs, 60 * 60000);
  Ledger.proposePlan(l, plan({ summary: '改了计划' }));
  assert.equal(l.status, 'running', 'a revised plan (e.g. skipping a member) needs no second confirmation');
  assert.equal(l.plan.version, 2);
  Ledger.halt(l, 'need_decision', '选 A 还是 B');
  Ledger.proposePlan(l, plan({ summary: '暂停中改计划' }));
  assert.equal(l.status, 'halted');
  assert.match(Ledger.canDispatch(l).reason, /回话/);
  Ledger.halt(l, 'budget_rounds');
  assert.match(Ledger.canDispatch(l).reason, /orch_grant_budget/);
});

test('legacy ledgers waiting for a confirmation become active on load', () => {
  const l = Ledger.create('m', {});
  l.settings.requireConfirm = true;
  l.plan = { version: 1, summary: '旧计划', team: [{ memberId: 'm3', role: '审核位' }], segments: [], budget: { roundCap: 4, timeCapMin: 30 } };
  l.status = 'awaiting_confirm';
  assert.equal(Ledger.migrate(l), true);
  assert.equal(l.status, 'running'); assert.equal(l.budget.roundCap, 4); assert.equal(l.roles.m3.role, '审核位');
  assert.equal('requireConfirm' in l.settings, false);
  assert.equal(Ledger.migrate(l), false, 'migration runs once');
  const empty = Object.assign(Ledger.create('m', {}), { status: 'awaiting_confirm' });
  Ledger.migrate(empty);
  assert.equal(empty.status, 'planning');
});

test('rounds count review steps for development and every completed step for serial templates', () => {
  const run = fileRun([step(0, 'm2', 'ready', 1), step(1, 'm2', 'ready', 2), step(2, 'm3', 'rework', 3), step(1, 'm2', 'ready', 4), step(2, 'm3', null, 5)]);
  assert.equal(Ledger.countRounds(run), 1);
  const serial = { id: 'r', kind: 'serial', stages: [{ after: 'next' }, { after: 'end' }], steps: [step(0, 'm2', 'ready', 1), step(1, 'm3', 'ready', 2)] };
  assert.equal(Ledger.countRounds(serial), 2);
  assert.equal(Ledger.reviewVerdict(run).outcome, 'rework');
});

test('applyRun reports rework once per review, pauses, and passes only on the reviewer verdict', () => {
  const l = running({});
  const seg = Ledger.startSegment(l, { name: 'PF', preset: 'development', members: ['m2', 'm3'] });
  seg.runId = 'run-1';
  const s3 = [step(0, 'm2', 'ready', 1), step(1, 'm2', 'ready', 2), step(2, 'm3', 'rework', 3)];
  let notices = Ledger.applyRun(l, fileRun([...s3, step(1, 'm2', null, 4)]));
  assert.equal(seg.status, 'rework'); assert.equal(notices.length, 1); assert.match(notices[0].text, /需返工/);
  notices = Ledger.applyRun(l, fileRun([...s3, step(1, 'm2', 'ready', 4), step(2, 'm3', null, 5)]));
  assert.equal(notices.length, 0, 'a build delivery inside a rework round is not a new verdict');
  notices = Ledger.applyRun(l, fileRun([...s3, step(1, 'm2', 'ready', 4), step(2, 'm3', 'ready', 5)], 'done'));
  assert.equal(seg.status, 'passed'); assert.match(notices[0].text, /审核通过/); assert.match(seg.verdictPath, /已交付\.md$/);
  assert.equal(l.budget.roundsUsed, 2);
});

test('budget halts, grants resume, and time only accrues while work is in flight', () => {
  const l = running({ roundCap: 2, timeCapMin: 15 });
  l.budget.roundsUsed = 2;
  assert.equal(Ledger.overBudget(l), 'budget_rounds');
  Ledger.halt(l, 'budget_rounds');
  assert.equal(Ledger.canDispatch(l).ok, false);
  l.budgetIntent = { roundCap: 2 };
  Ledger.grant(l, { rounds: 3 });
  assert.equal(l.status, 'running'); assert.equal(l.budget.roundCap, 5); assert.equal(Ledger.overBudget(l), null);
  assert.equal(l.budgetIntent.roundCap, 5, 'a later plan keeps the granted cap instead of the older stated limit');
  l.budget.lastTickAt = 0;
  Ledger.tick(l, 50000, { working: false });
  assert.equal(l.budget.activeMs, 0);
  Ledger.tick(l, 80000, { working: true });
  assert.equal(l.budget.activeMs, 30000);
});

test('notices dedupe by key, survive restart as uncertain, and two empty wakes count as no progress', () => {
  const l = running({});
  assert.equal(Ledger.enqueue(l, 'k1', 'a'), true);
  assert.equal(Ledger.enqueue(l, 'k1', 'a again'), false);
  const ids = Ledger.pendingNotices(l).map(n => n.id);
  Ledger.markSending(l, ids);
  assert.equal(Ledger.pendingNotices(l).length, 0);
  assert.equal(Ledger.recoverAfterRestart(l), 1);
  assert.equal(Ledger.pendingNotices(l)[0].state, 'uncertain');
  assert.match(Prompt.noticeText(Ledger.pendingNotices(l)), /可能已送达/);
  Ledger.markSent(l, ids);
  assert.equal(l.notices.length, 0);
  assert.equal(Ledger.noteWake(l), 1);
  assert.equal(Ledger.noteWake(l), 2);
  l.progressSeq += 1;
  assert.equal(Ledger.noteWake(l), 0);
});

test('final report needs every segment closed and a reviewer conclusion file', () => {
  const l = running({});
  assert.equal(Ledger.finalGate(l).ok, false);
  Ledger.proposePlan(l,{summary:'A',segments:[{name:'A',preset:'development',goal:'g',acceptance:'a'}]});
  const seg = Ledger.startSegment(l, { name: 'A', preset: 'development', goal:'g',acceptance:'a',members: [] });
  assert.match(Ledger.finalGate(l).reason, /未完成/);
  seg.status = 'passed';
  assert.match(Ledger.finalGate(l).reason, /缺审核证据/);
  seg.verdictPath = '/x/已交付.md';
  assert.equal(Ledger.finalGate(l).ok, true);
});

test('orchestrator rules describe the role and the enforced limits; goal text forbids merging', () => {
  const block = Prompt.orchestratorBlock({ ledgerFile: 'ledger.md' });
  assert.match(block, /编排员/); assert.match(block, /orch_status/); assert.match(block, /计划账本：ledger\.md/);
  for (const tool of ['orch_restart_member', 'orch_grant_budget', 'skip', 'need_decision']) assert.ok(block.includes(tool), tool);
  assert.match(block, /由你判断哪里需要田哥/); assert.match(block, /田哥的回话就是指令/);
  assert.doesNotMatch(block, /确认后执行|仅给田哥|等待明确恢复/);
  const goal = Prompt.goalText({ goal: '做 X', acceptance: '测试通过', preset: 'development' });
  assert.match(goal, /验收标准/); assert.match(goal, /审查位独立验证候选通过后/); assert.match(goal, /验证不通过不得合并/);
  assert.match(Ledger.renderMarkdown(Ledger.create('m', {})), /计划账本/);
});

test('review: a plan with enough budget lifts a budget halt; old halted pending plans activate on load', () => {
  const l = running({ roundCap: 2 });
  l.budget.roundsUsed = 2;
  Ledger.halt(l, 'budget_rounds');
  Ledger.proposePlan(l, plan({ budget: { roundCap: 2, timeCapMin: 180 } }));
  assert.equal(l.status, 'halted', 'still over budget');
  Ledger.proposePlan(l, plan({ budget: { roundCap: 20, timeCapMin: 180 } }));
  assert.equal(l.status, 'running'); assert.equal(l.budget.roundCap, 20, 'exactly the cap the user named, no extra grant needed');
  const old = running({});
  old.plan = { version: 2, confirmedVersion: 1, confirmedAt: 1, summary: '暂停中改的计划', team: [{ memberId: 'm4', role: '收口' }], segments: [], budget: { roundCap: 6, timeCapMin: 60 } };
  Ledger.halt(old, 'need_decision');
  assert.equal(Ledger.migrate(old), true);
  assert.equal(old.status, 'halted'); assert.equal(old.roles.m4.role, '收口'); assert.equal(old.budget.roundCap, 6);
  assert.equal('confirmedVersion' in old.plan, false);
});

test('review: a grant with amounts lifts only budget halts; a plain resume lifts any halt', () => {
  const l = running({ roundCap: 2 });
  Ledger.halt(l, 'user_pause');
  assert.equal(Ledger.grant(l, { rounds: 3 }), false);
  assert.equal(l.status, 'halted'); assert.equal(l.budget.roundCap, 5);
  assert.equal(Ledger.resume(l), true);
  assert.equal(l.status, 'running');
});
