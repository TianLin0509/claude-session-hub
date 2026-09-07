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
function harness({ items = [], meetings = {}, active = null, store = new Map() } = {}) {
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
  });
  renderer.renderSessionList();
  const row = id => list.children.find(el => el.dataset.sessionId === id || el.dataset.meetingId === id);
  const section = id => {
    let name = '';
    for (const el of list.children) {
      if (/session-(sec|time-group)-header/.test(el.className)) name = el.innerHTML;
      if (el === row(id)) return name;
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

test('休眠群聊的未读标记不能被休眠状态压掉', () => {
  const h = harness({ items: [dormant('child', { meetingId: 'group' })], meetings: { group: meetingFixture(true) } });
  assert.match(h.row('group').className, /need-unread/);
  assert.match(h.row('group').innerHTML, /sl-state unread/);
  assert.match(h.row('group').innerHTML, /已答 1/);
  assert.match(h.section('group'), /已完成未读/);
});

test('新旧普通休眠与群聊进入同一休眠分区，默认展开且都有月牙', () => {
  const h = harness({ items: [dormant('new'), dormant('old', { lastMessageTime: now - 7 * 86400000 }),
    dormant('child', { meetingId: 'group' })], meetings: { group: meetingFixture() } });
  for (const id of ['new', 'old', 'group']) {
    assert.match(h.section(id), /休眠/);
    assert.match(h.row(id).innerHTML, /sl-moon/);
  }
  assert.equal(h.list.children.filter(el => el.dataset.timeGroup === 'dormant').length, 1);
});

test('折叠状态保存，重建后仍折叠；当前休眠会话自动展开', () => {
  const h = harness({ items: [dormant('sleep')] });
  const header = h.list.children.find(el => el.dataset.timeGroup === 'dormant');
  assert.ok(header, '缺少休眠分区');
  header.listeners.click();
  assert.equal(h.row('sleep'), undefined);
  const next = harness({ items: [dormant('sleep')], store: h.store });
  assert.equal(next.row('sleep'), undefined);
  const active = harness({ items: [dormant('sleep')], store: h.store, active: 'sleep' });
  assert.ok(active.row('sleep'));
});

test('超过三天的休眠未读、唤醒中和断连不会被休眠折叠藏起来', () => {
  const old = now - 7 * 86400000;
  const h = harness({ items: [dormant('read', { lastMessageTime: old, unreadCount: 2 }),
    dormant('pending', { lastMessageTime: old, _resumePending: true }),
    dormant('failed', { lastMessageTime: old, connectionIssue: { type: 'stream-disconnected', message: 'stream disconnected' } })] });
  assert.match(h.section('read'), /已完成未读/);
  assert.match(h.section('pending'), /运行中/);
  assert.match(h.row('pending').innerHTML, /唤醒中/);
  assert.match(h.section('failed'), /运行异常/);
});

test('置顶和置底休眠保留原有位置，家族过滤更新休眠计数', () => {
  const h = harness({ items: [dormant('pin', { pinned: true }), dormant('bottom', { bottomed: true }),
    dormant('codex'), dormant('claude', { kind: 'claude' })] });
  assert.doesNotMatch(h.section('pin'), /休眠/);
  assert.match(h.section('bottom'), /置底/);
  assert.equal(h.list.children.at(-1).dataset.sessionId, 'bottom');
  h.setFamilyFilter('claude');
  assert.ok(h.row('claude'));
  assert.equal(h.row('codex'), undefined);
  assert.match(h.list.children.find(el => el.dataset.timeGroup === 'dormant').innerHTML, /stg-count">1</);
});

test('群聊休眠保持成员入口，醒来后回到原有正常展示', () => {
  const group = meetingFixture();
  const h = harness({ items: [dormant('child', { meetingId: 'group', contextPct: 38 })], meetings: { group } });
  assert.match(h.row('group').innerHTML, /data-sub-id="child"/);
  assert.match(h.row('group').innerHTML, /Ctx 38%/);
  assert.equal(h.row('group').tabIndex, 0);
  group.status = 'idle';
  h.sessions.get('child').status = 'idle';
  h.renderSessionList();
  assert.doesNotMatch(h.row('group').className, /dormant/);
  assert.doesNotMatch(h.section('group'), /休眠/);
});
