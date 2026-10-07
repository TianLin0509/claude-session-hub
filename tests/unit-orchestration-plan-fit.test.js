'use strict';
// 编排计划与模板匹配（2026-10-06 首次真实编排复盘）：计划时核算轮数、文件修改模板、收口结论。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ledger = require('../core/orchestration/ledger');
const Prompt = require('../core/orchestration/prompt');
const S = require('../core/workflow-settings');
const D = require('../core/delivery-workflow');
const { createDeliveryEngine } = require('../main/groupchat/delivery-engine');

const people = ['a', 'b', 'c'].map(memberId => ({ memberId, title: memberId, displayName: memberId }));
const ids = people.map(p => p.memberId);
const flush = () => new Promise(r => setImmediate(r));

test('plan budget check counts template steps and flags a plan the budget cannot finish', () => {
  // 复盘场景：两段资料调研 + 一段文件修改 + 一段 3 步自定义，默认 8 轮额度。
  const l = Ledger.create('m', {});
  Ledger.proposePlan(l, { summary: '提炼知识', segments: [
    { name: 'S1', preset: 'research', acceptance: 'a' },
    { name: 'S2', preset: 'research', acceptance: 'a' },
    { name: 'S3', preset: 'filework', acceptance: 'a' },
    { name: 'S4', preset: 'custom', steps: 3, acceptance: 'a' },
  ] });
  const check = Ledger.view(l).plan.budgetCheck;
  assert.equal(check.minRounds, 3 + 3 + 1 + 3);
  assert.equal(check.available, 8);
  assert.equal(check.ok, false);
  assert.match(check.text, /至少 10 轮/);
  assert.match(check.text, /额度至少 10 轮/);
  assert.match(Ledger.renderMarkdown(l), /Hub 核算/);
  // custom 没写 steps 按 1 步计；有审核循环的模板正好用满额度时提示没有返工余量。
  const tight = Ledger.create('m', { roundCap: 2 });
  Ledger.proposePlan(tight, { summary: 'x', segments: [{ name: 'A', preset: 'filework', acceptance: 'a' }, { name: 'B', preset: 'custom', acceptance: 'a' }] });
  assert.equal(Ledger.budgetCheck(tight).minRounds, 2);
  assert.match(Ledger.budgetCheck(tight).text, /没有返工余量/);
});

test('budget check only counts segments that are not yet done', () => {
  const l = Ledger.create('m', { roundCap: 8 });
  Ledger.proposePlan(l, { summary: 'x', segments: [{ name: 'S1', preset: 'research', acceptance: 'a' }, { name: 'S2', preset: 'filework', acceptance: 'a' }] });
  const seg = Ledger.startSegment(l, { name: 'S1', preset: 'research', members: ['a', 'b'], planSegmentId: l.plan.segments[0].id });
  seg.status = 'completed'; seg.verdict = { decision: '通过' }; l.budget.roundsUsed = 3;
  const check = Ledger.budgetCheck(l);
  assert.equal(check.minRounds, 1); assert.equal(check.available, 5); assert.equal(check.ok, true);
  seg.verdict.decision = '需返工';
  assert.equal(Ledger.budgetCheck(l).minRounds, 4, 'a segment closed as 需返工 still needs work');
});

test('filework is a two-step serial template whose review loops back to the edit step', () => {
  const d = S.createPreset('filework', people);
  assert.equal(d.kind, 'serial');
  assert.deepEqual(d.rounds.map(r => [r.members[0], r.after]), [['a', 'next'], ['b', 'review']]);
  assert.match(d.rounds[0].prompt, /备份/); assert.match(d.rounds[0].prompt, /不合并、不推送/);
  assert.doesNotMatch(d.rounds.map(r => r.prompt).join(''), /worktree|SHA/);
  assert.equal(S.validate(d, ids), true);
  const c = S.toDeliveryConfig({}, d, ids);
  assert.deepEqual(S.fromConfig(c, people).rounds, d.rounds);
  // review 只能放在串行流程的最后一轮，且前面至少还有一轮。
  const bad = structuredClone(d); bad.rounds[0].after = 'review';
  assert.throws(() => S.validate(bad, ids), /接续规则/);
  const single = { enabled: true, kind: 'serial', presetId: 'custom', rounds: [{ name: 'x', members: ['a'], prompt: 'p', after: 'review' }] };
  assert.throws(() => S.validate(single, ids), /接续规则/);
  // 原有模板不受影响：资料调研仍是 3 步，措辞不再写死投研场景。
  const research = S.createPreset('research', people);
  assert.equal(research.rounds.length, 3);
  assert.doesNotMatch(research.rounds.map(r => r.prompt).join(''), /一手来源|只交付研究/);
});

test('ledger counts serial review loops by reviews and reads the closing decision', () => {
  const stages = [{ name: '修改与自查', after: 'next' }, { name: '独立审核', after: 'review' }];
  const st = (index, member, outcome, n) => ({ id: 's' + n, index, members: [member], deliveries: outcome ? { [member]: { memberId: member, outcome, path: `/r/${n}/${member}.md` } } : {} });
  const l = Ledger.create('m', {});
  const seg = Ledger.startSegment(l, { name: 'S3', preset: 'filework', members: ['a', 'b'] });
  seg.runId = 'run';
  let notices = Ledger.applyRun(l, { id: 'run', kind: 'serial', status: 'running', stages, steps: [st(0, 'a', 'ready', 1), st(1, 'b', 'rework', 2), st(0, 'a', null, 3)] });
  assert.equal(seg.status, 'rework'); assert.equal(seg.rounds, 1); assert.equal(seg.verdict.decision, '需返工');
  assert.match(notices[0].text, /需返工/);
  notices = Ledger.applyRun(l, { id: 'run', kind: 'serial', status: 'done', stages, steps: [st(0, 'a', 'ready', 1), st(1, 'b', 'rework', 2), st(0, 'a', 'ready', 3), st(1, 'b', 'ready', 4)] });
  assert.equal(seg.status, 'passed'); assert.equal(seg.rounds, 2); assert.equal(seg.verdict.decision, '通过');
  assert.match(notices[0].text, /审核通过/);
});

