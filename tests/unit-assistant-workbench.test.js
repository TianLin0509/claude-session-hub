'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { AssistantWorkbench, dayOf, slotAt } = require('../core/hub-assistant/workbench');
const { DailySecretary } = require('../core/hub-assistant/daily-secretary');
function fixture(iso = '2026-10-07T07:39:00+08:00') {
  let time = Date.parse(iso); const kv = new Map(), calls = [], notices = [], scheduled = [];
  const a = { deps: { noReminderTimer: true }, store: { get: k => kv.has(k) ? structuredClone(kv.get(k)) : null, set: (k, v) => kv.set(k, structuredClone(v)) },
    sessions: () => [{ id: 's1', title: '真实中文会话', kind: 'claude', isOpen: true, status: 'idle', hubState: { state: 'idle', label: '就绪' } }, { id: 's2', title: '等你', isOpen: true, hubState: { state: 'wait', label: '等你响应' } }],
    memos: { view: () => ({ open: [{ id: 'm1', title: '记下的事' }], closed: [] }), digest: () => '原始备忘：记下的事' }, memory: { read: () => ({ user: '兴趣' }) },
    ownsTimers: () => true, ownsAssistant: () => false, sessionBusy: () => false, send: async r => { calls.push(r); return { ok: true }; }, watches: { addNotice: n => notices.push(n) },
    podcasts: { startLesson: async r => ({ id: r.id }) } };
  a.workbench = new AssistantWorkbench({ assistant: a, now: () => time });
  a.secretary = new DailySecretary({ assistant: a, now: () => time, timer: fn => { scheduled.push(fn); return 1; }, clear: () => {} });
  return { a, calls, notices, kv, at: iso => { time = Date.parse(iso); }, now: () => time };
}
test('snapshot is explicitly cached; refresh preserves idle and wait without inventing completion', () => {
  const x = fixture(); assert.equal(x.a.workbench.snapshot().sessionSnapshotAt, null);
  const w = x.a.workbench.refresh(); assert.equal(w.sessions.length, 2); const s1 = w.sessions.find(s => s.id === 's1'); assert.equal(s1.state, 'idle'); assert.equal(s1.completed, undefined); assert.equal(w.sessions[0].state, 'wait'); assert.equal(x.calls.length, 0);
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
  const x = fixture('2026-10-07T20:45:00+08:00'); x.a.ownsTimers = () => false; await x.a.secretary.tick(); assert.equal(x.calls.length, 0);
  x.a.ownsTimers = () => true; await x.a.secretary.tick(); assert.match(x.calls[0].requestId, /:summary$/);
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
test('status snapshot puts sessions that need Tian first and carries the latest reply line without a model call', () => {
  const x = fixture(); x.a.sessions = () => [{ id: 'a', title: '就绪', isOpen: true, hubState: { state: 'idle', label: '就绪' } }, { id: 'b', title: '在跑', isOpen: true, hubState: { state: 'run', label: '运行中' } },
    { id: 'c', title: '等你', isOpen: true, hubState: { state: 'wait', label: '等你响应' } }, { id: 'd', title: '新回复', isOpen: true, hubState: { state: 'idle', label: '就绪', hasUnread: true } }];
  x.a.readLiveFinal = id => id === 'c' ? { records: [{ text: '## 需要你定\n邻区负载按 **50%** 还是 70%？' + '很长'.repeat(80), timestamp: 123 }] } : id === 'b' ? (() => { throw Error('记录读不到'); })() : { records: [] };
  const w = x.a.workbench.refresh(); assert.deepEqual(w.sessions.map(s => s.id), ['c', 'b', 'd', 'a']);
  assert.match(w.sessions[0].last, /^需要你定 邻区负载按 50% 还是 70%？/); assert.ok(w.sessions[0].last.length <= 90); assert.equal(w.sessions[0].updatedAt, 123); assert.equal(w.sessions[1].last, ''); assert.equal(x.calls.length, 0);
});
test('08:00 sends one notice: the plan carries today\'s lesson; the lesson only notifies alone when it arrives late', async () => {
  const x = fixture('2026-10-07T06:55:00+08:00'); x.a.podcasts.read = () => ({ status: 'done', episodes: [{ seconds: 732 }] }); await x.a.secretary.tick();
  const lj = x.a.secretary.jobs()['2026-10-07:lesson'];
  await x.a.workbench.publish({ kind: 'lesson', day: '2026-10-07', title: '推测解码', script: '已查证原理。'.repeat(600), sources: [{ title: '论文', url: 'https://arxiv.org/abs/2211.17192' }], oneMinute: '小模型先猜，大模型一次验完。', questions: [{ question: '会变慢吗', answer: '接受率低时会' }, { question: '分布变吗', answer: '不变' }] }, { id: lj.requestId });
  x.at('2026-10-07T07:41:00+08:00'); await x.a.secretary.tick(); const pj = x.a.secretary.jobs()['2026-10-07:plan'];
  await x.a.workbench.publish({ kind: 'plan', day: '2026-10-07', text: '田哥，今天先定参数。', items: [] }, { id: pj.requestId });
  x.at('2026-10-07T08:00:00+08:00'); await x.a.secretary.tick(); await x.a.secretary.tick();
  assert.equal(x.notices.length, 1); assert.equal(x.notices[0].kind, 'daily-plan'); assert.match(x.notices[0].text, /今天先定参数[\s\S]*今日一档：《推测解码》，约 12 分钟/);
  const y = fixture('2026-10-08T08:00:00+08:00'); y.a.sessionBusy = () => true; await y.a.secretary.tick(); assert.equal(y.notices.filter(n => n.kind === 'daily-lesson').length, 0);
  y.a.sessionBusy = () => false; y.at('2026-10-08T08:05:00+08:00'); await y.a.secretary.tick(); const late = y.a.secretary.jobs()['2026-10-08:lesson'];
  await y.a.workbench.publish({ kind: 'lesson', day: '2026-10-08', title: '番茄汁', script: '已查证原理。'.repeat(600), sources: [{ title: '研究', url: 'https://example.org/a' }], oneMinute: '噪音压低甜和咸。', questions: [{ question: '为什么', answer: '鲜味不受影响' }, { question: '航空餐', answer: '偏淡' }] }, { id: late.requestId });
  await y.a.secretary.tick(); const ln = y.notices.filter(n => n.kind === 'daily-lesson'); assert.equal(ln.length, 1); assert.match(ln[0].text, /迟到补齐[\s\S]*《番茄汁》/);
});
test('lesson prompt carries Tian\'s stated preferences and recent titles to avoid repeats', async () => {
  const x = fixture('2026-10-07T06:55:00+08:00'); x.kv.set('workbench.day.2026-10-05', { day: '2026-10-05', lesson: { title: 'KV Cache' } }); await x.a.secretary.tick();
  assert.match(x.calls[0].text, /金句/); assert.match(x.calls[0].text, /不加小测/); assert.match(x.calls[0].text, /KV Cache/);
});
test('daily lesson completion does not raise its own podcast notice', () => {
  const { AssistantService } = require('../core/hub-assistant/service'); const added = [];
  const self = { watches: { addNotice: n => added.push(n) } };
  AssistantService.prototype.podcastDone.call(self, { id: 'lesson-1', title: '课', source: 'daily-secretary', episodes: [{ status: 'done', seconds: 700 }] });
  AssistantService.prototype.podcastDone.call(self, { id: 'doc-1', title: '资料', episodes: [{ status: 'done', seconds: 700 }] });
  assert.equal(added.length, 1); assert.equal(added[0].id, 'podcast:doc-1');
});
test('timers belong to the latest started Hub and do not need an open assistant session (10-09 morning regression)', async () => {
  const { claimTimers, ownsTimers } = require('../core/hub-assistant/timer-owner');
  const kv = new Map(), store = { get: k => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) };
  assert.equal(ownsTimers(store, 1), true); claimTimers(store, 1); assert.equal(ownsTimers(store, 1), true);
  claimTimers(store, 2); assert.equal(ownsTimers(store, 1), false); assert.equal(ownsTimers(store, 2), true);
  // Hub 刚重启、助理会话还没开：秘书照样在 7:40 前后派出日稿任务
  const x = fixture('2026-10-09T07:41:00+08:00'); x.a.ownsAssistant = () => false; x.a.ownsTimers = () => true;
  await x.a.secretary.tick(); assert.ok(x.calls.some(c => /:plan$/.test(c.requestId)));
});
