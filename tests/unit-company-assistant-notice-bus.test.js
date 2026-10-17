'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NoticeBus, KINDS } = require('../core/company-assistant/notice-bus');

test('提醒总线：同一 id 只发布一次；订阅者收到；只保留最近 50 条；未知类型拒收', () => {
  const bus = new NoticeBus({ now: () => 1000 });
  const got = [];
  bus.on('notice', n => got.push(n));
  assert.equal(bus.publish({ id: 'brief:2026-10-16', kind: 'brief', title: '今天 3 个会', text: '……' }), true);
  assert.equal(bus.publish({ id: 'brief:2026-10-16', kind: 'brief', title: '重复' }), false);
  assert.equal(bus.publish({ id: 'x', kind: 'unknown', title: 'x' }), false);
  assert.equal(got.length, 1); assert.equal(got[0].at, 1000);
  for (let i = 0; i < 60; i += 1) bus.publish({ id: 'k' + i, kind: 'keyword', title: 't' + i });
  assert.equal(bus.items.length, 50);
  assert.equal(bus.latest(1)[0].id, 'k59');
  assert.deepEqual(KINDS, ['brief', 'meeting-prep', 'awaiting-reply', 'commitment-due', 'overbooked', 'day-summary', 'keyword']);
});
