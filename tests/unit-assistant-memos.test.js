'use strict';
// 备忘清单：分组与编号、原话原样保留、推迟与完成联动提醒、晚间清单只推一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const { AssistantMemos } = require('../core/hub-assistant/memos');
const { AssistantReminders } = require('../core/hub-assistant/reminders');

function setup(startIso = '2026-10-05T02:00:00Z') { // 北京时间 10-05 10:00（周一）
  const kv = new Map(), store = { get: k => kv.get(k), set: (k, v) => kv.set(k, v) };
  let t = Date.parse(startIso); const clock = { now: () => t, set: iso => { t = Date.parse(iso); }, add: ms => { t += ms; } };
  const fired = [], digests = [], changes = [];
  const reminders = new AssistantReminders({ store, now: clock.now, onFire: r => fired.push(r) });
  const memos = new AssistantMemos({ store, reminders, now: clock.now, onChange: m => changes.push(m), onDigest: d => digests.push(d) });
  return { store, clock, reminders, memos, fired, digests, changes };
}

test('memos group into today / soon / anytime / later with one numbering shared by every view', () => {
  const x = setup();
  const a = x.memos.add({ title: '问基站 license', raw: '记一下，明天问问基站 license 的事' });
  const b = x.memos.add({ title: '给张工回评审意见', raw: '周五前要给张工回评审意见', due: '2026-10-05 15:00' });
  const c = x.memos.add({ title: '周会准备材料', raw: '周三早上九点周会要准备材料', due: '2026-10-07 09:00' });
  const d = x.memos.add({ title: '信道老化加权的想法', raw: '突然想到调度可以按信道老化程度加权', kind: 'idea' });
  x.memos.update(d.id, { action: 'snooze', until: 'later' });
  const open = x.memos.openList();
  assert.deepEqual(open.map(m => [m.no, m.title, m.group]), [[1, '给张工回评审意见', 'today'], [2, '周会准备材料', 'soon'], [3, '问基站 license', 'anytime'], [4, '信道老化加权的想法', 'later']]);
  assert.equal(x.memos.find('2').id, c.id, '「第 2 条」指的就是清单上的第 2 条');
  assert.equal(x.memos.find(a.id.slice(0, 8)).id, a.id, '也能用 id 前缀找');
  assert.equal(x.memos.all().find(m => m.id === a.id).raw, '记一下，明天问问基站 license 的事', '原话原样保留');
  assert.ok(b.reminderId && c.reminderId && !a.reminderId, '有时间的才联动到点提醒');
  assert.equal(x.reminders.upcoming().length, 2);
  const v = x.memos.view();
  assert.equal(v.open[0].dueLabel, '今天 15:00'); assert.equal(v.open[1].dueLabel, '周三 09:00');
  assert.ok(x.changes.length >= 5, '每次改动都通知界面与手机');
});

test('done and drop cancel the linked reminder; snooze moves it; overdue stays in today', () => {
  const x = setup();
  const b = x.memos.add({ title: '给张工回评审意见', raw: 'x', due: '2026-10-05 15:00' });
  const first = b.reminderId, r1 = x.memos.update(b.id, { action: 'snooze', until: '2026-10-06 09:00' });
  assert.equal(r1.reminderCancelled.id, first); assert.ok(r1.reminderSet);
  assert.equal(x.reminders.upcoming().length, 1); assert.equal(x.memos.openList()[0].group, 'soon');
  assert.equal(x.memos.all()[0].snoozes, 1);
  x.clock.set('2026-10-06T01:00:30Z'); x.reminders.fireDue(); // 北京 10-06 09:00:30 提醒响
  assert.equal(x.fired.length, 1); x.memos.reminderFired(x.fired[0]);
  assert.equal(x.memos.openList()[0].status, 'open', '提醒响过仍是待办，办完才算完');
  x.clock.set('2026-10-07T02:00:00Z');
  assert.equal(x.memos.openList()[0].group, 'today', '过期的留在今天');
  x.memos.update('1', { action: 'done' });
  assert.equal(x.memos.openList().length, 0); assert.equal(x.memos.closedList()[0].status, 'done');
  const c = x.memos.add({ title: '订会议室', raw: 'y', due: '2026-10-08 10:00' });
  x.memos.update(c.id, { action: 'drop' });
  assert.equal(x.reminders.upcoming().length, 0, '不做了也取消提醒');
  x.memos.update(c.id, { action: 'reopen' }); assert.equal(x.memos.openList().length, 1);
  assert.throws(() => x.memos.update(c.id, { action: 'archive' }), /action/);
  assert.throws(() => x.memos.add({ title: '  ', raw: 'z' }), /标题/);
  assert.throws(() => x.memos.find('9'), /没有找到/);
});

test('the evening digest goes out once at 21:00 Beijing, numbered, with week-old items called out; empty lists are not pushed', () => {
  const x = setup();
  x.memos.fireDigest(); assert.equal(x.digests.length, 0, '21 点前不推');
  x.clock.set('2026-10-05T13:00:05Z'); // 北京 21:00:05
  x.memos.fireDigest(); assert.equal(x.digests.length, 0, '清单为空不推');
  x.clock.set('2026-09-27T02:00:00Z'); x.memos.add({ title: '整理旧仿真脚本', raw: 'a' });
  x.clock.set('2026-10-05T12:00:00Z'); x.memos.add({ title: '问基站 license', raw: 'b' });
  x.store.set('memoDigestDay', null);
  x.clock.set('2026-10-06T13:00:05Z'); // 北京 10-06 21:00:05
  const text = x.memos.fireDigest();
  assert.match(text, /2 条待办/); assert.match(text, /1\. 整理旧仿真脚本/); assert.match(text, /2\. 问基站 license/);
  assert.match(text, /其中 1 号放了一周以上/); assert.match(text, /第 2 条办完了/);
  assert.equal(x.digests.length, 1); assert.match(x.digests[0].id, /^memo-digest:/);
  x.clock.add(3600000); x.memos.fireDigest(); assert.equal(x.digests.length, 1, '一晚只推一次');
});
