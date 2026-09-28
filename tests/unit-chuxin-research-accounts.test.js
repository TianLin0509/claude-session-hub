'use strict';
// 2026-09-28 初心投研复用专属 Chrome：雪球、韭研公社、问财在这里登录，初心经本机接口取 cookie。
// 这里锁住三条边界：只导出投研站点、AI 网站登录永不导出、账号页有「投研数据」并能检查登录。
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { RESEARCH_SITES, externalSite, readExternalState, writeExternalState } = require('../core/external-accounts');
const { HubAccounts } = require('../core/hub-accounts');
const { HubChrome } = require('../core/hub-chrome');
const view = require('../renderer/account-workspace-view');

test('research sites are registered with their login cookie, AI sites are never exportable', () => {
  assert.deepEqual([...RESEARCH_SITES], ['xueqiu', 'jiuyan', 'iwencai']);
  for (const key of RESEARCH_SITES) {
    const site = externalSite(key);
    assert.match(site.url, /^https:\/\//);
    assert.ok(site.cookie && site.cookie.host && site.cookie.name instanceof RegExp);
  }
  for (const ai of ['chatgpt', 'claude', 'google', 'github', 'yuque']) assert.ok(!RESEARCH_SITES.includes(ai));
});

test('export refuses AI sites before touching the browser', async () => {
  const chrome = new HubChrome({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chrome-')) });
  chrome.lifecycle = () => { throw Error('must not start the browser'); };
  await assert.rejects(chrome.exportCookies('chatgpt'), /不允许导出/);
  await assert.rejects(chrome.exportCookies('claude'), /不允许导出/);
  const accounts = Object.create(HubAccounts.prototype);
  accounts.chrome = { exportCookies: () => { throw Error('must not be called'); } };
  await assert.rejects(accounts.exportResearchCookies('google'), /不允许导出/);
});

test('research check writes the cookie status; export records sign-in without leaking values', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-research-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = Object.create(HubAccounts.prototype);
  accounts.now = () => 1234;
  accounts.checking = null; accounts.startingCheck = null; accounts.setup = {};
  accounts.chrome = {
    root,
    siteCookieStatus: async () => ({ state: 'signed_in', message: '专属 Chrome 里已登录' }),
    exportCookies: async () => [{ name: 'SESSION', value: 'SECRET-VALUE', domain: '.jiuyangongshe.com' }],
  };
  const res = await accounts.external({ service: 'xueqiu', action: 'check' });
  assert.match(res.message, /雪球/);
  assert.equal(readExternalState(root).xueqiu.state, 'signed_in');
  const exported = await accounts.exportResearchCookies('jiuyan');
  assert.equal(exported.signedIn, true);
  assert.equal(exported.cookies[0].value, 'SECRET-VALUE');           // 值只交给调用方
  assert.ok(!fs.readFileSync(path.join(root, 'external-accounts.json'), 'utf8').includes('SECRET'));  // 不落盘
  assert.equal(readExternalState(root).jiuyan.state, 'signed_in');
});

test('account page has an investment-research tab with login and check buttons', () => {
  assert.ok(view.TABS.some(tab => tab.id === 'research' && tab.name === '投研数据'));
  const data = { services: [{ id: 'xueqiu', name: '雪球', website: true, canCheck: true, status: 'pending', consumers: [],
    nativeStatus: { state: 'signed_out', message: '专属 Chrome 里还没登录', checkedAt: Date.now() - 60000 } }] };
  const html = view.servicesHtml(data, 'research', '', {}, s => String(s));
  assert.match(html, /data-operation="open">登录 ↗/);
  assert.match(html, /data-operation="check">检查登录/);
  assert.match(html, /未登录/);
});

test('hook server gates the research routes behind the Hub token', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('if (isResearchAccount) {'), main.indexOf('if (isNativeOwnership) {'));
  assert.match(block, /parsed\.token !== HOOK_TOKEN/);
  assert.match(block, /exportResearchCookies/);
  assert.match(main, /'\/api\/accounts\/research-open', '\/api\/accounts\/research-cookies'/);
});

test('writeExternalState keeps research status alongside GitHub', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-research-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeExternalState(root, 'github', { state: 'signed_in', account: 'u', checkedAt: 1 });
  writeExternalState(root, 'iwencai', { state: 'signed_out', message: '专属 Chrome 里还没登录', checkedAt: 2 });
  const state = readExternalState(root);
  assert.equal(state.github.state, 'signed_in');
  assert.equal(state.iwencai.message, '专属 Chrome 里还没登录');
  assert.equal(state.github.message, undefined);
});
