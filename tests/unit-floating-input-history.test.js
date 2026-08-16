'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFloatingInputHistory,
  shouldRecallNewer,
  shouldRecallOlder,
} = require('../renderer/floating-input-history.js');

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

test('发送过的消息按新到旧入栈，连发同一句不堆重复', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', '第一条');
  history.push('s1', '第二条');
  history.push('s1', '第一条');
  assert.deepEqual(history.list('s1'), ['第一条', '第二条']);
});

test('空白内容不入历史', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', '   ');
  history.push('s1', '');
  history.push('s1', '\n\t');
  assert.deepEqual(history.list('s1'), []);
});

test('每个 session 各自一份历史，互不串味', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', 'A');
  history.push('s2', 'B');
  assert.deepEqual(history.list('s1'), ['A']);
  assert.deepEqual(history.list('s2'), ['B']);
});

test('条数与 session 数都有上限，localStorage 不会无限涨', () => {
  const history = createFloatingInputHistory({ storage: makeStorage(), limit: 3, sessionLimit: 2 });
  for (const text of ['1', '2', '3', '4']) history.push('s1', text);
  assert.deepEqual(history.list('s1'), ['4', '3', '2']);

  history.push('s2', 'x');
  history.push('s3', 'y');
  // 最新写入的那个必须活着，最老的被回收。
  assert.deepEqual(history.list('s3'), ['y']);
  assert.deepEqual(history.list('s1'), []);
});

test('storage 坏掉（写抛异常 / 内容不是 JSON）时降级成空历史而不是崩', () => {
  const broken = {
    getItem() { return '{not json'; },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  const history = createFloatingInputHistory({ storage: broken });
  assert.deepEqual(history.list('s1'), []);
  assert.doesNotThrow(() => history.push('s1', 'hello'));
});

test('没有 storage 时（如单测环境）功能整体静默关闭', () => {
  const history = createFloatingInputHistory({ storage: null });
  history.push('s1', 'hello');
  assert.deepEqual(history.list('s1'), []);
  assert.equal(history.createCursor('s1').older(''), null);
});

test('游标：↑ 逐条往上，到顶后返回 null 而不是把草稿吃掉', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', '旧');
  history.push('s1', '新');
  const cursor = history.createCursor('s1');

  assert.equal(cursor.isBrowsing(), false);
  assert.equal(cursor.older('写了一半').text, '新');
  assert.equal(cursor.isBrowsing(), true);
  assert.equal(cursor.older('写了一半').text, '旧');
  assert.equal(cursor.older('写了一半'), null, '到顶应该返回 null，让 ↑ 回到原生行为');
  assert.equal(cursor.index, 1, '到顶后下标不能继续前进');
});

test('游标：↓ 翻回底部要还原进入浏览前的草稿', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', '旧');
  history.push('s1', '新');
  const cursor = history.createCursor('s1');

  cursor.older('我的草稿');
  cursor.older('我的草稿');
  assert.equal(cursor.newer().text, '新');
  const back = cursor.newer();
  assert.equal(back.text, '我的草稿');
  assert.equal(back.restoredDraft, true);
  assert.equal(cursor.isBrowsing(), false);
  assert.equal(cursor.newer(), null, '没在浏览时 ↓ 不该接管');
});

test('游标：进入浏览时草稿是空的，翻回底部也要老老实实还原成空', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', '发过的');
  const cursor = history.createCursor('s1');

  assert.equal(cursor.older('').text, '发过的');
  const back = cursor.newer();
  assert.equal(back.text, '', '空草稿必须还原成空，不能留着历史内容');
  assert.equal(back.restoredDraft, true);
});

test('游标：历史为空时 ↑ 完全不接管', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  const cursor = history.createCursor('s1');
  assert.equal(cursor.older('草稿'), null);
  assert.equal(cursor.isBrowsing(), false);
});

test('游标 reset 后重新从最新一条开始，不接着上次下标', () => {
  const history = createFloatingInputHistory({ storage: makeStorage() });
  history.push('s1', 'A');
  history.push('s1', 'B');
  const cursor = history.createCursor('s1');

  cursor.older('');
  cursor.older('');
  cursor.reset();
  assert.equal(cursor.isBrowsing(), false);
  assert.equal(cursor.older('').text, 'B');
});

test('↑ 只在空框或光标已在开头时召回，多行编辑中不抢键', () => {
  assert.equal(shouldRecallOlder({ key: 'ArrowUp', isEmpty: true, caretAtStart: false }), true);
  assert.equal(shouldRecallOlder({ key: 'ArrowUp', isEmpty: false, caretAtStart: true }), true);
  // 多行 prompt 中间按 ↑ 想上移一行 —— 抢过来会把整段顶掉，比没有历史更糟。
  assert.equal(shouldRecallOlder({ key: 'ArrowUp', isEmpty: false, caretAtStart: false }), false);
  // 已经在浏览历史里就继续往上翻，不受光标位置影响。
  assert.equal(shouldRecallOlder({ key: 'ArrowUp', isEmpty: false, caretAtStart: false, isBrowsing: true }), true);
  // 带修饰键的 ↑ 是别的快捷键（Ctrl+↑ 跳 prompt），不能抢。
  assert.equal(shouldRecallOlder({ key: 'ArrowUp', isEmpty: true, hasModifier: true }), false);
  assert.equal(shouldRecallOlder({ key: 'ArrowDown', isEmpty: true, caretAtStart: true }), false);
});

test('↓ 只在浏览历史时接管，平时就是普通下移一行', () => {
  assert.equal(shouldRecallNewer({ key: 'ArrowDown', isBrowsing: true }), true);
  assert.equal(shouldRecallNewer({ key: 'ArrowDown', isBrowsing: false }), false);
  assert.equal(shouldRecallNewer({ key: 'ArrowDown', isBrowsing: true, hasModifier: true }), false);
  assert.equal(shouldRecallNewer({ key: 'ArrowUp', isBrowsing: true }), false);
});

test('历史跨"重新打开游标"仍在（已落 storage）', () => {
  const storage = makeStorage();
  createFloatingInputHistory({ storage }).push('s1', '上次说的话');
  const reopened = createFloatingInputHistory({ storage });
  assert.equal(reopened.createCursor('s1').older('').text, '上次说的话');
});
