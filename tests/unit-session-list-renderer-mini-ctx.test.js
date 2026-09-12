'use strict';
// Group members now reuse ordinary rows. Retain context, unread and legacy
// meeting coverage while checking the nested sidebar DOM.

const assert = require('assert');
const path = require('path');

const { createSessionListRenderer } = require(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'));

function treeHtml(el) { return [el.innerHTML || '', ...(el.children || []).map(treeHtml)].join('\n'); }

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

// --- Minimal jsdom-free DOM mock (only properties miniJumpsHtml + outer renderer touch) ---
function makeEl() {
  const el = {
    children: [],
    _attrs: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ''; },
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop || 0; },
    setProperty() {},
  };
  el.style.setProperty = () => {};
  return el;
}
function mockDoc() {
  return {
    createElement: () => makeEl(),
    getElementById: () => null,
    head: makeEl(),
    documentElement: makeEl(),
  };
}
function pctClass(pct) {
  if (pct >= 80) return 'danger';
  if (pct >= 50) return 'warn';
  return 'ok';
}
function makeRenderer({ sessions, meetings, activeMeetingId = null }) {
  const sessionListEl = makeEl();
  const r = createSessionListRenderer({
    document: mockDoc(),
    localStorage: { getItem: () => '[]', setItem: () => {} },
    sessionListEl,
    getSessions: () => sessions,
    getMeetings: () => meetings,
    getActiveSessionId: () => null,
    getActiveMeetingId: () => activeMeetingId,
    isAiKind: (k) => ['claude', 'codex', 'gemini', 'deepseek'].includes(k),
    modelShort: (m) => m && m.displayName || '',
    modelClass: () => 'opus',
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])),
    formatTime: () => '00:00',
    pctClass,
    sessionBurnRate: () => null,
    selectSession: () => {},
    selectMeeting: () => {},
    openContextMenu: () => {},
  });
  return { ...r, sessionListEl };
}

// ---------------- 用例 1：群聊 + sub.contextPct=22 → 渲染 .mini-jump-ctx ok 22% ----------------
test('群聊成员复用普通行，在状态环保留 Ctx 分级，旧 mini-jump 不再重复展示', () => {
  const sessions = new Map();
  sessions.set('sid-a', { id: 'sid-a', title: 'AI-A', kind: 'gemini', status: 'idle', contextPct: 22 });
  sessions.set('sid-b', { id: 'sid-b', title: 'AI-B', kind: 'codex', status: 'idle', contextPct: 88 });
  sessions.set('sid-c', { id: 'sid-c', title: 'AI-C', kind: 'deepseek', status: 'idle', contextPct: 55 });
  const meetings = {
    m1: {
      id: 'm1', title: '群聊1', subSessions: ['sid-a', 'sid-b', 'sid-c'],
      groupChat: true, status: 'idle', participants: [0, 2],
      lastMessageTime: Date.now(), createdAt: Date.now(),
    }
  };
  const { renderSessionList, sessionListEl } = makeRenderer({ sessions, meetings });
  renderSessionList();
  const html = treeHtml(sessionListEl);
  const wrapper = sessionListEl.children.find(el => el.dataset.sidebarGroup === 'm1');
  assert.ok(wrapper, '群聊需要包住父行和子行，鼠标可移动到成员');
  assert.equal(wrapper.children[1].children.length, 3);
  assert.ok(wrapper.children[1].children.every(el => el.className.includes('child')));
  assert.doesNotMatch(html, /mini-jump-cell|sl-members-hint/);
  for (const pct of [22, 88, 55]) assert.ok(html.includes(`Ctx ${pct}%`));
});

// ---------------- 用例 2：contextPct=null 时不渲染数字（避免占位） ----------------
test('群聊 sub.contextPct=null 时保留成员行，不虚构上下文数字', () => {
  const sessions = new Map();
  sessions.set('sid-a', { id: 'sid-a', title: 'AI-A', kind: 'gemini', status: 'idle', contextPct: null });
  const meetings = {
    m1: {
      id: 'm1', title: '群聊1', subSessions: ['sid-a'],
      groupChat: true, status: 'idle',
      lastMessageTime: Date.now(), createdAt: Date.now(),
    }
  };
  const { renderSessionList, sessionListEl } = makeRenderer({ sessions, meetings });
  renderSessionList();
  const html = treeHtml(sessionListEl);
  assert.ok(html.includes('AI-A'), '成员行仍应存在');
  assert.doesNotMatch(html, /Ctx \d+%|mini-jump-ctx/);
});

