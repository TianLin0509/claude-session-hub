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
const step = (index, member, outcome, n) => ({ id: 'st' + n, index, members: [member], createdAt: 1, deliveries: outcome ? { [member]: { memberId: member, outcome, path: `/d/step-${n}/${member}/${outcome === 'rework' ? '需返工' : '已交付'}.md` } } : {} });

test('settings clamp to safe ranges and default to plan confirmation', () => {
  const s = Ledger.normalizeSettings({ roundCap: 999, timeCapMin: 1, maxMembers: 9 });
  assert.equal(s.roundCap, 30); assert.equal(s.timeCapMin, 15); assert.equal(s.maxMembers, 3); assert.equal(s.requireConfirm, true);
  assert.equal(Ledger.create('m', {}).status, 'planning');
  assert.equal(Ledger.create('m', { requireConfirm: false }).status, 'running');
});

test('dispatch is gated on a confirmed plan, and plans need acceptance criteria per segment', () => {
  const l = Ledger.create('m', {});
  assert.equal(Ledger.canDispatch(l).ok, false);
  assert.throws(() => Ledger.proposePlan(l, plan({ segments: [{ name: '无标准', preset: 'research' }] })), /验收标准/);
  assert.throws(() => Ledger.proposePlan(l, plan({ team: [1, 2, 3, 4].map(i => ({ role: 'r' + i })) })), /最多 3 位/);
  Ledger.proposePlan(l, plan());
  assert.equal(l.status, 'awaiting_confirm');
  assert.match(Ledger.canDispatch(l).reason, /确认/);
  assert.equal(Ledger.confirmPlan(l), true);
  assert.equal(l.status, 'running');
  assert.equal(Ledger.canDispatch(l).ok, true);
  Ledger.proposePlan(l, plan({ summary: '改了计划' }));
  assert.equal(l.status, 'awaiting_confirm', 'a revised plan needs confirmation again');
});

test('rounds count review steps for development and every completed step for serial templates', () => {
  const run = fileRun([step(0, 'm2', 'ready', 1), step(1, 'm2', 'ready', 2), step(2, 'm3', 'rework', 3), step(1, 'm2', 'ready', 4), step(2, 'm3', null, 5)]);
  assert.equal(Ledger.countRounds(run), 1);
  const serial = { id: 'r', kind: 'serial', stages: [{ after: 'next' }, { after: 'end' }], steps: [step(0, 'm2', 'ready', 1), step(1, 'm3', 'ready', 2)] };
  assert.equal(Ledger.countRounds(serial), 2);
  assert.equal(Ledger.reviewVerdict(run).outcome, 'rework');
});

test('applyRun reports rework once per review, pauses, and passes only on the reviewer verdict', () => {
  const l = Ledger.create('m', { requireConfirm: false });
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
  const l = Ledger.create('m', { requireConfirm: false, roundCap: 2, timeCapMin: 15 });
  l.budget.roundsUsed = 2;
  assert.equal(Ledger.overBudget(l), 'budget_rounds');
  Ledger.halt(l, 'budget_rounds');
  assert.equal(Ledger.canDispatch(l).ok, false);
  Ledger.grant(l, { rounds: 3 });
  assert.equal(l.status, 'running'); assert.equal(l.budget.roundCap, 5); assert.equal(Ledger.overBudget(l), null);
  l.budget.lastTickAt = 0;
  Ledger.tick(l, 50000, { working: false });
  assert.equal(l.budget.activeMs, 0);
  Ledger.tick(l, 80000, { working: true });
  assert.equal(l.budget.activeMs, 30000);
});

test('notices dedupe by key, survive restart as uncertain, and two empty wakes count as no progress', () => {
  const l = Ledger.create('m', { requireConfirm: false });
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
  const l = Ledger.create('m', { requireConfirm: false });
  assert.equal(Ledger.finalGate(l).ok, false);
  const seg = Ledger.startSegment(l, { name: 'A', preset: 'development', members: [] });
  assert.match(Ledger.finalGate(l).reason, /没结束/);
  seg.status = 'passed';
  assert.match(Ledger.finalGate(l).reason, /缺审核结论/);
  seg.verdictPath = '/x/已交付.md';
  assert.equal(Ledger.finalGate(l).ok, true);
});

test('orchestrator rules describe the role and the enforced limits; goal text forbids merging', () => {
  const block = Prompt.orchestratorBlock({ settings: { roundCap: 6, timeCapMin: 90, requireConfirm: true } });
  assert.match(block, /编排员/); assert.match(block, /6 轮/); assert.match(block, /90 分钟/); assert.match(block, /orch_status/);
  const goal = Prompt.goalText({ goal: '做 X', acceptance: '测试通过', preset: 'development' });
  assert.match(goal, /验收标准/); assert.match(goal, /不要执行合并/);
  assert.match(Ledger.renderMarkdown(Ledger.create('m', {})), /计划账本/);
});
