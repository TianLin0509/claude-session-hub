'use strict';
// Q-1021-09 第3轮证明已结束会议需要 type=2 补充；以下记录、日期与跨类重叠均为合成边界。
// 固定合并待参加(1)与已结束(2)，不推断 type4 的通用范围、roles 数字或 UID 归属。
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectMeetingAgenda, collectMeetings, meetingArgs } = require('../core/company-assistant/queries');
const NOW = Date.parse('2026-10-21T12:00:00+08:00');
const RANGE = { start: Date.parse('2026-10-21T00:00:00+08:00'), end: Date.parse('2026-10-22T00:00:00+08:00') };
const arg = (args, key) => args[args.indexOf(key) + 1];
const event = (id, patch = {}) => ({ meetingId: id, subject: '合成会议 ' + id, location: 'A室',
  meetingStartTime: '2026-10-21T17:00:00+08:00', meetingEndTime: '2026-10-21T18:00:00+08:00', ...patch });
const ended = (id, patch = {}) => event(id, { meetingStartTime: '2026-10-21T09:00:00+08:00', meetingEndTime: '2026-10-21T10:00:00+08:00', ...patch });
function fixture(groups, failedTypes = []) {
  const calls = [];
  return { calls, run: async (_label, args) => {
    const type = arg(args, '--type'), page = Number(arg(args, '--page')), size = Number(arg(args, '--size'));
    assert.ok(['1', '2'].includes(type), '会议日程不得扩大到 type 0/3/4/5 或其他范围');
    calls.push({ type, page, size, args });
    if (failedTypes.includes(type)) return null;
    const all = groups[type] || [], data = all.slice((page - 1) * size, page * size);
    return { code: 200, data: { page, size, total: data.length ? all.length : 0, ...(data.length ? { data } : {}) }, description: 'success', timestamp: NOW };
  } };
}

test('当天尚未开始与已经结束的会议都保留，逐行及总覆盖注明查询类别', async () => {
  const f = fixture({ '1': [event('future')], '2': [ended('past')] });
  const got = await collectMeetingAgenda(f.run, NOW, { range: RANGE });
  assert.deepEqual(got.meetings.map(x => x.id).sort(), ['future', 'past']);
  assert.deepEqual(got.meetings.find(x => x.id === 'future').queryTypes, ['1']);
  assert.deepEqual(got.meetings.find(x => x.id === 'past').queryTypes, ['2']);
  assert.deepEqual(got.coverage.queryTypes, ['1', '2']);
  assert.equal(got.coverage.queryType, '1,2');
  assert.equal(got.coverage.status, 'complete');
  assert.equal(got.coverage.byType['1'].status, 'complete');
  assert.equal(got.coverage.byType['1'].queryType, '1');
  assert.equal(got.coverage.byType['2'].status, 'complete');
  assert.equal(got.coverage.byType['2'].queryType, '2');
  assert.deepEqual(f.calls.map(x => x.type).sort(), ['1', '2']);
  assert.ok(f.calls.every(x => arg(x.args, '--meeting-start-time') === String(RANGE.start)
    && arg(x.args, '--meeting-end-time') === String(RANGE.end - 1)));
});

test('两类各自以最大30条翻页，不能共用游标或一类结束就停止另一类', async () => {
  const groups = { '1': Array.from({ length: 31 }, (_, i) => event('future-' + i)),
    '2': Array.from({ length: 32 }, (_, i) => ended('past-' + i)) };
  const f = fixture(groups);
  const got = await collectMeetingAgenda(f.run, NOW, { size: 100, range: RANGE });
  assert.equal(got.meetings.length, 63);
  assert.equal(new Set(got.meetings.map(x => x.sourceId)).size, 63);
  assert.equal(got.coverage.status, 'complete');
  for (const type of ['1', '2']) {
    assert.deepEqual(f.calls.filter(x => x.type === type).map(x => x.page), [1, 2]);
    assert.equal(got.coverage.byType[type].pages, 2);
    assert.equal(got.coverage.byType[type].total, groups[type].length);
    assert.equal(got.meetings.filter(x => x.queryTypes.includes(type)).length, groups[type].length);
  }
  assert.ok(f.calls.every(x => x.size === 30));
});

test('已结束类别查询失败时保留待参加记录，总覆盖只能是 partial', async () => {
  const f = fixture({ '1': [event('future')] }, ['2']);
  const got = await collectMeetingAgenda(f.run, NOW);
  assert.deepEqual(got.meetings.map(x => x.id), ['future']);
  assert.deepEqual(got.meetings[0].queryTypes, ['1']);
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.byType['1'].status, 'complete');
  assert.equal(got.coverage.byType['2'].status, 'failed');
  assert.equal(got.coverage.byType['2'].reason, 'query-failed');
});

test('两类都查询失败时总覆盖 failed，不能伪装成没有会议', async () => {
  const f = fixture({}, ['1', '2']);
  const got = await collectMeetingAgenda(f.run, NOW);
  assert.deepEqual(got.meetings, []);
  assert.equal(got.coverage.status, 'failed');
  assert.equal(got.coverage.byType['1'].status, 'failed');
  assert.equal(got.coverage.byType['2'].status, 'failed');
});

