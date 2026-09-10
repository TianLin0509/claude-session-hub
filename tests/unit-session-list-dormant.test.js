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

test('归档不再挂载休眠行，置顶和新未读仍留在侧栏', () => {
  let opened;
  const h = harness({ items: [dormant('new'), dormant('old', { lastMessageTime: now - 8 * 86400000 }),
    dormant('pin', { pinned: true }), dormant('fresh', { unreadCount: 1 })], extra: { openSearch: o => { opened = o; } } });
  assert.equal(h.row('new'), undefined); assert.equal(h.row('old'), undefined);
  assert.match(h.section('pin'), /置顶/); assert.match(h.section('fresh'), /活跃/);
  const entry = h.list.children.find(e => e.className === 'session-archive-entry');
  assert.match(entry.innerHTML, /archive-count">2</);
  entry.listeners.click(); assert.deepEqual(opened, { scope: 'dormant' });
  assert.equal(h.list.children.filter(e => e.className.startsWith('session-sec-header')).length, 3);
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
test('休眠群聊未读进入活跃，成员归属和上下文保留，已读群聊只计归档', () => {
  const h = harness({ items: [dormant('child', { meetingId: 'group', contextPct: 38 })], meetings: { group: meetingFixture(true) } });
  assert.match(h.section('group'), /活跃/);
  assert.match(h.row('group').innerHTML, /sl-group-icon unread/);
  assert.doesNotMatch(h.row('group').innerHTML, /session-mini-jumps/);
  assert.match(h.row('child').className, /child/);
  assert.match(h.row('child').innerHTML, /Ctx 38%/);
  assert.doesNotMatch(h.row('group').innerHTML, /🌙|💬|📌/);
  const read = harness({ items: [dormant('child', { meetingId: 'group' })], meetings: { group: meetingFixture() } });
  assert.equal(read.row('group'), undefined);
});
test('活跃段全部已读只由动作按钮触发', () => {
  let calls = 0;
  const h = harness({ items: [dormant('fresh', { unreadCount: 1 })], extra: { markAllSessionsRead: () => calls++ } });
  const header = h.list.children.find(e => /sec-active/.test(e.className));
  const event = className => ({ target: { className }, preventDefault() {}, stopPropagation() {} });
  header.listeners.click(event('sl-title')); assert.equal(calls, 0);
  header.listeners.click(event('sec-mark-all-read')); assert.equal(calls, 1);
});
test('旧筛选和休眠展开偏好不会再隐藏会话或展开归档', () => {
  const h = harness({ items: [dormant('sleep'), { id: 'study', title: '学习', purpose: 'study-companion', kind: 'codex', status: 'idle', lastMessageTime: now }],
    store: new Map([['hubSessionFamilyFilter', 'claude'], ['hubSessionAgentGroups', '[]'], ['hubDormantGroupCollapsed', 'false']]) });
  assert.ok(h.row('study')); assert.equal(h.row('sleep'), undefined);
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
  assert.equal(h.row('normal'), undefined); assert.equal(h.row('group'), undefined); assert.ok(h.row('blocked'));
  assert.equal(calls.filter(c => c[0] === 'suspend-session').length, 3);
  assert.equal(calls.at(-1)[0], 'update-meeting-sync');
  assert.match(notices[0], /blocked.*native-session-id-missing/);
  assert.ok(calls.every(c => !/close|delete/.test(c[0])));
});
