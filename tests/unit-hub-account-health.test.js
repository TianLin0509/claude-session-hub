'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { accountHealth } = require('../core/hub-account-health');
const { combine } = require('../core/hub-account-activity');
const { healthView, imageServiceHtml } = require('../renderer/account-workspace-view');
const { HubAccounts } = require('../core/hub-accounts');
const { HubChrome } = require('../core/hub-chrome');
const H = 3600000, NOW = 100 * H;

test('the newer of proof and trouble wins; opening the page moves sync time but proves nothing', () => {
  const checked = { state: 'signed_in', checkedAt: NOW - 20 * H, verified: true };
  assert.equal(accountHealth({ site: checked, now: NOW }).state, 'ok');
  // A tool hit a login wall after the check: the person must sign in again.
  const wall = combine([{ identity: 'main', site: 'chatgpt', source: 'roundtable', outcome: 'login_required', at: NOW - 2 * H }])['main:chatgpt'];
  const bad = accountHealth({ site: checked, activity: wall, now: NOW });
  assert.equal(bad.state, 'attention'); assert.equal(bad.problem.kind, 'signed_out'); assert.equal(bad.problem.by, 'roundtable');
  // Opening it afterwards is use, not proof.
  const opened = combine([{ identity: 'main', site: 'chatgpt', source: 'roundtable', outcome: 'login_required', at: NOW - 2 * H },
    { identity: 'main', site: 'chatgpt', source: 'website', outcome: 'opened', at: NOW - H }])['main:chatgpt'];
  const still = accountHealth({ site: checked, activity: opened, now: NOW });
  assert.equal(still.state, 'attention'); assert.equal(still.syncedAt, NOW - H); assert.equal(still.syncedBy, 'opened');
  // A later successful image job proves the login again.
  const fixed = combine([...[{ identity: 'main', site: 'chatgpt', source: 'roundtable', outcome: 'login_required', at: NOW - 2 * H }],
    { identity: 'main', site: 'chatgpt', source: 'images', outcome: 'success', at: NOW - 0.5 * H, lastSuccessAt: NOW - 0.5 * H }])['main:chatgpt'];
  const ok = accountHealth({ site: checked, activity: fixed, now: NOW });
  assert.equal(ok.state, 'ok'); assert.equal(ok.syncedBy, 'images');
});
test('verification walls are a note about the tools, never a lost login or a badge', () => {
  const challenge = combine([{ identity: 'main', site: 'chatgpt', source: 'bridge', outcome: 'verification_required', at: NOW - H }])['main:chatgpt'];
  const seen = accountHealth({ site: { state: 'signed_in', source: 'cookie', checkedAt: NOW, verified: true }, activity: challenge, now: NOW });
  assert.equal(seen.state, 'ok', 'the login cookie is there: the person is fine');
  assert.equal(seen.automation.by, 'bridge', 'a cookie does not prove automation gets past the check');
  const paused = accountHealth({ paused: { at: NOW - 60000, until: NOW + H }, now: NOW });
  assert.equal(paused.state, 'unknown'); assert.equal(paused.automation.by, 'paused');
  assert.equal(accountHealth({ paused: { at: NOW - 2 * H, until: NOW - H }, now: NOW }).automation, undefined, 'an expired pause is over');
  const cookieGone = accountHealth({ site: { state: 'signed_out', source: 'cookie', checkedAt: NOW, verified: true },
    activity: combine([{ identity: 'main', site: 'chatgpt', source: 'images', outcome: 'success', at: NOW - 5 * H, lastSuccessAt: NOW - 5 * H }])['main:chatgpt'], now: NOW });
  assert.equal(cookieGone.state, 'attention'); assert.equal(cookieGone.problem.by, 'cookie');
  const restricted = { state: 'needs_attention', reason: 'headless_challenge', checkedAt: NOW - H, verified: true };
  assert.equal(accountHealth({ site: restricted, now: NOW }).state, 'unknown');
  // Network trouble or a rate limit says nothing about the login.
  for (const outcome of ['rate_limited', 'network_error', 'failed']) {
    assert.equal(accountHealth({ activity: combine([{ identity: 'main', site: 'kimi', source: 'roundtable', outcome, at: NOW }])['main:kimi'], now: NOW }).state, 'unknown');
  }
});
test('a site never seen signed in is just "not signed in" and raises no badge', () => {
  const never = accountHealth({ site: { state: 'signed_out', checkedAt: NOW - H, verified: true }, now: NOW });
  assert.equal(never.state, 'off');
  const lost = accountHealth({ site: { state: 'signed_out', checkedAt: NOW - H, verified: true },
    activity: combine([{ identity: 'main', site: 'qwen', source: 'roundtable', outcome: 'success', at: NOW - 30 * H }])['main:qwen'], now: NOW });
  assert.equal(lost.state, 'attention', 'it worked before and does not now: the login was lost');
});
test('row wording: one verdict, one source, and the matching button', () => {
  assert.deepEqual(healthView({ state: 'ok', syncedAt: NOW - 2 * H, syncedBy: 'images' }, NOW), { tone: 'ok', text: '正常 · 2 小时前同步', detail: '生图调用成功', action: 'open', button: '打开' });
  const login = healthView({ state: 'attention', problem: { kind: 'signed_out', by: 'check', at: NOW - 3 * H } }, NOW);
  assert.equal(login.text, 'AI 浏览器需要重新登录'); assert.equal(login.detail, '3 小时前 网页检查发现已退出登录'); assert.equal(login.button, '给 AI 登录'); assert.equal(login.action, 'login');
  const wall = healthView({ state: 'ok', syncedAt: NOW - H, syncedBy: 'cookie', automation: { by: 'roundtable', at: NOW - 6 * H } }, NOW);
  assert.equal(wall.text, '正常 · 1 小时前同步'); assert.equal(wall.detail, '6 小时前 网页圆桌遇到网站验证；你自己使用不受影响'); assert.equal(wall.button, '打开');
  assert.equal(healthView({ state: 'attention', problem: { kind: 'signed_out', by: 'cookie', at: NOW - H } }, NOW).detail, '1 小时前 本机登录记录已失效');
  assert.equal(healthView({ state: 'unknown' }, NOW).text, '未确认');
  const esc = s => String(s);
  // 必须在「现在」之后，否则文案会变成「下次有生图任务时」（2026-10-08 写死今天 14:30，过点后合并闸门全红）。
  const retryAt = new Date(2099, 9, 8, 14, 30).getTime();
  assert.match(imageServiceHtml({ codex: { ready: true, preferred: false }, web: [{ enabled: true, able: false, ready: false, retryAt }] }, esc),
    /网页优先、Codex 兜底 · 现在走 Codex（ChatGPT 网页被网站验证拦住，10\/8 14:30 后有生图任务时自动再试网页）/);
  assert.match(imageServiceHtml({ codex: { ready: true, preferred: false }, web: [{ enabled: true, able: true, ready: false }] }, esc), /现在走 ChatGPT 网页/,
    'an idle lane sleeps and wakes for work: it still serves');
  assert.match(imageServiceHtml({ codex: { ready: true, preferred: false }, web: [{ enabled: false, able: false }] }, esc), /现在走 Codex<\/p>/, 'switched-off lanes are not reported as blocked');
});

