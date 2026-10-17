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
let resourceUsage = { cpuPct: 23.4, gpu: { name:'RTX 3080',usagePct:37 }, memoryPct: 67.8, disk: { root: 'C:\\', usagePct: 89, totalBytes: 1000 * 1024 ** 3 } };
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
assert.match(stripEl.innerHTML, /GPU<b>37%<\/b>/);
assert.ok(stripEl.innerHTML.indexOf('CPU<b>') < stripEl.innerHTML.indexOf('GPU<b>'));
assert.ok(stripEl.innerHTML.indexOf('GPU<b>') < stripEl.innerHTML.indexOf('内存<b>'));
assert.match(stripEl.innerHTML, /内存<b>68%<\/b>/);
assert.match(stripEl.innerHTML, /硬盘<b>89%<\/b>/);
assert.match(stripEl.innerHTML, /C:\\ 已用 89%/);
assert.ok(!stripEl.innerHTML.includes('等你'));
assert.ok(!stripEl.innerHTML.includes('ctx'));
assert.ok(!stripEl.innerHTML.includes('%/h'));
assert.strictEqual(stripEl.title, '');

resourceUsage = { cpuPct: 91, memoryPct: 86 };
renderer.renderSidebarStrip();
assert.strictEqual((stripEl.innerHTML.match(/strip-resource-high/g) || []).length, 2);
assert.match(stripEl.innerHTML, /GPU<b>—<\/b>/);
assert.strictEqual((stripEl.innerHTML.match(/strip-resource-critical/g) || []).length, 1);
resourceUsage = { cpuPct: 89, memoryPct: 90, disk: { usagePct: 100 } };
renderer.renderSidebarStrip();
assert.strictEqual((stripEl.innerHTML.match(/strip-resource-critical/g) || []).length, 2);

proxyInfo = { proxy: 'http://127.0.0.1:9', clashDelay: { status: 'ok', delayMs: 150, nodeName: '节点 A', measuredAt: Date.now() }, egress: {
  foreign: { ok: true, ip: '203.0.113.10', countryZh: '美国', cityZh: '洛杉矶', locationLabel: '美国·洛杉矶' },
  domestic: { ok: true, countryZh: '中国', cityZh: '北京' },
} };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /美国 洛杉矶/);
assert.match(stripEl.innerHTML, /150 ms/);
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
// 公司电脑（2026-10-17，Q-1017-20）：Hub 没配代理，系统设置里有办公代理，出口探测走它；xGate（SPES5）开着。
proxyInfo = { proxy: '', egress: { proxySource: 'system', proxyEndpoint: 'http://proxy.corp:8080', tunnel: { xgate: false },
  foreign: { ok: true, countryZh: '新加坡', cityZh: '新加坡', locationLabel: '新加坡' }, domestic: { ok: false } } };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /<span>代理<\/span>/, '系统代理按「代理」显示，不再是「直连」');
assert.match(stripEl.innerHTML, /新加坡/);
assert.doesNotMatch(stripEl.innerHTML, /出口未知/);
assert.match(stripEl.innerHTML, /系统代理：/);
proxyInfo.egress.tunnel = { xgate: true };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /<span>xGate<\/span>/);
assert.match(stripEl.innerHTML, /xGate（华为安全终端 SPES5）正在运行/);
// 本机 IP：网速右边显示首选那个，悬停列出全部
resourceUsage = { network: { status: 'ok', downloadBps: 2048, uploadBps: 1024, windowMs: 2000, adapters: ['以太网'], ips: [{ name: '以太网', address: '10.12.34.56' }, { name: 'WLAN', address: '192.168.1.5' }] } };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /class="strip-ip"[^>]*>10\.12\.34\.56<\/span>/);
assert.match(stripEl.innerHTML, /WLAN：192\.168\.1\.5/);
resourceUsage = {};
renderer.renderSidebarStrip();
assert.doesNotMatch(stripEl.innerHTML, /strip-ip/, '取不到 IP 时不显示');
assert.match(stripEl.innerHTML, /CPU<b>—<\/b>/);
assert.match(stripEl.innerHTML, /内存<b>—<\/b>/);
assert.doesNotMatch(stripEl.innerHTML, /strip-resource-critical/);
console.log('unit-sidebar-strip-resources OK');
