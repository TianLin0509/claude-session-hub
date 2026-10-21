'use strict';
// 会议身份与循环实例回归；数据合成，不代表已验证公司的会议类型/接口范围。
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const { collectMeetings } = require('../core/company-assistant/queries');
const { AssistantQuery } = require('../core/company-assistant/query-tool');
const NOW = Date.parse('2026-10-21T12:00:00+08:00');
const DAY = '2026-10-21';
const event = (id, patch = {}) => ({ id, subject: '周例会', location: 'A室',
  start: '2026-10-21T17:00:00+08:00', end: '2026-10-21T18:00:00+08:00', ...patch });
const snapshot = (meetings, calendar) => ({ login: { ok: true, uid: 'self' },
  meetings: D.meetings(meetings), calendar: D.calendarEvents(calendar),
  meetingCoverage: { status: 'complete' }, calendarCoverage: { status: 'complete' }, errors: [] });
async function query(snap) {
  const q = new AssistantQuery({ dir: process.cwd(), now: () => NOW,
    auth: { status: () => ({ login: { uid: 'self' } }) }, collectQuery: async () => snap });
  q.save = () => {};
  return q.execute({ kind: 'meetings', period: 'today' });
}

for (const [label, meetings, calendar] of [
  ['WeLink 不同编号，即使仅组织者不同', [event('a', { organizer: '甲' }), event('b', { organizer: '乙' })], []],
  ['Exchange 不同编号和地点', [], [event('a'), event('b', { location: 'B室' })]],
  ['跨源同标题和时段但不同地点', [event('a')], [event('b', { location: 'B室' })]],
  ['跨源同开始但不同结束', [event('a')], [event('b', { end: '2026-10-21T19:00:00+08:00' })]],
  ['跨源表面完全相同也没有共享身份依据', [event('a')], [event('a')]],
]) test(label + '：查询与简报均保留两条，出处各自可读', async () => {
  const snap = snapshot(meetings, calendar), got = await query(snap);
  assert.equal(got.items.length, 2);
  assert.equal(D.todaysMeetings(snap, DAY).length, 2);
  const index = D.sourceIndex(snap);
  assert.equal(index.size, 2);
  for (const row of got.items) assert.deepEqual(index.get(row.sourceId).item, row);
  const brief = B.fallbackBrief(snap, { day: DAY, now: NOW });
  assert.equal(brief.sections[0].items.length, 2);
});

test('分页只消除同一原始记录的重复，循环会议同编号不同时间及同编号冲突均保留', async () => {
  const a = event('series'), b = event('series', { start: '2026-10-21T19:00:00+08:00', end: '2026-10-21T20:00:00+08:00' });
  const c = event('series', { organizer: '另一个组织者' });
  const pages = [[a, b], [Object.fromEntries(Object.entries(a).reverse()), c], []];
  let calls = 0;
  const got = await collectMeetings(async () => ({ data: { data: pages[calls++] } }), NOW, { size: 2 });
  assert.equal(calls, 3);
  assert.equal(got.meetings.length, 3);
  // 同一发生时间的 a/c 组织者不同：记录均保留，但版本冲突不能声称完整确定。
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.reason, 'version-conflict');
  assert.equal(new Set(got.meetings.map(m => m.sourceId)).size, 3);
  const snap = { ...snapshot([], []), meetings: got.meetings }, result = await query(snap), index = D.sourceIndex(snap);
  assert.equal(result.items.length, 3);
  for (const row of result.items) assert.deepEqual(index.get(row.sourceId).item, row);
  assert.equal(B.fallbackBrief(snap, { day: DAY, now: NOW }).sections[0].items.length, 3);
  const repeat = await collectMeetings(async () => ({ data: { data: [a, b, c] } }), NOW);
  assert.deepEqual(repeat.meetings.map(m => m.sourceId).sort(), got.meetings.map(m => m.sourceId).sort());
});

