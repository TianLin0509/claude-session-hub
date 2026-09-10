'use strict';

const assert = require('assert');
const { createSessionListRenderer } = require('../renderer/session-list-renderer.js');

function makeEl() {
  return {
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(value) { this._html = value; this.children = []; },
    get innerHTML() { return this._html || ''; },
    set scrollTop(value) { this._scrollTop = value; },
    get scrollTop() { return this._scrollTop || 0; },
  };
}

const stripEl = makeEl();
const sessionListEl = makeEl();
const sessions = new Map([
  ['live-idle', { id: 'live-idle', status: 'idle' }],
  ['live-running', { id: 'live-running', status: 'running' }],
  ['hidden-meeting-child', { id: 'hidden-meeting-child', status: 'idle', meetingId: 'm1' }],
  ['hidden-research', { id: 'hidden-research', status: 'idle', purpose: 'chuxin-research' }],
  ['history', { id: 'history', status: 'dormant' }],
]);
let resourceUsage = { cpuPct: 23.4, memoryPct: 67.8 };
let proxyInfo = null;

const document = {
  createElement: () => makeEl(),
  getElementById: id => id === 'sidebar-strip' ? stripEl : null,
  head: makeEl(),
  documentElement: makeEl(),
};

const renderer = createSessionListRenderer({
  document,
  localStorage: { getItem: () => '[]', setItem() {} },
  sessionListEl,
  getSessions: () => sessions,
  getMeetings: () => ({}),
  getActiveSessionId: () => null,
  getActiveMeetingId: () => null,
  isAiKind: () => true,
  modelShort: () => '',
  modelClass: () => '',
  escapeHtml: value => String(value || ''),
  formatTime: () => '',
  pctClass: () => '',
  getResourceUsage: () => resourceUsage,
  getProxyInfo: () => proxyInfo,
  selectSession() {},
  selectMeeting() {},
  openContextMenu() {},
});

renderer.renderSidebarStrip();
assert.doesNotMatch(stripEl.innerHTML, /活跃|strip-active/);
assert.equal((stripEl.innerHTML.match(/strip-route-dot/g) || []).length, 2);
assert.match(stripEl.innerHTML, /title="CPU 23%"/);
assert.match(stripEl.innerHTML, /width:23%/);
assert.match(stripEl.innerHTML, /title="内存 68%"/);
assert.match(stripEl.innerHTML, /width:68%/);
assert.match(stripEl.innerHTML, /CPU<b>23%<\/b>/);
assert.match(stripEl.innerHTML, /内存<b>68%<\/b>/);
assert.ok(!stripEl.innerHTML.includes('等你'));
assert.ok(!stripEl.innerHTML.includes('ctx'));
assert.ok(!stripEl.innerHTML.includes('%/h'));
assert.strictEqual(stripEl.title, '');

resourceUsage = { cpuPct: 91, memoryPct: 86 };
renderer.renderSidebarStrip();
assert.strictEqual((stripEl.innerHTML.match(/strip-resource-high/g) || []).length, 2);

proxyInfo = { proxy: 'http://127.0.0.1:9', egress: {
  foreign: { ok: true, ip: '203.0.113.10', countryZh: '美国', cityZh: '洛杉矶', locationLabel: '美国·洛杉矶' },
  domestic: { ok: true, countryZh: '中国', cityZh: '北京' },
} };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /美国 洛杉矶/);
assert.match(stripEl.innerHTML, /国内正常/);
assert.doesNotMatch(stripEl.innerHTML, /203\.0\.113\.10/);
proxyInfo.egress.foreign.cityZh = '';
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /美国 城市未知/);
proxyInfo.egress.foreign.ok = false;
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /出口未知/);
proxyInfo.proxy = '';
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /直连/);
assert.match(stripEl.innerHTML, /中国 北京/);
resourceUsage = {};
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /CPU<b>—<\/b>/);
assert.match(stripEl.innerHTML, /内存<b>—<\/b>/);
console.log('unit-sidebar-strip-resources OK');
