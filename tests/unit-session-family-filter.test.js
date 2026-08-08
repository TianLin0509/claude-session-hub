'use strict';
// 侧栏 AI 家族筛选页签（全部 / Claude / Codex / 其他）配套测试。
//
// 改动：renderer/session-list-renderer.js 新增 familyOfKind / sessionFamilies 两个纯函数，
//   renderSessionList 先按家族统计计数并渲染 #session-filter-tabs，再按当前选择筛列表。
//
// 关键契约（会被将来改动踩到的那几条）：
//   1. 家族看 kind 不看模型 —— Opus/Fable/Sonnet 都属 Claude，GPT 各版本都属 Codex；
//      *-resume 与基础 kind 同族。
//   2. 群聊按成员归属，可同属多族 —— 混合群聊在 Claude 页和 Codex 页都要出现。
//   3. 页签计数是家族总数，不是当前视图剩余条数 —— 否则切走就再也看不到别家有几个。
//   4. 选择落盘到 localStorage，重开 Hub 保持。

const assert = require('assert');
const path = require('path');

const {
  createSessionListRenderer,
  familyOfKind,
  sessionFamilies,
} = require(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'));

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e.stack || e.message || e));
  }
}

// --- Minimal DOM mock (same shape as unit-session-list-renderer-mini-ctx.test.js) ---
function makeEl(id) {
  const el = {
    id: id || '',
    children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    appendChild(child) { this.children.push(child); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text || ''; },
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop || 0; },
  };
  el.style.setProperty = () => {};
  return el;
}
function mockDoc(registry) {
  return {
    createElement: () => makeEl(),
    getElementById: (id) => registry[id] || null,
    head: makeEl(),
    documentElement: makeEl(),
  };
}
function makeStorage(initial) {
  const store = { ...(initial || {}) };
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
}
function makeRenderer({ sessions, meetings = {}, storage = makeStorage() }) {
  const sessionListEl = makeEl('session-list');
  const tabsEl = makeEl('session-filter-tabs');
  const r = createSessionListRenderer({
    document: mockDoc({ 'session-filter-tabs': tabsEl }),
    localStorage: storage,
    sessionListEl,
    getSessions: () => sessions,
    getMeetings: () => meetings,
    getActiveSessionId: () => null,
    getActiveMeetingId: () => null,
    isAiKind: (k) => ['claude', 'codex', 'gemini', 'deepseek', 'kimi'].includes(k),
    modelShort: (m) => (m && m.displayName) || '',
    modelClass: () => 'opus',
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    formatTime: () => '00:00',
    pctClass: () => 'ok',
    sessionBurnRate: () => null,
    selectSession: () => {},
    selectMeeting: () => {},
    openContextMenu: () => {},
  });
  return { ...r, sessionListEl, tabsEl, storage };
}
function listedTitles(sessionListEl) {
  return sessionListEl.children
    .map(c => c.innerHTML || '')
    .join('\n')
    .match(/[A-Za-z0-9一-龥-]+/g) || [];
}
function now() { return Date.now(); }
function sess(id, kind, title) {
  return { id, title: title || id, kind, status: 'idle', lastMessageTime: now(), createdAt: now() };
}

// ---------------- 用例 1：家族看 kind，模型只是家族内的选择 ----------------
test('familyOfKind：Claude CLI 家族（含 -resume），模型不参与判断', () => {
  assert.strictEqual(familyOfKind('claude'), 'claude');
  assert.strictEqual(familyOfKind('claude-resume'), 'claude', '-resume 必须与基础 kind 同族');
  assert.strictEqual(familyOfKind('codex'), 'codex');
  assert.strictEqual(familyOfKind('codex-resume'), 'codex');
  for (const kind of ['gemini', 'deepseek', 'kimi', 'powershell', 'glm', '', null, undefined]) {
    assert.strictEqual(familyOfKind(kind), 'other', `${kind} 应归「其他」`);
  }
});

// ---------------- 用例 2：群聊按成员归属，混合群聊同属多族 ----------------
test('sessionFamilies：混合群聊同时属于 Claude 与 Codex，不会切页签就消失', () => {
  const sessions = new Map();
  sessions.set('a', sess('a', 'claude'));
  sessions.set('b', sess('b', 'codex'));
  const meetingItem = {
    _isMeeting: true,
    _meeting: { id: 'm1', subSessions: ['a', 'b'] },
  };
  const families = sessionFamilies(meetingItem, sessions);
  assert.ok(families.has('claude'), '有 Claude 成员就该出现在 Claude 页');
  assert.ok(families.has('codex'), '有 Codex 成员就该出现在 Codex 页');
  assert.ok(!families.has('other'), '没有其他家成员时不应误入「其他」');
});

test('sessionFamilies：成员尚未同步进 map 的群聊落到「其他」，不凭空消失', () => {
  const meetingItem = { _isMeeting: true, _meeting: { id: 'm1', subSessions: ['ghost'] } };
  const families = sessionFamilies(meetingItem, new Map());
  assert.deepStrictEqual([...families], ['other']);
});

