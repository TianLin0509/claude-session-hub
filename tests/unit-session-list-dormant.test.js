'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionListRenderer } = require('../renderer/session-list-renderer');

function element() {
  return {
    children: [], dataset: {}, style: { setProperty() {} }, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); },
    set innerHTML(html) { this.html = html; this.children = []; },
    get innerHTML() { return this.html || ''; },
  };
}
function harness({ items = [], meetings = {}, active = null, store = new Map(), extra = {} } = {}) {
  const list = element();
  const sessions = new Map(items.map(s => [s.id, s]));
  const renderer = createSessionListRenderer({
    document: { createElement: element, getElementById: () => null, head: element() },
    localStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    sessionListEl: list, getSessions: () => sessions, getMeetings: () => meetings,
    getActiveSessionId: () => active, getActiveMeetingId: () => active,
    isAiKind: () => true, modelShort: () => '', modelClass: () => '',
    escapeHtml: v => String(v || ''), formatTime: () => '6 小时前', pctClass: () => 'ok',
    selectSession() {}, selectMeeting() {}, openContextMenu() {},
    ...extra,
  });
  renderer.renderSessionList();
  const descendants = el => [el, ...el.children.flatMap(descendants)];
  const row = id => descendants(list).find(el => el.dataset.sessionId === id || el.dataset.meetingId === id);
  const section = id => {
    let name = '';
    for (const el of list.children) {
      if (/session-(sec|time-group)-header/.test(el.className)) name = el.innerHTML;
      if (descendants(el).includes(row(id))) return name;
    }
    return null;
  };
  return { ...renderer, list, row, section, sessions, store };
}
const now = Date.now();
const dormant = (id, extra = {}) => ({ id, title: id, kind: 'codex', status: 'dormant', lastMessageTime: now, ...extra });
function meetingFixture(unread = false) {
  return { id: 'group', title: '休眠群聊', groupChat: true, status: 'dormant', subSessions: ['child'],
    participants: [0], lastMessageTime: now, unreadAnswered: new Set(unread ? ['child'] : []) };
}

