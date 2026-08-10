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
  selectSession() {},
  selectMeeting() {},
  openContextMenu() {},
});

renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /<b>4<\/b> 活跃/);
assert.match(stripEl.innerHTML, /CPU <b>23%<\/b>/);
assert.match(stripEl.innerHTML, /· M <b>68%<\/b>/);
assert.ok(!stripEl.innerHTML.includes('等你'));
assert.ok(!stripEl.innerHTML.includes('ctx'));
assert.ok(!stripEl.innerHTML.includes('%/h'));
assert.strictEqual(stripEl.title, '');

resourceUsage = { cpuPct: 91, memoryPct: 86 };
renderer.renderSidebarStrip();
assert.strictEqual((stripEl.innerHTML.match(/strip-resource-high/g) || []).length, 2);

console.log('unit-sidebar-strip-resources OK');