test('Exchange 循环实例同编号不同时间，和缺编号的同名日程，各自保留出处', async () => {
  const snap = snapshot([], [event('series'), event('series', { end: '2026-10-21T19:00:00+08:00' }), event(undefined), event(undefined)]);
  const got = await query(snap), index = D.sourceIndex(snap);
  assert.equal(got.items.length, 4);
  assert.equal(index.size, 4);
  for (const row of got.items) assert.deepEqual(index.get(row.sourceId).item, row);
});

test('会议接口重复整页明确终止且标为未全，不因换成记录身份而无限翻页', async () => {
  let calls = 0;
  const got = await collectMeetings(async () => { calls += 1; return { data: { data: [event('a'), event('b')] } }; }, NOW, { size: 2 });
  assert.equal(calls, 2);
  assert.equal(got.meetings.length, 2);
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.reason, 'repeated-page');
});

test('无编号日程重排后出处仍指向原记录，未知身份的同文记录不合并', () => {
  const a = event(undefined), b = event(undefined, { subject: '另一条记录' });
  const before = D.calendarEvents([a, b, a]), after = D.calendarEvents([b, a, a]);
  assert.equal(new Set(before.map(x => x.sourceId)).size, 3);
  assert.deepEqual(before.map(x => [x.sourceId, x.subject]).sort(), after.map(x => [x.sourceId, x.subject]).sort());
});

test('同一瞬间换用 UTC 表示不重复提醒，原始时间版本仍分别可追溯', () => {
  const a = D.meetings([event('a')])[0], b = D.meetings([event('a', { start: '2026-10-21T09:00:00Z' })])[0];
  assert.notEqual(a.sourceId, b.sourceId);
  assert.equal(a.occurrenceId, b.occurrenceId);
});

test('跨源重叠只提示核对，不把两条记录断定为两个冲突会议', () => {
  const R = require('../core/company-assistant/reminders');
  const snap = snapshot([event('a')], [event('a')]);
  const notice = R.dueNotices({ snapshot: snap, settings: {}, now: NOW }).find(n => n.kind === 'overbooked');
  assert.ok(notice);
  assert.match(notice.text, /不同来源可能记录了同一场会/);
  assert.doesNotMatch(notice.text, /推掉|代参加/);
});

test('参会人和状态更新改变记录出处，但同一实例的会前提醒只发布一次', () => {
  const R = require('../core/company-assistant/reminders');
  const { NoticeBus } = require('../core/company-assistant/notice-bus');
  const now = Date.parse('2026-10-21T16:50:00+08:00');
  for (const source of ['meetings', 'calendar']) {
    const original = event('series', { meetingUsers: [{ id: 'alice' }], status: 'scheduled' });
    const updated = { ...original, meetingUsers: [{ id: 'alice' }, { id: 'bob' }], status: 'confirmed' };
    const make = raw => source === 'meetings' ? snapshot([raw], []) : snapshot([], [raw]);
    const before = make(original), after = make(updated);
    assert.notEqual(before[source][0].sourceId, after[source][0].sourceId);
    assert.ok(before[source][0].occurrenceId);
    assert.equal(before[source][0].occurrenceId, after[source][0].occurrenceId);
    const prep = snap => R.dueNotices({ snapshot: snap, settings: {}, now }).filter(n => n.kind === 'meeting-prep');
    const a = prep(before), b = prep(after);
    assert.equal(a.length, 1); assert.equal(b.length, 1);
    assert.equal(a[0].id, b[0].id);
    assert.notEqual(a[0].detail.source, b[0].detail.source, '查看出处仍指向各自记录版本');
    const bus = new NoticeBus({ now: () => now });
    assert.equal(bus.publish(a[0]), true);
    assert.equal(bus.publish(b[0]), false);
    assert.equal(bus.latest().length, 1);
  }
});

