'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingMemberWake } = require('../renderer/meeting-member-wake');
test('普通状态及串行群聊打开时唤醒所有休眠成员，重复点击共用一次请求', async () => {
  const sessions = new Map([['a', { status: 'dormant' }], ['b', { status: 'dormant' }], ['live', { status: 'idle' }]]);
  const calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const wake = createMeetingMemberWake({ getSession: id => sessions.get(id), resumeSession: async id => { calls.push(id); await gate; return { id }; } });
  const group = { id: 'g', status: 'idle', serialWorkflow: { enabled: true }, participants: [0], subSessions: ['a', 'b', 'live', 'a', 'missing'] };
  const first = wake(group); assert.equal(wake(group), first);
  assert.deepEqual(calls, ['a', 'b']); release(); await first;
});
test('成员失败不阻止其他唤醒，报告具体成员和原因且允许重试', async () => {
  let fail = true; const calls = [];
  const wake = createMeetingMemberWake({ getSession: id => ({ title: id, status: 'dormant' }), resumeSession: async id => {
    calls.push(id); if (id === 'bad' && fail) throw new Error('resume rejected'); return { id };
  } });
  const group = { id: 'g', subSessions: ['bad', 'good'] };
  await assert.rejects(wake(group), /bad：resume rejected/); assert.deepEqual(calls, ['bad', 'good']);
  fail = false; await wake(group); assert.equal(calls.length, 4);
});
test('空结果或显式失败不能伪装为唤醒成功', async () => {
  for (const result of [null, { ok: false, error: 'no native id' }]) {
    const wake = createMeetingMemberWake({ getSession: () => ({ status: 'dormant' }), resumeSession: async () => result });
    await assert.rejects(wake({ id: 'g', subSessions: ['bad'] }), /bad：/);
  }
});
