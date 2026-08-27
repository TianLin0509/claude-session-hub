'use strict';
const assert = require('assert');
const {
  compareLatestActivityDesc,
  latestActivityTime,
  partitionSessionsByAge,
} = require('../renderer/session-list-renderer.js');

const now = 1000000000000;
const DAY = 86400000;
const MINUTE = 60_000;
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

// 2026-08-27 反转口径：此处原本锁的是「只提问不算，必须回答完成才上浮」。
// 实测那条规则让**正在进行中**的会话按上一轮完成时间排——刚说完话的会话沉到下面，
// 跨过 24 小时还会掉进「3 天内」。现在改成取所有来往时刻的最大值。
test('刚说过话的会话必须浮到最上面，即使这一轮还没答完', () => {
  const items = [
    {
      id: 'answered-long-ago-but-talking-now',
      lastCompletedAt: now - 50 * HOUR,   // 上一轮回答是两天前
      lastMessageTime: now - 12 * MINUTE, // 但 12 分钟前刚说过话
      runStartedAt: now - 12 * MINUTE,    // 而且这一轮正在跑
    },
    { id: 'answered-recently', lastCompletedAt: now - 1 * HOUR },
    { id: 'idle-two-days', lastCompletedAt: now - 50 * HOUR },
  ];
  const { recent, mid } = partitionSessionsByAge(items, now);
  assert.deepStrictEqual(recent.map(x => x.id).sort(),
    ['answered-long-ago-but-talking-now', 'answered-recently']);
  assert.deepStrictEqual(mid.map(x => x.id), ['idle-two-days']);
  assert.strictEqual(latestActivityTime(items[0]), now - 12 * MINUTE);
  assert.deepStrictEqual(items.slice().sort(compareLatestActivityDesc).map(x => x.id), [
    'answered-long-ago-but-talking-now',
    'answered-recently',
    'idle-two-days',
  ]);
});

// 只打开、不说话的会话不该被顶上来：选中会话不写任何时间字段，
// runStartedAt 只在提交提问时写（core/session-attention-state.js）。
test('只打开不说话不会让老会话上浮', () => {
  const opened = { id: 'opened-only', lastCompletedAt: now - 50 * HOUR };
  const { recent, mid } = partitionSessionsByAge([opened], now);
  assert.deepStrictEqual(recent.map(x => x.id), []);
  assert.deepStrictEqual(mid.map(x => x.id), ['opened-only']);
});

// 终端刷屏不算来往：原始输出时间戳有意不参与，否则任何在刷日志的会话都会一直霸榜。
test('终端原始输出时间戳不参与最近程度', () => {
  const noisy = { id: 'noisy', lastCompletedAt: now - 50 * HOUR, _lastOutputTs: now, lastOutputTs: now };
  assert.strictEqual(latestActivityTime(noisy), now - 50 * HOUR);
});

test('空/缺省输入安全', () => {
  assert.deepStrictEqual(partitionSessionsByAge([], now), { recent: [], mid: [], old: [] });
  assert.deepStrictEqual(partitionSessionsByAge(undefined, now), { recent: [], mid: [], old: [] });
});

console.log('All session-list time-partition tests passed.');