// ---------------- 用例 3：非群聊 meeting（Pokemon 模板）不渲染 Ctx%（语义不适用） ----------------
test('非群聊 meeting 即便 sub.contextPct 存在也不渲染 mini-jump-ctx', () => {
  const sessions = new Map();
  sessions.set('sid-a', { id: 'sid-a', title: 'AI-A', kind: 'claude', status: 'idle', contextPct: 30 });
  const meetings = {
    m1: {
      id: 'm1', title: '会议1', subSessions: ['sid-a'],
      groupChat: false, status: 'idle',
      lastMessageTime: Date.now(), createdAt: Date.now(),
    }
  };
  const { renderSessionList, sessionListEl } = makeRenderer({ sessions, meetings });
  renderSessionList();
  const html = treeHtml(sessionListEl);
  assert.ok(!/mini-jump-ctx/.test(html), '非群聊 meeting 不应渲染 mini-jump-ctx（slot 头像是 Pokemon，Ctx 语义对应不上）');
});

// ---------------- 用例 4：unreadAnsweredSize > 0 时 badge 显示"已答 N" ----------------
test('meeting.unreadAnswered 有 N 个 sid 时侧栏显示 "已答 N"', () => {
  const sessions = new Map();
  sessions.set('sid-a', { id: 'sid-a', title: 'AI-A', kind: 'gemini', status: 'idle' });
  sessions.set('sid-b', { id: 'sid-b', title: 'AI-B', kind: 'codex', status: 'idle' });
  const answered = new Set(['sid-a', 'sid-b']);
  const meetings = {
    m1: {
      id: 'm1', title: '群聊1', subSessions: ['sid-a', 'sid-b'],
      groupChat: true, status: 'idle',
      lastMessageTime: Date.now(), createdAt: Date.now(),
      unreadAnswered: answered,
    }
  };
  const { renderSessionList, sessionListEl } = makeRenderer({ sessions, meetings, activeMeetingId: null });
  renderSessionList();
  const html = treeHtml(sessionListEl);
  assert.ok(/sl-group-icon unread/.test(html), '群聊图标保留父项未读状态');
});

// ---------------- 用例 5：active 时不显示 badge（即便 unreadAnswered 非空） ----------------
test('meeting 当前 active 时仍保留未读 badge', () => {
  const sessions = new Map();
  sessions.set('sid-a', { id: 'sid-a', title: 'AI-A', kind: 'gemini', status: 'idle' });
  const meetings = {
    m1: {
      id: 'm1', title: '群聊1', subSessions: ['sid-a'],
      groupChat: true, status: 'idle',
      lastMessageTime: Date.now(), createdAt: Date.now(),
      unreadAnswered: new Set(['sid-a']),
    }
  };
  const { renderSessionList, sessionListEl } = makeRenderer({ sessions, meetings, activeMeetingId: 'm1' });
  renderSessionList();
  const html = treeHtml(sessionListEl);
  assert.ok(/sl-unread-badge[^>]*>1 位未读/.test(html), '选中群聊不应清除成员未读');
});

test('自动休眠会话保留未读红点、数量和唤醒提示', () => {
  const sessions = new Map();
  sessions.set('sleeping', {
    id: 'sleeping',
    title: '休眠但有新消息',
    kind: 'codex',
    status: 'dormant',
    suspendReason: 'idle-timeout',
    unreadCount: 3,
    lastMessageTime: Date.now(),
  });
  const { renderSessionList, sessionListEl } = makeRenderer({ sessions, meetings: {} });
  renderSessionList();
  const html = treeHtml(sessionListEl);
  assert.ok(/sl-dot unread/.test(html), '休眠态有未读时应显示红色未读状态点');
  assert.ok(/有 3 条未读/.test(html), '休眠态应保留未读数量');
  assert.ok(/自动休眠/.test(html) && /点击唤醒/.test(html), 'tooltip 应说明自动休眠与唤醒动作');
});

console.log('Running unit-session-list-renderer-mini-ctx tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
