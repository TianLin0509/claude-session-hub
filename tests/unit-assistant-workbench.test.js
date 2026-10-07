'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { AssistantWorkbench, dayOf, slotAt } = require('../core/hub-assistant/workbench');
const { DailySecretary } = require('../core/hub-assistant/daily-secretary');
function fixture(iso = '2026-10-07T07:39:00+08:00') {
  let time = Date.parse(iso); const kv = new Map(), calls = [], notices = [], scheduled = [];
  const a = { deps: { noReminderTimer: true }, store: { get: k => kv.has(k) ? structuredClone(kv.get(k)) : null, set: (k, v) => kv.set(k, structuredClone(v)) },
    sessions: () => [{ id: 's1', title: '真实中文会话', kind: 'claude', isOpen: true, status: 'idle', hubState: { state: 'idle', label: '就绪' } }, { id: 's2', title: '等你', isOpen: true, hubState: { state: 'wait', label: '等你响应' } }],
    memos: { view: () => ({ open: [{ id: 'm1', title: '记下的事' }], closed: [] }), digest: () => '原始备忘：记下的事' }, memory: { read: () => ({ user: '兴趣' }) },
    ownsAssistant: () => true, sessionBusy: () => false, send: async r => { calls.push(r); return { ok: true }; }, watches: { addNotice: n => notices.push(n) },
    podcasts: { startLesson: async r => ({ id: r.id }) } };
  a.workbench = new AssistantWorkbench({ assistant: a, now: () => time });
  a.secretary = new DailySecretary({ assistant: a, now: () => time, timer: fn => { scheduled.push(fn); return 1; }, clear: () => {} });
  return { a, calls, notices, kv, at: iso => { time = Date.parse(iso); }, now: () => time };
}
test('snapshot is explicitly cached; refresh preserves idle and wait without inventing completion', () => {
  const x = fixture(); assert.equal(x.a.workbench.snapshot().sessionSnapshotAt, null);
  const w = x.a.workbench.refresh(); assert.equal(w.sessions.length, 2); assert.equal(w.sessions[0].state, 'idle'); assert.equal(w.sessions[0].completed, undefined); assert.equal(x.calls.length, 0);
  x.at('2026-10-07T12:00:00+08:00'); assert.notEqual(x.a.workbench.snapshot().sessionSnapshotAt, x.now());
});
test('Beijing day and configurable slots remain correct across UTC midnight', () => {
  assert.equal(dayOf(Date.parse('2026-10-06T16:00:00Z')), '2026-10-07'); assert.equal(slotAt('2026-10-07', '08:00'), Date.parse('2026-10-07T00:00:00Z'));
  const x = fixture(); assert.throws(() => x.a.workbench.configure({ morning: '25:01' })); assert.throws(() => x.a.workbench.configure({ enabled: 'true' })); assert.throws(() => x.a.workbench.configure({ secret: 'x' }));
});
test('plan validates real sources; confirm and checkmarks do not mutate memos; yesterday cannot be changed', async () => {
  const x = fixture(), b = { kind: 'plan', day: '2026-10-07', text: '今日先做这件事', items: [{ title: '处理备忘', reason: '今天约定', sourceKind: 'memo', sourceId: 'm1' }] };
  await x.a.workbench.publish(b, { id: 'user-request' }); const d = x.a.workbench.read(); x.a.workbench.action({ action: 'done', itemId: d.plan.items[0].id }); x.a.workbench.action({ action: 'confirm' });
  assert.equal(x.a.workbench.read().plan.items[0].done, true); assert.ok(x.a.workbench.read().plan.confirmedAt); assert.equal(x.a.memos.view().open.length, 1);
  await assert.rejects(x.a.workbench.publish({ ...b, items: [{ ...b.items[0], sourceId: 'missing' }] }, { id: 'x' }), /来源不存在/);
  x.at('2026-10-08T08:00:00+08:00'); assert.throws(() => x.a.workbench.action({ action: 'confirm', day: '2026-10-07' }), /过期/);
});
test('context resolves exact selected session and rejects stale targets', () => { const x = fixture(); assert.match(x.a.workbench.context({ kind: 'session', id: 's1' }), /sessionId=s1/); assert.throws(() => x.a.workbench.context({ kind: 'session', id: 'missing' }), /不存在/); assert.throws(() => x.a.workbench.context({ kind: 'shell', id: 's1' })); });
test('revising a plan preserves completion of unchanged tasks and starts new tasks unchecked', async () => {
 const x = fixture(), b = { kind: 'plan', day: '2026-10-07', text: '先做备忘', items: [{ title: '处理备忘', reason: '约定', sourceKind: 'memo', sourceId: 'm1' }] };
 await x.a.workbench.publish(b, { id: 'one' }); const id = x.a.workbench.read().plan.items[0].id; x.a.workbench.action({ action: 'done', itemId: id }); x.a.workbench.action({ action: 'confirm' });
 await x.a.workbench.publish({ ...b, text: '加一件新事', items: [...b.items, { title: '新事项', reason: '刚补充' }] }, { id: 'two' }); const p = x.a.workbench.read().plan;
 assert.equal(p.items[0].done, true); assert.equal(p.items[0].id, id); assert.equal(p.items[1].done, false); assert.equal(p.confirmedAt, null);
});
test('scheduler prepares ahead of time, publishes at 08:00, and does not submit the same daily job twice', async () => {
  const x = fixture(); await x.a.secretary.tick(); assert.equal(x.calls.length, 1); assert.match(x.calls[0].requestId, /:lesson$/); assert.equal(x.notices.length, 0);
  x.at('2026-10-07T07:41:00+08:00'); await x.a.secretary.tick(); assert.equal(x.calls.length, 2); const j = x.a.secretary.jobs()['2026-10-07:plan'];
  await x.a.workbench.publish({ kind: 'plan', day: j.day, text: '田哥，今天主推一件事。', items: [] }, { id: j.requestId });
  x.at('2026-10-07T08:00:00+08:00'); await x.a.secretary.tick(); assert.equal(x.notices.filter(n => n.kind === 'daily-plan').length, 1); assert.match(x.notices.find(n => n.kind === 'daily-plan').text, /主推/);
  await x.a.secretary.tick(); assert.equal(x.calls.length, 2); assert.equal(x.notices.filter(n => n.kind === 'daily-plan').length, 1);
});
test('unknown delivery is never retried, including a restarted coordinator', async () => {
  const x = fixture('2026-10-07T07:41:00+08:00'); x.a.send = async r => { x.calls.push(r); throw Error('transport interrupted'); }; await x.a.secretary.tick();
  await x.a.secretary.tick(); const count = x.calls.length; const reboot = new DailySecretary({ assistant: x.a, now: x.now }); await reboot.tick(); assert.equal(x.calls.length, count); assert.equal(Object.values(reboot.jobs()).filter(j => j.state === 'unknown').length, 2);
});
test('deadline emits an honest fallback; a finished brief later sends one marked correction', async () => {
  const x = fixture('2026-10-07T08:00:00+08:00'); x.a.sessionBusy = () => true; await x.a.secretary.tick(); const j = x.a.secretary.jobs()['2026-10-07:plan'];
  assert.match(x.notices.find(n => n.kind === 'daily-plan').text, /尚未生成.*原始备忘/s);
  x.at('2026-10-07T08:10:00+08:00'); await x.a.workbench.publish({ kind: 'plan', day: j.day, text: '终于生成的计划', items: [] }, { id: j.requestId }); await x.a.secretary.tick(); await x.a.secretary.tick();
  const n = x.notices.filter(n => n.kind === 'daily-plan'); assert.equal(n.length, 2); assert.match(n[1].text, /迟到补齐/);
});
test('disabled and non-owning Hub never dispatch; 21:00 summary uses a separate persistent job', async () => {
  const x = fixture('2026-10-07T20:45:00+08:00'); x.a.ownsAssistant = () => false; await x.a.secretary.tick(); assert.equal(x.calls.length, 0);
  x.a.ownsAssistant = () => true; await x.a.secretary.tick(); assert.match(x.calls[0].requestId, /:summary$/);
  x.a.workbench.configure({ enabled: false }); x.at('2026-10-07T21:00:00+08:00'); await x.a.secretary.tick(); assert.equal(x.notices.length, 0);
});
test('scheduled publish is bound to its exact job and duplicate completion does not rewrite a confirmed plan', async () => {
  const x = fixture('2026-10-07T07:41:00+08:00'); await x.a.secretary.tick(); await x.a.secretary.tick(); const j = x.a.secretary.jobs()['2026-10-07:plan']; const b = { kind: 'plan', day: j.day, text: '计划', items: [] };
  await assert.rejects(x.a.workbench.publish(b, { id: 'daily-wrong' }), /其他定时任务/); await x.a.workbench.publish(b, { id: j.requestId }); x.a.workbench.action({ action: 'confirm' }); await x.a.workbench.publish(b, { id: j.requestId }); assert.ok(x.a.workbench.read().plan.confirmedAt);
});
test('lesson rejects short and unsourced scripts and keeps card and questions with actual podcast identity', async () => {
  const x = fixture(), b = { kind: 'lesson', day: '2026-10-07', title: '技术知识点', script: '已查证原理。'.repeat(600), sources: [{ title: '一手文档', url: 'https://example.org/spec' }], oneMinute: '一分钟能讲清楚的核心机制和条件', questions: [{ question: '有什么限制', answer: '适用条件是…' }, { question: '何时有用', answer: '场景是…' }] };
  await assert.rejects(x.a.workbench.publish({ ...b, script: '短稿' }, { id: 'x' }), /3000/); await assert.rejects(x.a.workbench.publish({ ...b, sources: [] }, { id: 'x' }), /来源/); await x.a.workbench.publish(b, { id: 'x' }); assert.match(x.a.workbench.read().lesson.podcastId, /^lesson-20261007-/); assert.equal(x.a.workbench.read().lesson.questions.length, 2);
});
