'use strict';
const assert = require('assert');
const {
  compareLatestReplyDesc,
  latestReplyTime,
  partitionSessionsByAge,
} = require('../renderer/session-list-renderer.js');

const now = 1000000000000;
const DAY = 86400000;
const HOUR = 3600000;

function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (e) { console.error('  FAIL ' + name); console.error(e.message); process.exitCode = 1; }
}

console.log('Running session-list time-partition tests...');

test('recent(<24h) / mid(24-72h) / old(>=72h) 正确分桶', () => {
  const items = [
    { id: 'r', lastMessageTime: now - 1 * HOUR },
    { id: 'r2', lastMessageTime: now - 23 * HOUR },
    { id: 'm', lastMessageTime: now - 25 * HOUR },
    { id: 'm2', lastMessageTime: now - 71 * HOUR },
    { id: 'o', lastMessageTime: now - 73 * HOUR },
    { id: 'o2', lastMessageTime: now - 30 * DAY },
  ];
  const { recent, mid, old } = partitionSessionsByAge(items, now);
  assert.deepStrictEqual(recent.map(x => x.id), ['r', 'r2']);
  assert.deepStrictEqual(mid.map(x => x.id), ['m', 'm2']);
  assert.deepStrictEqual(old.map(x => x.id), ['o', 'o2']);
});

test('边界：恰好 24h 进 mid，恰好 72h 进 old', () => {
  const items = [
    { id: 'd24', lastMessageTime: now - DAY },
    { id: 'd72', lastMessageTime: now - 3 * DAY },
  ];
  const { recent, mid, old } = partitionSessionsByAge(items, now);
  assert.deepStrictEqual(recent.map(x => x.id), []);
  assert.deepStrictEqual(mid.map(x => x.id), ['d24']);
  assert.deepStrictEqual(old.map(x => x.id), ['d72']);
});

test('pinned 永远进 recent（即使很旧）', () => {
  const { recent, mid, old } = partitionSessionsByAge(
    [{ id: 'pold', pinned: true, lastMessageTime: now - 100 * DAY }], now);
  assert.deepStrictEqual(recent.map(x => x.id), ['pold']);
  assert.strictEqual(mid.length, 0);
  assert.strictEqual(old.length, 0);
});

test('无 lastMessageTime 回退 createdAt，再回退 now', () => {
  const { recent, mid } = partitionSessionsByAge(
    [{ id: 'c', createdAt: now - 26 * HOUR }, { id: 'n' }], now);
  assert.ok(recent.map(x => x.id).includes('n'));
  assert.ok(mid.map(x => x.id).includes('c'));
});

test('有回答完成时间时，排序与分桶不再受提问时间影响', () => {
  const items = [
    {
      id: 'answered-recently',
      lastMessageTime: now - 50 * HOUR,
      lastCompletedAt: now - 1 * HOUR,
    },
    {
      id: 'prompted-recently-but-answer-old',
      lastMessageTime: now - 1 * HOUR,
      lastCompletedAt: now - 50 * HOUR,
    },
  ];
  const { recent, mid } = partitionSessionsByAge(items, now);
  assert.deepStrictEqual(recent.map(x => x.id), ['answered-recently']);
  assert.deepStrictEqual(mid.map(x => x.id), ['prompted-recently-but-answer-old']);
  assert.strictEqual(latestReplyTime(items[0]), now - HOUR);
  assert.deepStrictEqual(items.slice().sort(compareLatestReplyDesc).map(x => x.id), [
    'answered-recently',
    'prompted-recently-but-answer-old',
  ]);
});

test('空/缺省输入安全', () => {
  assert.deepStrictEqual(partitionSessionsByAge([], now), { recent: [], mid: [], old: [] });
  assert.deepStrictEqual(partitionSessionsByAge(undefined, now), { recent: [], mid: [], old: [] });
});

console.log('All session-list time-partition tests passed.');
