const assert = require('assert');
const path = require('path');

const {
  STORAGE_KEY,
  isCardEmpty,
  readPrefs,
  createHomeCardLayout,
} = require(path.join(__dirname, '..', 'renderer', 'home-card-layout.js'));
const {
  STORAGE_KEY: SEARCH_KEY,
  normalizeQuery,
  readRecent,
  recordSearch,
  clearRecent,
  MAX_ENTRIES,
} = require(path.join(__dirname, '..', 'core', 'search-recent.js'));

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    _data: data,
  };
}

// ---------------- 最近搜索 ----------------

function testSearchRecent() {
  assert.strictEqual(normalizeQuery('  阿里云   健康  '), '阿里云 健康');
  assert.strictEqual(normalizeQuery(null), '');

  const store = makeStore();
  assert.deepStrictEqual(readRecent(store), []);

  // 零命中不记：工作台上摆一堆搜不到东西的词没有意义
  recordSearch(store, { query: '不存在的词', sessions: 0, matches: 0 });
  assert.deepStrictEqual(readRecent(store), []);

  // 太短不记
  recordSearch(store, { query: 'a', sessions: 3, matches: 9 });
  assert.deepStrictEqual(readRecent(store), []);

  recordSearch(store, { query: 'superwireless', sessions: 3, matches: 9, now: 1000 });
  let recent = readRecent(store);
  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].query, 'superwireless');
  assert.strictEqual(recent[0].sessions, 3);
  assert.strictEqual(recent[0].uses, 1);

  // 同一个词再搜：不新增条目，uses 加一并提到最前
  recordSearch(store, { query: '探针回分', sessions: 1, matches: 2, now: 2000 });
  recordSearch(store, { query: 'superwireless', sessions: 5, matches: 20, now: 3000 });
  recent = readRecent(store);
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].query, 'superwireless', '刚搜过的要排最前');
  assert.strictEqual(recent[0].uses, 2);
  assert.strictEqual(recent[0].sessions, 5, '命中数要更新成最新一次');

  // 超过上限只留最近的
  for (let i = 0; i < MAX_ENTRIES + 4; i++) {
    recordSearch(store, { query: 'q' + i + i, sessions: 1, matches: 1, now: 4000 + i });
  }
  assert.strictEqual(readRecent(store).length, MAX_ENTRIES);

  // 脏数据不该抛
  const dirty = makeStore({ [SEARCH_KEY]: '{ 不是 json' });
  assert.deepStrictEqual(readRecent(dirty), []);
  const notArray = makeStore({ [SEARCH_KEY]: '{"a":1}' });
  assert.deepStrictEqual(readRecent(notArray), []);
  assert.deepStrictEqual(clearRecent(store), []);

  // 存储不可用时也要能跑
  assert.deepStrictEqual(readRecent(null), []);
  assert.doesNotThrow(() => recordSearch(null, { query: 'x1', sessions: 1 }));
}

// ---------------- 卡片布局 ----------------

function makeEl(tag = 'div') {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    childNodes: [],
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    draggable: false,
    parentElement: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v); },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    appendChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, child);
      child.parentElement = this;
      return child;
    },
    querySelector(sel) { return el._find(sel)[0] || null; },
    querySelectorAll(sel) { return el._find(sel); },
    _find(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (sel.includes('home-section-head') && c.classList.contains('home-section-head')) out.push(c);
          if (sel.includes('data-home-collapse') && c.getAttribute('data-home-collapse')) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    get firstChild() { return this.children[0] || null; },
    _classes: classes,
    _attrs: attrs,
    _listeners: listeners,
  };
  return el;
}

function makeCard(id, { emptyBody = false } = {}) {
  const card = makeEl('section');
  card.setAttribute('data-home-card', id);
  const head = makeEl('div');
  head.classList.add('home-section-head');
  card.appendChild(head);
  const body = makeEl('div');
  body.textContent = emptyBody ? '   ' : '有内容';
  body.querySelector = () => null;
  card.appendChild(body);
  return card;
}

function makeDoc(cards, stack) {
  return {
    getElementById(id) { return id === 'home-card-stack' ? stack : null; },
    // 真实 DOM 的 querySelectorAll 按文档顺序返回，拖动换位后顺序会变。
    // mock 也必须从 stack 的当前子节点取，否则测不出排序落盘。
    querySelectorAll(sel) {
      if (!sel.includes('data-home-card')) return [];
      return stack.children.filter(c => c.getAttribute('data-home-card'));
    },
    createElement: (tag) => makeEl(tag),
  };
}

function testCardLayout() {
  assert.ok(isCardEmpty(makeCard('a', { emptyBody: true })));
  assert.ok(!isCardEmpty(makeCard('b')));

  const cards = [makeCard('resume', { emptyBody: true }), makeCard('workspace'), makeCard('system')];
  const stack = makeEl('div');
  for (const c of cards) stack.appendChild(c);
  const store = makeStore();
  const doc = makeDoc(cards, stack);

  const layout = createHomeCardLayout({ document: doc, localStorage: store });

  // 每张卡都注入了折叠按钮和把手
  for (const c of cards) {
    assert.ok(c.querySelector('[data-home-collapse]'), '折叠按钮应被注入');
    assert.strictEqual(c.getAttribute('data-home-collapsed'), '0');
  }
  // 空卡自动标记
  assert.strictEqual(cards[0].getAttribute('data-home-empty'), '1', '空卡应收成一行');
  assert.strictEqual(cards[1].getAttribute('data-home-empty'), '0');

  // 折叠会落盘
  layout.toggle(cards[2]);
  assert.strictEqual(cards[2].getAttribute('data-home-collapsed'), '1');
  assert.strictEqual(readPrefs(store).collapsed.system, true);
  layout.toggle(cards[2]);
  assert.strictEqual(readPrefs(store).collapsed.system, false);

  // 顺序落盘
  stack.appendChild(cards[0]);
  layout.persist();
  assert.deepStrictEqual(readPrefs(store).order, ['workspace', 'system', 'resume']);

  // 存过的折叠状态在下次构造时要还原
  const store2 = makeStore({ [STORAGE_KEY]: JSON.stringify({ order: [], collapsed: { workspace: true } }) });
  const cards2 = [makeCard('workspace'), makeCard('system')];
  const stack2 = makeEl('div');
  for (const c of cards2) stack2.appendChild(c);
  createHomeCardLayout({ document: makeDoc(cards2, stack2), localStorage: store2 });
  assert.strictEqual(cards2[0].getAttribute('data-home-collapsed'), '1');
  assert.strictEqual(cards2[1].getAttribute('data-home-collapsed'), '0');

  // 脏偏好不该抛
  const dirty = makeStore({ [STORAGE_KEY]: 'not json' });
  assert.deepStrictEqual(readPrefs(dirty), { order: [], collapsed: {} });
  assert.doesNotThrow(() => createHomeCardLayout({ document: makeDoc([], makeEl('div')), localStorage: null }));
}

testSearchRecent();
testCardLayout();
console.log('unit-home-card-layout OK');