test('最近休眠挂载到独立分组，旧休眠保留归档入口，置顶和未读保持优先', () => {
  let opened;
  const h = harness({ items: [dormant('new'), dormant('old', { lastMessageTime: now - 8 * 86400000 }),
    dormant('pin', { pinned: true }), dormant('fresh', { unreadCount: 1 })], extra: { openSearch: o => { opened = o; } } });
  assert.match(h.section('new'), /休眠/); assert.equal(h.row('old'), undefined);
  assert.match(h.section('pin'), /置顶/); assert.match(h.section('fresh'), /活跃/);
  const entry = h.list.children.find(e => e.className === 'session-archive-entry');
  assert.match(entry.innerHTML, /archive-count">2</);
  entry.listeners.click(); assert.deepEqual(opened, { scope: 'dormant' });
  assert.equal(h.list.children.filter(e => e.className.startsWith('session-sec-header')).length, 4);
});
test('旧休眠未读归档，唤醒与异常在活跃，新未读点为蓝色', () => {
  const h = harness({ items: [dormant('old', { unreadCount: 1, lastMessageTime: now - 8 * 86400000 }),
    dormant('wake', { _resumePending: true }), dormant('fresh', { unreadCount: 1 }),
    dormant('error', { connectionIssue: { type: 'stream-disconnected', message: 'lost' } })] });
  assert.equal(h.row('old'), undefined);
  for (const id of ['wake', 'fresh', 'error']) { assert.match(h.section(id), /活跃/); assert.equal(h.row(id).tabIndex, 0); }
  assert.match(h.row('fresh').innerHTML, /sl-dot unread/);
  assert.match(h.row('wake').innerHTML, /sl-dot start/);
  assert.match(h.row('error').innerHTML, /sl-dot error/);
});
test('休眠群聊未读进入活跃，已读进入休眠，成员归属和上下文保留', () => {
  const h = harness({ items: [dormant('child', { meetingId: 'group', contextPct: 38 })], meetings: { group: meetingFixture(true) } });
  assert.match(h.section('group'), /活跃/);
  assert.match(h.row('group').innerHTML, /sl-group-icon unread/);
  assert.doesNotMatch(h.row('group').innerHTML, /session-mini-jumps/);
  assert.match(h.row('child').className, /child/);
  assert.match(h.row('child').innerHTML, /Ctx 38%/);
  assert.doesNotMatch(h.row('group').innerHTML, /🌙|💬|📌/);
  const read = harness({ items: [dormant('child', { meetingId: 'group' })], meetings: { group: meetingFixture() } });
  assert.match(read.section('group'), /休眠/);
});
test('活跃段全部已读只由动作按钮触发', () => {
  let calls = 0;
  const h = harness({ items: [dormant('fresh', { unreadCount: 1 })], extra: { markAllSessionsRead: () => calls++ } });
  const header = h.list.children.find(e => /sec-active/.test(e.className));
  const event = className => ({ target: { className }, preventDefault() {}, stopPropagation() {} });
  header.listeners.click(event('sl-title')); assert.equal(calls, 0);
  header.listeners.click(event('sec-mark-all-read')); assert.equal(calls, 1);
});
test('已废弃筛选偏好不影响新控件的默认显示', () => {
  const h = harness({ items: [dormant('sleep'), { id: 'study', title: '学习', purpose: 'study-companion', kind: 'codex', status: 'idle', lastMessageTime: now }],
    store: new Map([['hubSessionFamilyFilter', 'claude'], ['hubSessionAgentGroups', '[]'], ['hubDormantGroupCollapsed', 'false']]) });
  assert.ok(h.row('study')); assert.ok(h.row('sleep'));
});

test('归档全部走休眠 IPC，群聊成员成功后才保存休眠，拒绝时显示失败原因', async () => {
  const calls = [], notices = [];
  const group = { ...meetingFixture(), status: 'idle' };
  const h = harness({ items: [{ ...dormant('normal'), status: 'idle' }, { ...dormant('blocked'), status: 'idle' },
    { ...dormant('child', { meetingId: 'group' }), status: 'idle' }], meetings: { group }, extra: {
      notify: message => notices.push(message),
      ipcRenderer: { async invoke(channel, payload) {
        calls.push([channel, payload]);
        if (channel === 'update-meeting-sync') { group.status = 'dormant'; return true; }
        if (payload.sessionId === 'blocked') return { ok: false, error: 'native-session-id-missing' };
        h.sessions.get(payload.sessionId).status = 'dormant'; return { ok: true };
      } },
    } });
  const header = h.list.children.find(e => /sec-today/.test(e.className));
  await header.listeners.click({ target: { className: 'sec-action' }, preventDefault() {}, stopPropagation() {} });
  assert.match(h.section('normal'), /休眠/); assert.match(h.section('group'), /休眠/); assert.match(h.section('blocked'), /今天/);
  assert.equal(calls.filter(c => c[0] === 'suspend-session').length, 3);
  assert.equal(calls.at(-1)[0], 'update-meeting-sync');
  assert.match(notices[0], /blocked.*native-session-id-missing/);
  assert.ok(calls.every(c => !/close|delete/.test(c[0])));
});

test('休眠时间范围为回溯窗口，包含群聊，切换后持久化', () => {
  const day = 86400000;
  const h = harness({ items: [dormant('recent'), dormant('two', { lastMessageTime: now - 2 * day }),
    dormant('six', { lastMessageTime: now - 6 * day }), dormant('eight', { lastMessageTime: now - 8 * day })] });
  const range = () => h.list.children.find(e => /sec-dormant/.test(e.className)).children[0];
  assert.ok(h.row('recent')); assert.equal(h.row('two'), undefined);
  range().value = '3'; range().listeners.change();
  assert.ok(h.row('two')); assert.equal(h.row('six'), undefined);
  range().value = '7'; range().listeners.change();
  assert.ok(h.row('six')); assert.equal(h.row('eight'), undefined);
  assert.equal(h.store.get('hubSidebarDormantDays'), '7');
});

test('四个组头可独立折叠，动作不误触发，重新创建保留选择', () => {
  const items = [dormant('sleep'), dormant('pin', { pinned: true }), dormant('unread', { unreadCount: 1 }),
    dormant('today', { status: 'idle' })];
  const h = harness({ items });
  const toggle = cls => h.list.children.find(e => e.className.includes(cls)).listeners.click({ target: { className: 'sec-collapse' }, preventDefault() {}, stopPropagation() {} });
  for (const [cls, id] of [['sec-pinned','pin'], ['sec-active','unread'], ['sec-today','today'], ['sec-dormant','sleep']]) {
    assert.ok(h.row(id)); toggle(cls); assert.equal(h.row(id), undefined);
  }
  const restored = harness({ items, store: h.store });
  assert.equal(restored.row('pin'), undefined);
  restored.revealSearchItem('pin'); assert.ok(restored.row('pin'));
  assert.equal(restored.row('sleep'), undefined);
});

test('模型过滤普通行及群聊成员，打开被过滤会话会恢复入口', () => {
  const control = element();
  const store = new Map();
  const h = harness({ items: [dormant('claude', { kind: 'claude' }), dormant('codex'),
    dormant('other', { kind: 'deepseek' }), dormant('member-c', { kind: 'claude', meetingId: 'mixed' }),
    dormant('member-x', { meetingId: 'mixed' })],
    meetings: { mixed: { ...meetingFixture(), id: 'mixed', subSessions: ['member-c', 'member-x'] } }, store,
    extra: { document: { createElement: element, getElementById: id => id === 'session-model-filter' ? control : null } } });
  control.value = 'claude'; control.listeners.change();
  assert.ok(h.row('claude')); assert.equal(h.row('codex'), undefined);
  assert.ok(h.row('mixed')); assert.ok(h.row('member-c')); assert.equal(h.row('member-x'), undefined);
  h.revealSearchItem('mixed', 'member-x');
  assert.equal(control.value, 'all'); assert.ok(h.row('member-x'));
  control.value = 'other'; control.listeners.change();
  assert.ok(h.row('other')); assert.equal(h.row('mixed'), undefined);
  h.revealSearchItem('codex');
  assert.equal(control.value, 'all'); assert.ok(h.row('codex'));
});