test('循环会议编号相同但开始时间不同，两次实例的会前提醒均可发布', () => {
  const R = require('../core/company-assistant/reminders');
  const { NoticeBus } = require('../core/company-assistant/notice-bus');
  const now = Date.parse('2026-10-21T16:50:00+08:00');
  const events = [event('series'), event('series', { start: '2026-10-21T17:04:00+08:00', end: '2026-10-21T18:04:00+08:00' })];
  for (const snap of [snapshot(events, []), snapshot([], events)]) {
    const rows = [...snap.meetings, ...snap.calendar];
    assert.ok(rows.every(row => row.occurrenceId));
    assert.notEqual(rows[0].occurrenceId, rows[1].occurrenceId);
    const prep = R.dueNotices({ snapshot: snap, settings: {}, now }).filter(n => n.kind === 'meeting-prep');
    assert.equal(prep.length, 2);
    assert.notEqual(prep[0].id, prep[1].id);
    const bus = new NoticeBus({ now: () => now });
    assert.equal(bus.publish(prep[0]), true);
    assert.equal(bus.publish(prep[1]), true);
    assert.equal(bus.latest().length, 2);
  }
});

test('旧快照没有实例编号时，会前提醒继续使用原出处编号', () => {
  const R = require('../core/company-assistant/reminders');
  const now = Date.parse('2026-10-21T16:50:00+08:00');
  const snap = { meetings: [{ sourceId: 'meeting:legacy', subject: '旧会议', start: now + 600000, end: now + 4200000 }], calendar: [] };
  const prep = R.dueNotices({ snapshot: snap, settings: {}, now }).filter(n => n.kind === 'meeting-prep');
  assert.equal(prep.length, 1);
  assert.equal(prep[0].id, 'prep:meeting:legacy:2026-10-21');
  assert.equal(prep[0].detail.source, 'meeting:legacy');
});

test('分页重叠和同实例版本更新不能提前满足总数，继续取得第三页并提示版本待核对', async () => {
  const oldA = event('A', { meetingUsers: [{ id: 'alice' }] });
  const newA = event('A', { meetingUsers: [{ id: 'alice' }, { id: 'bob' }] });
  const b = event('B'), c = event('C'), pages = [[oldA, b], [newA, b], [c]];
  let calls = 0;
  const got = await collectMeetings(async () => ({ data: { data: pages[calls++], total: 3 } }), NOW, { size: 2 });
  assert.equal(calls, 3);
  assert.equal(got.meetings.length, 4, 'A 两个版本与 B/C 均保留');
  assert.deepEqual(got.meetings.map(m => m.id).sort(), ['A', 'A', 'B', 'C']);
  assert.equal(got.coverage.instances, 3);
  assert.equal(got.coverage.versionConflicts, 1);
  assert.equal(got.coverage.total, 3);
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.reason, 'version-conflict');
  assert.match(got.coverage.reasonLabel, /不同记录版本.*待核对/);
});

test('总数已到但末页满页时仍读取空页确认边界，正常实例数一致才标完整', async () => {
  const pages = [[event('A'), event('B')], []];
  let calls = 0;
  const got = await collectMeetings(async () => ({ data: { data: pages[calls++], total: 2 } }), NOW, { size: 2 });
  assert.equal(calls, 2);
  assert.equal(got.meetings.length, 2);
  assert.equal(got.coverage.instances, 2);
  assert.equal(got.coverage.versionConflicts, 0);
  assert.equal(got.coverage.status, 'complete');
  assert.equal(got.coverage.reason, 'exhausted');
});

test('分页重叠继续取得后续实例，完全相同记录只保留一次', async () => {
  const a = event('A'), b = event('B'), c = event('C'), pages = [[a, b], [b, c], []];
  let calls = 0;
  const got = await collectMeetings(async () => ({ data: { data: pages[calls++], total: 3 } }), NOW, { size: 2 });
  assert.equal(calls, 3);
  assert.deepEqual(got.meetings.map(m => m.id).sort(), ['A', 'B', 'C']);
  assert.equal(got.coverage.status, 'complete');
  assert.equal(got.coverage.instances, 3);
});

test('分页上限不变，满页即使已达到接口总数也不伪称确认边界', async () => {
  let calls = 0;
  const got = await collectMeetings(async () => { calls += 1; return { data: { data: [event('A'), event('B')], total: 2 } }; }, NOW, { size: 2, maxPages: 1 });
  assert.equal(calls, 1);
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.reason, 'page-limit');
});