function setup(t, inspect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chrome = new HubChrome({ root, env: { CLAUDE_HUB_HOME_DIR: root } });
  chrome.running = async () => false; chrome.profileHeld = () => false; chrome.endpoint = async () => null;
  let now = NOW;
  const acc = new HubAccounts({ hubChrome: chrome, env: { CLAUDE_HUB_HOME_DIR: root }, getConfig: () => ({}), inspect, now: () => now });
  return { root, chrome, acc, clock: { get: () => now, set: v => { now = v; } } };
}
const row = (at, sites) => ({ sites: Object.fromEntries(sites.map(([k, state]) => [k, { state, checkedAt: at, live: true, verified: true }])) });
const fresh = (at, sites) => ({ identities: { main: row(at, sites), alt: row(at, [['chatgpt', 'signed_in']]) }, checkedAt: at });

test('background confirmation: everything twice a day, an account the person opened soon after', async t => {
  const checked = [];
  const { acc, chrome, clock } = setup(t, async ({ items, onResult }) => {
    checked.push(items.map(i => i.site));
    for (const item of items) await onResult(item, { state: item.site === 'kimi' ? 'signed_out' : 'signed_in', live: true, verified: true });
  });
  acc.auto = { tickMs: 60000, firstMs: 0, dueMs: 12 * H, retryMs: 30 * 60000, recheckAfterMs: 90000, recheckEveryMs: 5 * 60000, recheckForMs: H, badgeEveryMs: 0 };
  const badges = []; acc.onAttention = n => badges.push(n);
  const all = ['chatgpt', 'google', 'claude', 'doubao', 'deepseek', 'kimi', 'qwen'];
  acc.writeCache(fresh(NOW, all.map(k => [k, 'signed_in'])));
  clock.set(NOW + 2 * H); await acc.autoTick();
  assert.deepEqual(checked, [], 'confirmed two hours ago: nothing is due');
  clock.set(NOW + 11 * H); await acc.autoTick();
  assert.deepEqual(checked, []);
  clock.set(NOW + 13 * H); await acc.autoTick();
  assert.deepEqual(checked, [[...all, 'chatgpt']], 'half a day later every account is confirmed in one round');
  assert.equal(badges.at(-1), 1, 'kimi worked before and is signed out now: one badge');
  // The person opens kimi to sign in again; it is looked at again a little later.
  chrome.openWebsite = async () => ({ mode: 'shared' });
  await acc.open({ site: 'kimi' });
  clock.set(NOW + 13 * H + 30000); await acc.autoTick();
  assert.equal(checked.length, 1, 'not straight away');
  clock.set(NOW + 13 * H + 120000); await acc.autoTick();
  assert.deepEqual(checked.at(-1), ['kimi']);
  // A person's ordinary window holds the profile: nothing is read, the next tick tries again.
  clock.set(NOW + 13 * H + 10 * 60000); chrome.profileHeld = () => true;
  await acc.autoTick();
  assert.equal(checked.length, 2);
  chrome.profileHeld = () => false;
  await acc.autoTick();
  assert.equal(checked.length, 3);
  // After an hour the person is not waited for any longer.
  clock.set(NOW + 15 * H); await acc.autoTick();
  assert.equal(acc.rechecks.size, 0);
});
test('an isolated Hub without a fixture never starts a real website check', async t => {
  const { acc } = setup(t, async () => assert.fail('no real check in an isolated Hub'));
  acc.auto = { tickMs: 60000, firstMs: 0, dueMs: 0, retryMs: 0, recheckAfterMs: 0, recheckEveryMs: 0, recheckForMs: H, badgeEveryMs: 0 };
  acc.onAttention = () => {};
  await acc.autoTick({ real: false });
});
test('a tool asking for the browser closes an orphaned headless Chrome and starts a normal one', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-orphan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chrome = new HubChrome({ root, env: {}, proxy: '' }), calls = [];
  let ep = { port: 1, ws: 'old', headless: true };
  chrome.endpoint = async () => ep; chrome.workTabs = async () => 0; chrome.profileHeld = () => false;
  chrome.close = async () => { calls.push('close'); ep = null; };
  chrome.owners = async () => [];
  chrome.launch = async (_id, options) => { calls.push('launch:' + (options.headless ? 'headless' : 'normal')); ep = { port: 2, ws: 'new', headless: false }; };
  assert.equal((await chrome.ensure()).ws, 'new');
  assert.deepEqual(calls, ['close', 'launch:normal']);
});
test('rechecks stop after three inconclusive looks; pauses caused by the check itself raise no badge', async t => {
  const { acc, chrome, clock } = setup(t, async ({ items, onResult }) => {
    for (const item of items) await onResult(item, { state: 'needs_attention', reason: 'headless_challenge', live: true, verified: false });
  });
  acc.auto = { tickMs: 60000, firstMs: 0, dueMs: 1000 * H, retryMs: 30 * 60000, recheckAfterMs: 90000, recheckEveryMs: 5 * 60000, recheckForMs: H, badgeEveryMs: 0 };
  acc.onAttention = () => {};
  acc.writeCache(fresh(NOW, ['chatgpt', 'google', 'claude', 'doubao', 'deepseek', 'kimi', 'qwen'].map(k => [k, 'unknown'])));
  chrome.openWebsite = async () => ({ mode: 'shared' });
  await acc.open({ site: 'claude' });
  let checks = 0; const inspect = acc.inspect; acc.inspect = async o => { checks++; return inspect(o); };
  for (let m = 2; m <= 60; m++) { clock.set(NOW + m * 60000); await acc.autoTick(); }
  assert.equal(checks, 3, 'three looks, then the site is left alone');
  assert.equal(acc.rechecks.size, 0);
  assert.equal(accountHealth({ paused: { at: NOW, until: NOW + H, source: 'account-check' }, now: NOW }).state, 'unknown');
  const wall = accountHealth({ paused: { at: NOW, until: NOW + H, source: 'images-primary' }, now: NOW });
  assert.equal(wall.state, 'unknown', 'a tool meeting a site check is not a lost login');
  assert.equal(wall.automation.by, 'paused');
  assert.equal(accountHealth({ paused: { at: NOW, until: NOW + H, kind: 'safety_hold', source: 'safety-hold' }, now: NOW }).automation, undefined);
});
test('the routine check reads login cookies only and never opens a website', async t => {
  const { inspectCookies } = require('../core/hub-login-check');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cookie-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chrome = new HubChrome({ root, env: {}, proxy: '' }), results = [];
  chrome.endpoint = async () => ({ port: 1, ws: 'tools', headless: false });
  chrome.openTab = async () => assert.fail('no website may be opened');
  chrome.chatgptAccount = async () => assert.fail('no session endpoint may be fetched');
  chrome.liveCookieRows = async () => [{ host: '.chatgpt.com', name: '__Secure-next-auth.session-token.0', expiresAt: Date.now() + H }];
  await inspectCookies({ chrome, items: ['chatgpt', 'claude', 'kimi'].map(site => ({ identity: 'main', site })), signal: new AbortController().signal,
    onStage() {}, onResult: async (item, r) => results.push([item.site, r.state, r.source, r.live]) });
  assert.deepEqual(results, [['chatgpt', 'signed_in', 'cookie', false], ['claude', 'signed_out', 'cookie', false]], 'kimi keeps its login elsewhere: skipped, not guessed');
  chrome.endpoint = async () => null; chrome.profileHeld = () => true;
  await assert.rejects(inspectCookies({ chrome, items: [{ identity: 'main', site: 'chatgpt' }], signal: new AbortController().signal, onStage() {}, onResult() {} }), /普通窗口开着/);
});
test('a ChatGPT check loads one page and reads the session endpoint at most twice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gpt-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chrome = new HubChrome({ root, env: {}, proxy: '' });
  let opened = 0, sessionReads = 0, closed = 0;
  chrome.openTab = async () => { opened++; return { targetId: 'T' }; };
  chrome.closeTab = async () => { closed++; };
  chrome.page = async () => ({ close() {}, evaluate: async expr => {
    if (/api\/auth\/session/.test(expr)) { sessionReads++; return ''; }
    return { host: 'chatgpt.com', profile: true };
  } });
  const r = await chrome.chatgptCheck('main');
  assert.deepEqual(r, { state: 'signed_in', account: '' });
  assert.equal(opened, 1); assert.equal(sessionReads, 2); assert.equal(closed, 1);
});
test('a verification wall offers to help the AI past it from the row menu', () => {
  const { aiHtml } = require('../renderer/account-workspace-view');
  const esc = s => String(s);
  const state = { identities: [{ id: 'main', label: '主', sites: [{ key: 'chatgpt', name: 'ChatGPT', state: 'signed_in', checkedAt: NOW, verified: true,
    health: { state: 'ok', syncedAt: NOW, syncedBy: 'cookie', automation: { by: 'images', at: NOW - H } } }] }], preferences: { sites: {} } };
  const html = aiHtml(state, '', esc, NOW);
  assert.match(html, /data-ac="login"[^>]*>帮 AI 过网站验证</);
  assert.match(html, /生图遇到网站验证；你自己使用不受影响/);
});
