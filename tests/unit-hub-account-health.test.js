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
test('verification walls and paused sites need the person; a check blocked by a challenge does not', () => {
  const challenge = combine([{ identity: 'main', site: 'chatgpt', source: 'bridge', outcome: 'verification_required', at: NOW - H }])['main:chatgpt'];
  assert.equal(accountHealth({ activity: challenge, now: NOW }).problem.kind, 'verification');
  const paused = accountHealth({ paused: { at: NOW - 60000, until: NOW + H }, now: NOW });
  assert.equal(paused.state, 'attention'); assert.equal(paused.problem.by, 'paused');
  assert.equal(accountHealth({ paused: { at: NOW - 2 * H, until: NOW - H }, now: NOW }).state, 'unknown', 'an expired pause is over');
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
  assert.equal(login.text, '需要重新登录'); assert.equal(login.detail, '3 小时前 后台检查发现已退出登录'); assert.equal(login.button, '去登录'); assert.equal(login.action, 'login');
  const verify = healthView({ state: 'attention', problem: { kind: 'verification', by: 'roundtable', at: NOW - 6 * H } }, NOW);
  assert.equal(verify.text, '需要人机验证'); assert.equal(verify.detail, '6 小时前 网页圆桌遇到人机验证'); assert.equal(verify.button, '去验证');
  assert.equal(healthView({ state: 'unknown' }, NOW).text, '未确认');
  const esc = s => String(s);
  assert.match(imageServiceHtml({ codex: { ready: true, preferred: false }, web: [{ ready: false }] }, esc), /网页优先、Codex 兜底 · 现在走 Codex（网页账号暂不可用）/);
  assert.match(imageServiceHtml({ codex: { ready: true, preferred: false }, web: [{ ready: true }] }, esc), /现在走 ChatGPT 网页/);
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
