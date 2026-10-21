'use strict';
// 合成边界回归，不代表已确认任何新版本 WeLink 的真实字段契约。
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const R = require('../core/company-assistant/reminders');
const P = require('../core/company-assistant/memory-priority');
const NOW = Date.parse('2026-10-21T10:00:00+08:00');
const day = '2026-10-21';
const privateConv = { id: 'p', name: '私聊示例', group: false };
const group = { id: 'g', name: '群示例', group: true };
const rawMessage = (id, extra = {}) => ({ msgId: String(id), sender: 'other', serverSendTime: NOW - 60000, content: '请核对材料', ...extra });
const empty = () => ({ meetings: [], calendar: [], conversations: [], messages: {}, mails: [], errors: [] });

test('显式 UTC、offset、IANA、Windows 中国时区产生同一瞬间，上海显示不随机器时区漂移', () => {
  const expected = Date.parse('2026-10-21T09:00:00Z');
  for (const value of [
    { dateTime: '2026-10-21T09:00:00', timeZone: 'UTC' },
    { DateTime: '2026-10-21T17:00:00', TimeZone: 'China Standard Time' },
    { dateTime: '2026-10-21T17:00:00', timeZone: 'Asia/Shanghai' },
    '2026-10-21T17:00:00+08:00', expected, expected / 1000,
  ]) assert.equal(D.toMs(value), expected);
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(D.clock(expected), '17:00');
    assert.equal(D.dayKey(expected), day);
    assert.match(D.displayTime(expected), /2026-10-21 17:00:00.*上海/);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('无时区、未知时区、DST 重复/不存在的时间均保留待核对，不猜当地时间', () => {
  for (const value of [
    '2026-10-21T09:00:00',
    { dateTime: '2026-10-21T09:00:00', timeZone: 'CST' },
    { dateTime: '2026-11-01T01:30:00', timeZone: 'America/New_York' },
    { dateTime: '2026-03-08T02:30:00', timeZone: 'America/New_York' },
    '2026-02-30T09:00:00Z',
  ]) {
    const evidence = D.timeValue(value);
    assert.equal(evidence.at, null);
    assert.notEqual(evidence.status, 'known');
    assert.deepEqual(evidence.raw, value);
  }
  assert.equal(D.toMs({ dateTime: '2026-10-21T09:00:00', timeZone: 'America/New_York' }), Date.parse('2026-10-21T13:00:00Z'));
});

test('未知时区会议保留出处和原值，但不假装归属今天', () => {
  const snapshot = empty();
  snapshot.calendar = D.calendarEvents({ events: [
    { id: 'known', subject: '已知时区', start: { dateTime: '2026-10-21T09:00:00', timeZone: 'UTC' } },
    { id: 'unknown', subject: '待核对', start: { dateTime: '2026-10-21T09:00:00' } },
  ] });
  assert.equal(snapshot.calendar.length, 2);
  assert.equal(snapshot.calendar[1].timeStatus, 'unknown');
  assert.equal(snapshot.calendar[1].timeEvidence.start.raw.dateTime, '2026-10-21T09:00:00');
  assert.match(snapshot.calendar[0].startDisplay, /17:00:00/);
  assert.deepEqual(D.todaysMeetings(snapshot, day).map(x => x.id), ['known']);
  assert.deepEqual(D.unresolvedMeetings(snapshot).map(x => x.id), ['unknown']);
  assert.match(B.fallbackBrief(snapshot, { day, now: NOW }).sections[0].items.find(x => x.source === snapshot.calendar[1].sourceId).text, /待核对/);
});

test('atself 使用显式布尔解析，字符串 false 不变成真，@本人优先于空名单推断的@所有人', () => {
  const values = [true, 'true', 1, '1', false, 'false', 0, '0'];
  const rows = D.messages({ chatInfo: values.map((value, i) => rawMessage(i, { atself: value, at: false })) }, group, 'self');
  assert.deepEqual(rows.map(x => x.atMe), [true, true, true, true, false, false, false, false]);
  const [self, all, mine] = D.messages({ chatInfo: [
    rawMessage('self', { atself: true, at: true, atAccountList: [] }),
    rawMessage('all', { at: true, atAccountList: [] }),
    rawMessage('mine', { sender: 'self', atself: true }),
  ] }, group, 'self');
  assert.equal(self.atMe, true); assert.equal(self.atAll, false);
  assert.equal(all.atAll, true); assert.equal(mine.atMe, false);
});

test('私聊 group_id=0 不是群；缺少实际对方编号不制造会话 0', () => {
  const rows = D.conversations({ conversation_info: [
    { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', group_id: '0', target_account: 'p' },
    { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', group_id: '0' },
    { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: 'g' },
  ] });
  assert.deepEqual(rows.map(x => [x.id, x.group]), [['p', false], ['g', true]]);
});

test('群里的无关本人发言不能清掉两条待核对@；私聊保留原最后回复规则', () => {
  const snapshot = empty(); snapshot.conversations = [group, privateConv];
  snapshot.messages.g = D.messages({ chatInfo: [rawMessage('a', { atself: true }), rawMessage('b', { atself: true }), rawMessage('c', { sender: 'self', serverSendTime: NOW })] }, group, 'self');
  snapshot.messages.p = D.messages({ chatInfo: [rawMessage('p')] }, privateConv, 'self');
  const pending = D.awaiting(snapshot);
  assert.deepEqual(pending.filter(x => x.group).map(x => x.key), ['a', 'b']);
  assert.ok(pending.filter(x => x.group).every(x => x.needsReplyReview));
  assert.ok(pending.some(x => x.conv === 'p'));
});

test('简报小上下文预览如实统计遗漏私聊，全文完整保留并提供分页工具', () => {
  const snapshot = empty(); snapshot.conversations = [privateConv];
  snapshot.messages.p = D.messages({ chatInfo: Array.from({ length: 160 }, (_, i) => rawMessage(i, { content: '原文'.repeat(150), serverSendTime: NOW - i * 1000 })) }, privateConv, 'self');
  const picked = B.inlineMessages(snapshot, { now: NOW, settings: { day, lookbackHours: 24 } });
  const prompt = B.briefPrompt(snapshot, { day, now: NOW, settings: { lookbackHours: 24 } });
  assert.ok(picked.omitted > 0);
  assert.equal(picked.omittedPrivate, picked.omitted);
  assert.equal(picked.omittedGroups, 0);
  assert.ok(prompt.length < 10000);
  assert.match(prompt, /welink_inbox/);
  assert.match(prompt, /welink_message/);
  assert.match(prompt, /welink_meetings/);
  assert.match(prompt, /私聊/);
  assert.doesNotMatch(prompt, /条群消息没有列出/);
  assert.ok(B.briefInputFile(snapshot, { day, now: NOW }).includes('原文'.repeat(150)));
});

test('会议事实由原始结构确定，AI 错时和错标题不覆盖，遗漏会议全部补回且首屏仅10条', () => {
  const snapshot = empty();
  snapshot.meetings = D.meetings({ meetings: Array.from({ length: 12 }, (_, i) => ({ meetingId: 'm' + i, subject: '原主题' + i, meetingStartTime: NOW + i * 60000 })) });
  const brief = B.parseAgentBrief(JSON.stringify({ meetings: [{ source: snapshot.meetings[0].sourceId, text: '01:00 假主题', preparation: '读材料并列出问题' }] }), snapshot, { day, now: NOW });
  const items = brief.sections.find(x => x.key === 'meetings').items;
  assert.equal(items.length, 12);
  assert.match(items[0].text, /10:00.*原主题0/);
  assert.doesNotMatch(items[0].text, /01:00|假主题/);
  assert.equal(items[0].preparation, '读材料并列出问题');
  assert.equal(items.filter(x => x.top).length, 10);
});

test('合法的消息出处也不能伪装成会议；AI空清单不会删除待回与@本人，已处理项不复活', () => {
  const snapshot = empty(); snapshot.conversations = [group, privateConv];
  snapshot.messages.g = D.messages({ chatInfo: [rawMessage('a', { atself: true }), rawMessage('b', { atself: true })] }, group, 'self');
  snapshot.messages.p = D.messages({ chatInfo: [rawMessage('p')] }, privateConv, 'self');
  const brief = B.parseAgentBrief(JSON.stringify({ meetings: [{ source: 'msg:p:p', text: '伪造会议' }] }), snapshot, { day, now: NOW, done: new Set(['msg:g:a']) });
  assert.equal(brief.dropped, 1);
  assert.equal(brief.sections.some(x => x.key === 'meetings'), false);
  const all = brief.sections.flatMap(x => x.items);
  assert.ok(all.some(x => x.source === 'msg:p:p'));
  assert.ok(all.some(x => x.source === 'msg:g:b'));
  assert.ok(!all.some(x => x.source === 'msg:g:a'));
});

test('未知时间不触发会前/逾期待回提醒，确定时刻按上海工作日判断', () => {
  const snapshot = empty(); snapshot.conversations = [privateConv];
  snapshot.calendar = D.calendarEvents({ events: [{ id: 'bad', subject: '未知', start: '2026-10-21T10:05:00' }] });
  snapshot.messages.p = [{ ...rawMessage('p'), sourceId: 'msg:p:p', conv: 'p', text: '待回复', mine: false, at: null }];
  assert.ok(!R.dueNotices({ snapshot, settings: {}, now: NOW }).some(x => ['meeting-prep', 'awaiting-reply'].includes(x.kind)));
  const old = process.env.TZ;
  try { process.env.TZ = 'America/Los_Angeles'; assert.equal(R.isWorkday(Date.parse('2026-10-19T08:00:00+08:00'), {}), true); }
  finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('@所有人逐条保留在群要点，不假称都在等回复；已处理消息不会再触发逾期提醒', () => {
  const snapshot = empty(); snapshot.conversations = [group, privateConv];
  snapshot.messages.g = D.messages({ chatInfo: [rawMessage('a', { at: true }), rawMessage('b', { at: true })] }, group, 'self');
  snapshot.messages.p = D.messages({ chatInfo: [rawMessage('p', { serverSendTime: NOW - 5 * 3600000 })] }, privateConv, 'self');
  const brief = B.parseAgentBrief('{}', snapshot, { day, now: NOW });
  assert.deepEqual(brief.sections.find(s => s.key === 'groups').items.map(x => x.source), ['msg:g:a', 'msg:g:b']);
  assert.equal(brief.sections.find(s => s.key === 'awaiting').items.length, 1);
  assert.ok(!R.dueNotices({ snapshot, settings: {}, now: NOW, done: new Set(['msg:p:p']) }).some(x => x.kind === 'awaiting-reply'));
});

test('全天纯日期不借宿主时区制造瞬间；明确结束边界才扩展跨日，星期由代码生成', () => {
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const snapshot = empty();
    snapshot.calendar = D.calendarEvents({ events: [
      { id: 'date', subject: '全天事项', start: { date: day } },
      { id: 'flag', subject: '明确全天', isAllDay: true, start: { dateTime: day + 'T00:00:00' } },
      { id: 'range', subject: '两天', allDay: true, start: '2026-10-21', end: '2026-10-23', endExclusive: true },
    ] });
    for (const item of snapshot.calendar) {
      assert.equal(item.allDay, true); assert.equal(item.timeStatus, 'date-only'); assert.equal(item.start, null);
      assert.equal(D.eventTimeUnknown(item), false);
    }
    assert.match(snapshot.calendar[0].displayRange, /2026-10-21 全天.*周三/);
    assert.match(snapshot.calendar[2].displayRange, /2026-10-21 至 2026-10-22 全天/);
    assert.equal(D.unresolvedMeetings(snapshot).length, 0);
    assert.equal(D.todaysMeetings(snapshot, day).length, 3);
    assert.deepEqual(D.todaysMeetings(snapshot, '2026-10-22').map(x => x.id), ['range']);
    assert.equal(D.todaysMeetings(snapshot, '2026-10-23').length, 0);
    assert.equal(D.eventInRange(snapshot.calendar[0], { start: NOW + 86400000, end: NOW + 2 * 86400000 }), false);
    assert.match(B.fallbackBrief(snapshot, { day, now: NOW }).sections[0].items[0].text, /全天/);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('带明确时区的全天日程按上海投影；跨日显示保留两端日期和星期', () => {
  const snapshot = empty();
  snapshot.calendar = D.calendarEvents({ events: [
    { id: 'utc', subject: 'UTC 全天', allDay: true, start: { date: day, timeZone: 'UTC' }, end: { date: '2026-10-22', timeZone: 'UTC' } },
    { id: 'shanghai', subject: '本地全天', allDay: true, start: { date: day, timeZone: 'Asia/Shanghai' }, end: { date: '2026-10-22', timeZone: 'Asia/Shanghai' } },
    { id: 'overnight', subject: '跨午夜', start: day + 'T23:30:00+08:00', end: '2026-10-22T00:30:00+08:00' },
  ] });
  assert.equal(snapshot.calendar[0].start, Date.parse(day + 'T00:00:00Z'));
  assert.equal(snapshot.calendar[0].timeEvidence.start.raw.date, day);
  assert.match(snapshot.calendar[0].displayRange, /2026-10-21 全天.*上海显示范围.*2026-10-21（周三）08:00.*2026-10-22（周四）08:00/);
  assert.match(snapshot.calendar[1].displayRange, /2026-10-21 全天（周三，上海/);
  assert.match(snapshot.calendar[2].displayRange, /2026-10-21（周三）23:30.*2026-10-22（周四）00:30/);
  assert.deepEqual(D.todaysMeetings(snapshot, '2026-10-22').map(x => x.id), ['utc', 'overnight']);
  assert.match(D.displayTime(NOW), /周三/);
});

test('结束早于开始标待核对且不触发会前提醒；未确认的纯日期结束边界不宣称查全', () => {
  const snapshot = empty();
  snapshot.calendar = D.calendarEvents({ events: [
    { id: 'reverse', subject: '倒置', start: '2026-10-21T10:05:00+08:00', end: '2026-10-21T09:00:00+08:00' },
    { id: 'date-reverse', subject: '倒置日期', start: '2026-10-21', end: '2026-10-20' },
    { id: 'date-boundary', subject: '未确认边界', start: '2026-10-21', end: '2026-10-22' },
  ] });
  for (const item of snapshot.calendar.slice(0, 2)) {
    assert.equal(item.timeStatus, 'unknown'); assert.equal(item.timeEvidence.end.reason, 'end-before-start');
    assert.match(item.displayRange, /待核对/);
  }
  assert.equal(D.eventTimeUnknown(snapshot.calendar[2]), true);
  assert.match(snapshot.calendar[2].displayRange, /是否含当日待核对/);
  assert.ok(!R.dueNotices({ snapshot, settings: {}, now: NOW }).some(x => x.kind === 'meeting-prep'));
});

test('记忆优先级仅认明确的重要关系及对应名字；否定、普通关系和正文提到不提权', () => {
  const memory = [
    { kind: 'person', key: '负责人甲', text: '直属领导，消息优先' },
    { kind: 'person', key: '同事乙', text: '经常合作的同事' },
    { kind: 'group', key: '项目群', text: '重点关注' },
    { kind: 'person', key: '同事丙', text: '不重要，不优先，非重点，无需关注' },
    { kind: 'preference', key: '路人', text: '重点关注' },
  ];
  const score = P.createPriorityMatcher(memory);
  assert.equal(score({ senderName: '负责人甲' }), 1);
  assert.equal(score({ sender: '路人', text: '负责人甲让大家看材料' }), 0);
  assert.equal(score({ sender: '同事乙' }), 0);
  assert.equal(score({ sender: '同事丙' }), 0);
  assert.equal(score({ group: true, convName: '项目群' }), 1);
  assert.equal(score({ group: false, convName: '项目群' }), 0);
  for (const text of ['不优先', '不是重点', '非重点', '无需关注', '不是直属领导', '非负责人']) assert.equal(P.isPriorityMemory({ kind: 'person', key: '甲', text }), false);
  const rows = [{ sender: '同事乙', n: 1 }, { sender: '负责人甲', n: 2 }, { sender: '同事丙', n: 3 }, { sender: '负责人甲', n: 4 }];
  assert.deepEqual(P.prioritize(rows, memory).map(x => x.n), [2, 4, 1, 3]);
  assert.deepEqual(rows.map(x => x.n), [1, 2, 3, 4]);
});

test('简报同栏按明确记忆稳定提权，会议仍按时间，AI顺序不能挤掉首屏的重要待回', () => {
  const snapshot = empty();
  snapshot.meetings = D.meetings({ meetings: [
    { meetingId: 'later', subject: '晚会', meetingStartTime: NOW + 3600000 },
    { meetingId: 'earlier', subject: '早会', meetingStartTime: NOW },
  ] });
  for (let i = 0; i < 12; i += 1) {
    const conv = { id: 'p' + i, name: '同事' + i, group: false };
    snapshot.conversations.push(conv);
    snapshot.messages[conv.id] = D.messages({ chatInfo: [rawMessage(i, { sender: conv.name, serverSendTime: NOW - (12 - i) * 60000 })] }, conv, 'self');
  }
  const memory = [{ kind: 'person', key: '同事11', text: '直属领导' }];
  for (const brief of [B.fallbackBrief(snapshot, { day, now: NOW, memory }), B.parseAgentBrief('{}', snapshot, { day, now: NOW, memory })]) {
    assert.deepEqual(brief.sections.find(s => s.key === 'meetings').items.map(x => x.source), ['earlier', 'later'].map(id => snapshot.meetings.find(m => m.id === id).sourceId));
    const awaiting = brief.sections.find(s => s.key === 'awaiting').items;
    assert.equal(awaiting.length, 12); assert.equal(awaiting[0].source, 'msg:p11:11'); assert.equal(awaiting[0].top, true);
    assert.deepEqual(awaiting.slice(1).map(x => x.source), Array.from({ length: 11 }, (_, i) => `msg:p${i}:${i}`));
    assert.equal(brief.total, 14); assert.equal(brief.sections.flatMap(s => s.items).filter(x => x.top).length, 10);
  }
});

test('内联预算先容纳明确重要关系，未标优先的普通关系不改变选择', () => {
  const snapshot = empty(); snapshot.conversations = [privateConv];
  snapshot.messages.p = D.messages({ chatInfo: Array.from({ length: 80 }, (_, i) => rawMessage(i, { sender: i === 79 ? '负责人甲' : 'other', content: '原文'.repeat(150), serverSendTime: NOW - i * 1000 })) }, privateConv, 'self');
  const normal = B.inlineMessages(snapshot, { now: NOW });
  assert.ok(!normal.lines.some(x => x.includes('[msg:p:79]')));
  const priority = B.inlineMessages(snapshot, { now: NOW, memory: [{ kind: 'person', key: '负责人甲', text: '负责人，优先处理' }] });
  assert.ok(priority.lines.some(x => x.includes('[msg:p:79]')));
  assert.equal(priority.lines.length + priority.omitted, 80);
  const ordinary = B.inlineMessages(snapshot, { now: NOW, memory: [{ kind: 'person', key: '负责人甲', text: '同组同事' }] });
  assert.deepEqual(ordinary.lines, normal.lines);
});

test('明确源时区的全天日期缺结束时间时，推导源下一午夜并覆盖上海跨日和 DST 23/25 小时', () => {
  const [utc, spring, autumn, unknown, datetime] = D.calendarEvents([
    { id: 'utc', start: { date: '2026-10-21', timeZone: 'UTC' } },
    { id: 'spring', start: { date: '2026-03-08', timeZone: 'America/New_York' } },
    { id: 'autumn', start: { date: '2026-11-01', timeZone: 'America/New_York' } },
    { id: 'unknown', start: { date: '2026-10-21', timeZone: 'CST' } },
    { id: 'datetime', allDay: true, start: { dateTime: '2026-10-21T00:00:00', timeZone: 'UTC' } },
  ]);
  assert.equal(utc.end, Date.parse('2026-10-22T00:00:00Z'));
  assert.equal(utc.endDerived, true); assert.equal(utc.timeEvidence.end.derived, true); assert.equal(utc.timeEvidence.end.raw, null);
  assert.match(utc.displayRange, /2026-10-22（周四）08:00.*推导/);
  const tomorrow = { start: Date.parse('2026-10-22T00:00:00+08:00'), end: Date.parse('2026-10-23T00:00:00+08:00') };
  assert.equal(D.eventInRange(utc, tomorrow), true);
  assert.equal(spring.end - spring.start, 23 * 3600000);
  assert.equal(autumn.end - autumn.start, 25 * 3600000);
  assert.equal(unknown.timeStatus, 'unknown'); assert.equal(unknown.end, null); assert.equal(unknown.endDerived, undefined);
  assert.equal(datetime.end, null); assert.equal(datetime.endDerived, undefined);
});