test('linear segments take the decision line from the closing delivery; 需返工 blocks the final report', () => {
  const stages = [{ name: '分工查证', after: 'next' }, { name: '形成结论', after: 'end' }];
  const files = { '/r/2/b.md': '<!-- hub-delivery:x -->\n\n**收口结论：需返工**\n覆盖不够。' };
  const run = { id: 'run', kind: 'serial', status: 'done', stages, steps: [
    { id: 's1', index: 0, members: ['a'], deliveries: { a: { outcome: 'ready', path: '/r/1/a.md' } } },
    { id: 's2', index: 1, members: ['b'], deliveries: { b: { outcome: 'ready', path: '/r/2/b.md' } } }] };
  const l = Ledger.create('m', {});
  Ledger.proposePlan(l, { summary: 'x', segments: [{ name: 'S1', preset: 'research', goal: 'g', acceptance: 'a' }] });
  const seg = Ledger.startSegment(l, { name: 'S1', preset: 'research', goal: 'g', acceptance: 'a', members: ['a', 'b'], planSegmentId: l.plan.segments[0].id });
  seg.runId = 'run';
  const notices = Ledger.applyRun(l, run, Date.now(), { readText: p => files[p] });
  assert.equal(seg.status, 'completed'); assert.equal(seg.verdict.decision, '需返工');
  assert.match(notices[0].text, /收口结论：需返工/);
  assert.match(Ledger.renderMarkdown(l), /需返工：\/r\/2\/b\.md/);
  assert.equal(Ledger.finalGate(l).ok, false);
  assert.equal(Ledger.parseDecision('收口结论: 通过'), '通过');
  assert.equal(Ledger.parseDecision('没有结论'), '');
  // 没写结论时如实提示，而不是默认通过。
  files['/r/2/b.md'] = '结论正文';
  const l2 = Ledger.create('m', {});
  const seg2 = Ledger.startSegment(l2, { name: 'S1', preset: 'research', members: ['a', 'b'] }); seg2.runId = 'run';
  assert.match(Ledger.applyRun(l2, run, Date.now(), { readText: p => files[p] })[0].text, /没有写明「收口结论」/);
});

test('goal text matches the template: filework never merges, linear templates ask for a decision line', () => {
  const file = Prompt.goalText({ goal: 'g', acceptance: 'a', preset: 'filework' });
  assert.match(file, /不合并、不推送/); assert.match(file, /备份/); assert.doesNotMatch(file, /合并到主干/);
  assert.match(Prompt.goalText({ goal: 'g', acceptance: 'a', preset: 'research' }), /收口结论：通过/);
  assert.doesNotMatch(Prompt.goalText({ goal: 'g', acceptance: 'a', preset: 'development' }), /收口结论/);
  const block = Prompt.orchestratorBlock({});
  for (const id of Ledger.PRESETS) assert.ok(block.includes(id), `orchestrator rules describe ${id}`);
  assert.match(block, /budgetCheck/); assert.match(block, /仍未回答的问题/);
  assert.match(Prompt.memberBlock({ role: 'x' }), /白话/);
});

test('delivery engine sends a filework rework back to the editor, not the reviewer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-filework-'));
  const draft = S.createPreset('filework', people);
  const m = { id: 'meeting', groupChat: true, subSessions: ['sa', 'sb', 'sc'], slotSpecs: people, serialWorkflow: S.toDeliveryConfig({}, draft, ids) };
  const calls = [];
  const e = createDeliveryEngine({
    meetingManager: { getMeeting: () => m, setParticipants: (_id, parts) => { m.participants = [...parts]; } },
    sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people,
    ensureMemberReady: async () => {}, sendToRenderer: () => {}, logger: { error: () => {} },
    getDispatcher: () => ({ dispatchGroupChatTurn: (_id, args) => { calls.push(args); args.targetMemberIds.forEach(memberId => args.onSubmission({ memberId, ok: true, sendStatus: 'submitted' })); return new Promise(() => {}); } }),
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(D.directory(dir, m.id), 'run.json'), 'utf8'));
  const deliver = (member, outcome = 'ready') => {
    const r = read(), step = r.steps.at(-1), p = D.paths(D.directory(dir, m.id), r, step, member);
    fs.writeFileSync(p.draft, D.header(r, step, member) + '\n\n结果', 'utf8'); fs.renameSync(p.draft, p[outcome]);
  };
  const advance = async () => { e.tick(m.id); await flush(); await flush(); };
  try {
    await e.start(m.id, 'goal');
    assert.deepEqual(calls[0].targetMemberIds, ['a']);
    assert.match(calls[0].userInput, /修改与自查/);
    deliver('a'); await advance();
    assert.deepEqual(calls[1].targetMemberIds, ['b']);
    assert.match(calls[1].userInput, /需返工\.md/, 'reviewer is told how to request rework');
    deliver('b', 'rework'); await advance();
    assert.deepEqual(calls[2].targetMemberIds, ['a'], 'rework returns to the edit step');
    deliver('a'); await advance();
    deliver('b'); await advance();
    assert.equal(read().status, 'done');
    assert.equal(Ledger.countRounds(read()), 2);
  } finally { e.dispose(); }
});
