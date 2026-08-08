'use strict';
// 2026-05-31 道雪：群聊侧栏 mini-jump 加 Ctx% 改动配套测试。
//
// 改动：renderer/session-list-renderer.js 的 miniJumpsHtml 在 isGroupChat=true 且
//   sub.contextPct 是 number 时，按钮右侧贴 <span class="mini-jump-ctx ${pctClass}">N%</span>；
//   null 时不渲染。配色复用 pctClass(ok/warn/danger)，并 wrap 在 .mini-jump-cell 内。
//
// 测试方式：session-list-renderer 暴露 createSessionListRenderer 工厂，可直接 require + mock
//   DOM/getSessions/getMeetings 跑 renderSessionList，断言 innerHTML 内字面量。

const assert = require('assert');
const path = require('path');

const { createSessionListRenderer } = require(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'));

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
test('群聊 sub 有 contextPct 时 mini-jump 右侧渲染 Ctx% 小标签', () => {
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
  const html = sessionListEl.children.map(c => c.innerHTML || '').join('\n');
  assert.ok(/mini-jump-cell/.test(html), 'mini-jump 必须 wrap 在 .mini-jump-cell 容器内');
  assert.ok(/sl-members-hint/.test(html), '群聊父项行2 末尾必须显示成员摘要（已选数），折叠时也能看懂层级');
  assert.ok(/2\/3 已选/.test(html), '父项摘要必须显示已选成员数');
  assert.ok(/mini-jump-ctx ok[^>]*>22%/.test(html), 'sub-a (22%) 应渲染 mini-jump-ctx ok 22%');
  assert.ok(/mini-jump-ctx danger[^>]*>88%/.test(html), 'sub-b (88%) 应渲染 danger 配色');
  assert.ok(/mini-jump-ctx warn[^>]*>55%/.test(html), 'sub-c (55%) 应渲染 warn 配色');
});

// ---------------- 用例 2：contextPct=null 时不渲染数字（避免占位） ----------------
test('群聊 sub.contextPct=null 时不渲染 mini-jump-ctx', () => {
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
  const html = sessionListEl.children.map(c => c.innerHTML || '').join('\n');
  assert.ok(/mini-jump-cell/.test(html), 'cell 容器仍应存在（保持 layout 一致）');
  assert.ok(!/mini-jump-ctx/.test(html), 'contextPct=null 时不应渲染 .mini-jump-ctx 节点');
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
  const html = sessionListEl.children.map(c => c.innerHTML || '').join('\n');
  assert.ok(!/mini-jump-ctx/.test(html), '非群聊 meeting 不应渲染 mini-jump-ctx（slot 头像是 Pokemon，Ctx 语义对应不上）');
});

// ---------------- 用例 4：unreadAnsweredSize > 0 时 badge 显示"⏸ 等你 N" ----------------
test('meeting.unreadAnswered 有 N 个 sid 时侧栏显示 "⏸ 等你 N"', () => {
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
  const html = sessionListEl.children.map(c => c.innerHTML || '').join('\n');
  assert.ok(/sl-state unread[^>]*>等你 2</.test(html), 'sl-state 必须显示"等你 2"反映本轮已答 AI 数（方案C 两行卡）');
});

// ---------------- 用例 5：active 时不显示 badge（即便 unreadAnswered 非空） ----------------
test('meeting 当前 active 时不显示 unread badge', () => {
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
  const html = sessionListEl.children.map(c => c.innerHTML || '').join('\n');
  assert.ok(!/sl-state unread/.test(html), 'active meeting 不应显示等你状态（用户正看着，不打扰）');
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
  const html = sessionListEl.children.map(c => c.innerHTML || '').join('\n');
  assert.ok(/sl-ring-dot unread/.test(html), '休眠态有未读时应显示红色未读状态点');
  assert.ok(/sl-un[^>]*>● 3</.test(html), '休眠态应保留未读数量');
  assert.ok(/自动休眠/.test(html) && /点击唤醒/.test(html), 'tooltip 应说明自动休眠与唤醒动作');
});

console.log('Running unit-session-list-renderer-mini-ctx tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