// ---------------- 用例 3：页签计数是家族总数，不受当前筛选影响 ----------------
test('页签计数是各家族总数，切到 Claude 后仍能看到 Codex 还有几个', () => {
  const sessions = new Map();
  sessions.set('c1', sess('c1', 'claude'));
  sessions.set('c2', sess('c2', 'claude-resume'));
  sessions.set('x1', sess('x1', 'codex'));
  sessions.set('g1', sess('g1', 'gemini'));
  sessions.set('k1', sess('k1', 'kimi'));

  const { renderSessionList, tabsEl, setFamilyFilter } = makeRenderer({ sessions });
  renderSessionList();
  const html = tabsEl.innerHTML;
  assert.ok(/全部<span class="sft-count">5</.test(html), `全部应为 5，实际：${html}`);
  assert.ok(/Claude<span class="sft-count">2</.test(html), `Claude 应为 2，实际：${html}`);
  assert.ok(/Codex<span class="sft-count">1</.test(html), `Codex 应为 1，实际：${html}`);
  assert.ok(/其他<span class="sft-count">2</.test(html), `其他应为 2（gemini+kimi），实际：${html}`);

  // 切到 Claude 后计数不能塌成「当前视图剩余」
  setFamilyFilter('claude');
  const after = tabsEl.innerHTML;
  assert.ok(/Codex<span class="sft-count">1</.test(after), `筛选后 Codex 计数仍应是 1，实际：${after}`);
  assert.ok(/全部<span class="sft-count">5</.test(after), `筛选后「全部」计数仍应是 5，实际：${after}`);
});

// ---------------- 用例 4：筛选真的过滤列表 ----------------
test('选中 Codex 后列表只剩 Codex 会话', () => {
  const sessions = new Map();
  sessions.set('c1', sess('c1', 'claude', 'CLAUDE-ONE'));
  sessions.set('x1', sess('x1', 'codex', 'CODEX-ONE'));
  sessions.set('g1', sess('g1', 'gemini', 'GEMINI-ONE'));

  const { renderSessionList, sessionListEl, setFamilyFilter } = makeRenderer({ sessions });
  renderSessionList();
  let words = listedTitles(sessionListEl);
  assert.ok(words.includes('CLAUDE-ONE') && words.includes('CODEX-ONE') && words.includes('GEMINI-ONE'),
    '默认「全部」应列出三个会话');

  setFamilyFilter('codex');
  words = listedTitles(sessionListEl);
  assert.ok(words.includes('CODEX-ONE'), 'Codex 页必须留下 Codex 会话');
  assert.ok(!words.includes('CLAUDE-ONE'), 'Codex 页不应出现 Claude 会话');
  assert.ok(!words.includes('GEMINI-ONE'), 'Codex 页不应出现 Gemini 会话');

  setFamilyFilter('other');
  words = listedTitles(sessionListEl);
  assert.ok(words.includes('GEMINI-ONE'), '「其他」页必须留下 Gemini 会话');
  assert.ok(!words.includes('CODEX-ONE'), '「其他」页不应出现 Codex 会话');
});

// ---------------- 用例 5：筛空时给出解释，不能看起来像会话丢了 ----------------
test('筛选结果为空时渲染解释文案，而不是一片空白', () => {
  const sessions = new Map();
  sessions.set('c1', sess('c1', 'claude'));
  const { renderSessionList, sessionListEl, setFamilyFilter } = makeRenderer({ sessions });
  renderSessionList();
  setFamilyFilter('codex');
  const hint = sessionListEl.children.find(c => c.className === 'session-filter-empty');
  assert.ok(hint, '空视图必须有 .session-filter-empty 提示节点');
  assert.ok(/共 1 个/.test(hint.textContent), `提示应说明总数，实际：${hint.textContent}`);
});

// ---------------- 用例 6：选择落盘 + 重开时读回 ----------------
test('筛选选择落盘 localStorage，重建 renderer 时读回', () => {
  const sessions = new Map();
  sessions.set('c1', sess('c1', 'claude'));
  sessions.set('x1', sess('x1', 'codex'));

  const storage = makeStorage();
  const first = makeRenderer({ sessions, storage });
  first.renderSessionList();
  first.setFamilyFilter('codex');
  assert.strictEqual(storage.store.hubSessionFamilyFilter, 'codex', '选择必须落盘');

  const second = makeRenderer({ sessions, storage });
  assert.strictEqual(second.getFamilyFilter(), 'codex', '重建 renderer 应读回上次选择');
  second.renderSessionList();
  assert.ok(/data-family="codex" role="tab" aria-selected="true"/.test(second.tabsEl.innerHTML),
    `重开后 Codex 页签应为选中态，实际：${second.tabsEl.innerHTML}`);
});

test('非法的落盘值回落到「全部」，不会把侧栏筛成空', () => {
  const sessions = new Map();
  sessions.set('c1', sess('c1', 'claude'));
  const storage = makeStorage({ hubSessionFamilyFilter: 'gpt-4' });
  const r = makeRenderer({ sessions, storage });
  assert.strictEqual(r.getFamilyFilter(), 'all');
});

console.log(failed === 0 ? '\nAll tests passed' : `\n${failed} test(s) failed`);
process.exit(failed === 0 ? 0 : 1);
