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

test('T3 家族过滤迁入搜索，侧栏不再渲染页签也不读旧筛选', () => {
  const sessions = new Map([['c1', sess('c1', 'claude', 'CLAUDE-ONE')], ['x1', sess('x1', 'codex', 'CODEX-ONE')]]);
  const r = makeRenderer({ sessions, storage: makeStorage({ hubSessionFamilyFilter: 'codex' }) });
  r.renderSessionList();
  assert.strictEqual(r.tabsEl.innerHTML, '');
  assert.ok(listedTitles(r.sessionListEl).includes('CLAUDE-ONE'));
  assert.ok(listedTitles(r.sessionListEl).includes('CODEX-ONE'));
});
console.log(failed === 0 ? 'All tests passed' : `${failed} test(s) failed`);
process.exit(failed === 0 ? 0 : 1);