test('两类返回完全相同记录时只保留一条，queryTypes 同时保留两个出处类别', async () => {
  const shared = event('overlap');
  const f = fixture({ '1': [shared], '2': [{ ...shared }] });
  const got = await collectMeetingAgenda(f.run, NOW);
  assert.equal(got.meetings.length, 1);
  assert.equal(got.meetings[0].id, 'overlap');
  assert.deepEqual(got.meetings[0].queryTypes, ['1', '2']);
  assert.equal(got.coverage.status, 'complete');
  assert.equal(got.coverage.byType['1'].instances, 1);
  assert.equal(got.coverage.byType['2'].instances, 1);
});

test('同一会议实例跨类别返回不同记录版本时两条都保留，总覆盖 partial', async () => {
  const original = event('changed', { meetingUsers: [{ id: 'alice' }] });
  const updated = event('changed', { meetingUsers: [{ id: 'alice' }, { id: 'bob' }] });
  const f = fixture({ '1': [original], '2': [updated] });
  const got = await collectMeetingAgenda(f.run, NOW);
  assert.equal(got.meetings.length, 2);
  assert.equal(new Set(got.meetings.map(x => x.sourceId)).size, 2);
  assert.equal(new Set(got.meetings.map(x => x.occurrenceId)).size, 1);
  assert.deepEqual(got.meetings.map(x => x.queryTypes).sort(), [['1'], ['2']]);
  assert.equal(got.coverage.byType['1'].status, 'complete');
  assert.equal(got.coverage.byType['2'].status, 'complete');
  assert.equal(got.coverage.status, 'partial', '跨类别版本冲突不能被两个类别各自完整掩盖');
  assert.equal(got.coverage.versionConflicts, 1);
});

test('同编号但开始时间不同的循环实例跨类别都保留，不能按 meetingId 合并', async () => {
  const f = fixture({ '1': [event('loop')], '2': [ended('loop')] });
  const got = await collectMeetingAgenda(f.run, NOW);
  assert.equal(got.meetings.length, 2);
  assert.equal(new Set(got.meetings.map(x => x.occurrenceId)).size, 2);
  assert.equal(new Set(got.meetings.map(x => x.sourceId)).size, 2);
  assert.deepEqual(got.meetings.map(x => x.queryTypes).sort(), [['1'], ['2']]);
  assert.equal(got.coverage.status, 'complete');
});

test('两类都返回已核实的无数组空页时，总覆盖 complete 且没有会议', async () => {
  const f = fixture({});
  const got = await collectMeetingAgenda(f.run, NOW);
  assert.deepEqual(got.meetings, []);
  assert.equal(got.coverage.status, 'complete');
  assert.deepEqual(got.coverage.queryTypes, ['1', '2']);
  assert.equal(got.coverage.byType['1'].status, 'complete');
  assert.equal(got.coverage.byType['1'].total, 0);
  assert.equal(got.coverage.byType['2'].status, 'complete');
  assert.equal(got.coverage.byType['2'].total, 0);
  assert.deepEqual(f.calls.map(x => [x.type, x.page, x.size]).sort(), [['1', 1, 30], ['2', 1, 30]]);
});

test('任何一类达到分页上限，即使另一类完整且为空，总覆盖仍为 partial', async () => {
  const f = fixture({ '1': Array.from({ length: 31 }, (_, i) => event('limited-' + i)), '2': [] });
  const got = await collectMeetingAgenda(f.run, NOW, { maxPages: 1 });
  assert.equal(got.meetings.length, 30);
  assert.equal(got.coverage.byType['1'].status, 'partial');
  assert.equal(got.coverage.byType['1'].reason, 'page-limit');
  assert.equal(got.coverage.byType['2'].status, 'complete');
  assert.equal(got.coverage.status, 'partial');
});

test('旧 meetingArgs 与 collectMeetings 调用默认仍为 type1', async () => {
  assert.equal(arg(meetingArgs(NOW), '--type'), '1');
  const f = fixture({ '1': [event('default')] });
  const got = await collectMeetings(f.run, NOW);
  assert.equal(got.coverage.queryType, '1');
  assert.equal(got.coverage.status, 'complete');
  assert.deepEqual(f.calls.map(x => x.type), ['1']);
});

test('meetingArgs 第五参及 collectMeetings 的 type 参数可以单独指定已结束类别', async () => {
  for (const type of ['2', 2]) {
    assert.equal(arg(meetingArgs(NOW, 1, 30, RANGE, type), '--type'), '2');
    const f = fixture({ '2': [ended('ended-only')] });
    const got = await collectMeetings(f.run, NOW, { type, range: RANGE });
    assert.deepEqual(got.meetings.map(x => x.id), ['ended-only']);
    assert.equal(got.coverage.queryType, '2');
    assert.equal(got.coverage.status, 'complete');
    assert.deepEqual(f.calls.map(x => x.type), ['2']);
  }
});

test('type 参数拒绝 1/2 之外的值，并在拒绝前不执行任何查询', async () => {
  for (const type of ['0', '3', '4', '5', '1,2', '', null, false, {}, 1.5]) {
    assert.throws(() => meetingArgs(NOW, 1, 30, RANGE, type), undefined, '非法 type=' + String(type));
    let called = false;
    await assert.rejects(collectMeetings(async () => { called = true; return null; }, NOW, { type }), undefined, '非法 type=' + String(type));
    assert.equal(called, false);
  }
});
