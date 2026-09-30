'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { HubAccounts } = require('../core/hub-accounts');
const { HubChrome } = require('../core/hub-chrome');
const { HubAccountBrowser } = require('../core/hub-account-browser');
const { inspectAccounts } = require('../core/hub-login-check');
const { readPreferences, updatePreferences } = require('../core/hub-account-preferences');
const { companyCards } = require('../renderer/account-center-view');
const { registerHubAccountsIpc } = require('../main/ipc/hub-accounts-handlers');
const { acquire } = require('../core/web-roundtable/store');
function setup(t, inspect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chrome = new HubChrome({ root, env: { CLAUDE_HUB_HOME_DIR: root } });
  chrome.running = async () => false; chrome.profileHeld = () => false;
  const acc = new HubAccounts({ hubChrome: chrome, env: { CLAUDE_HUB_HOME_DIR: root }, getConfig: () => ({}), inspect });
  return { root, chrome, acc };
}
test('all companies can independently choose two accounts; browser profiles are not copied', async t => {
  const { root, acc, chrome } = setup(t);
  await acc.preference({ site: 'claude', identity: 'alt', add: true });
  await acc.preference({ site: 'claude', identity: 'alt' });
  let opened;
  chrome.openWebsite = async (...args) => { opened = args; };
  await acc.open({ site: 'claude' });
  assert.deepEqual(opened, ['alt', 'claude']);
  assert.equal(readPreferences(root).sites.google.preferred, 'main');
  assert.equal(fs.existsSync(path.join(root, 'alt')), false, 'preferences do not create or copy a profile');
  assert.throws(() => updatePreferences(root, { site: 'google', identity: 'alt' }), /先添加/);
  assert.throws(() => updatePreferences(root, { site: '__proto__', identity: 'main' }), /无效/);
});
test('progress is available mid-check, clicks coalesce, cancellation keeps completed results', async t => {
  let release, entered;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  let calls = 0;
  const { acc } = setup(t, async ({ items, signal, onStage, onResult }) => {
    calls++;
    onStage(items[0], '正在确认官网账号');
    await onResult(items[0], { state: 'signed_in', account: 'first@example.com', live: true });
    entered(); await gate;
    assert.equal(signal.aborted, true);
  });
  await Promise.all([acc.startCheck(), acc.startCheck()]); await started;
  const progress = await acc.state();
  assert.equal(calls, 1); assert.equal(progress.progress.done, 1); assert.equal(progress.progress.status, 'running');
  progress.progress.done = 99;
  assert.equal((await acc.state()).progress.done, 1, 'public state is detached');
  await assert.rejects(acc.open({ site: 'chatgpt' }), /等待检查/);
  acc.cancelCheck(); release(); await acc.checking;
  const final = await acc.state();
  assert.equal(final.progress.status, 'cancelled'); assert.equal(final.progress.done, 1);
  assert.equal(acc.readCache().identities.main.sites.chatgpt.account, 'first@example.com');
});
test('inspection failure has a visible terminal state and does not overwrite old proof', async t => {
  const { acc } = setup(t, async () => { throw Error('browser busy'); });
  acc.writeCache({ identities: { main: { sites: { kimi: { state: 'signed_in', checkedAt: 123, verified: true } } } } });
  const state = await acc.check();
  assert.equal(state.progress.status, 'failed'); assert.equal(state.progress.error, 'browser busy');
  assert.equal(acc.readCache().identities.main.sites.kimi.checkedAt, 123);
});

test('an inconclusive check retains the last known email as historical, without releasing tasks', async t => {
  let outcome = { state: 'unknown', error: '页面未就绪', live: true, verified: false };
  const { acc } = setup(t, async ({ items, onResult }) => { await onResult(items[0], outcome); });
  acc.writeCache({ identities: { main: { account: 'known@example.com', sites: {} } } });
  const resumed = []; acc.recovery = { resume: async r => resumed.push(r) };
  const state = await acc.check({ identity: 'main', site: 'chatgpt' });
  assert.equal(state.identities[0].account, 'known@example.com');
  assert.equal(state.identities[0].accountStale, true);
  assert.equal(state.identities[0].sites[0].state, 'unknown');
  assert.deepEqual(resumed, []);
  assert.equal(acc.readCache().identities.main.account, 'known@example.com');
  outcome = { state: 'signed_out', live: true, verified: true };
  assert.equal((await acc.check({ identity: 'main', site: 'chatgpt' })).identities[0].account, '');
});
test('corrupt preferences and cache are reported, never silently overwritten', async t => {
  const { root, acc } = setup(t);
  fs.writeFileSync(path.join(root, 'accounts.json'), '{');
  await assert.rejects(acc.state(), /账号设置无法读取/);
  assert.equal(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8'), '{');
  fs.writeFileSync(path.join(root, 'accounts.json'), '{}');
  fs.writeFileSync(acc.cacheFile(), '{');
  await assert.rejects(acc.state(), /检查记录无法读取/);
});
test('busy shared Chrome and another Hub check cannot be hijacked', async t => {
  const { chrome } = setup(t);
  chrome.running = async () => true;
  const options = { chrome, items: [{ identity: 'main', site: 'chatgpt' }], signal: new AbortController().signal, onStage() {}, onResult() {} };
  await assert.rejects(inspectAccounts(options), /正在使用中/);
  const release = acquire('account-check', path.join(chrome.root, 'locks'));
  try { await assert.rejects(inspectAccounts(options), /另一个 Hub/); }
  finally { release(); }
});
test('company presentation never borrows another website identity; queued checks are neutral', async t => {
  const { acc } = setup(t);
  const state = await acc.state();
  state.identities[0].account = 'chatgpt-only@example.com';
  state.progress = { status: 'running', items: [{ identity: 'main', site: 'claude', state: 'queued' }] };
  const cards = companyCards(state);
  assert.equal(cards.length, 7);
  const claude = cards.find(c => c.site === 'claude').accounts[0];
  assert.equal(claude.account, '账号待确认'); assert.equal(claude.tone, 'idle');
  assert.equal(cards.find(c => c.site === 'chatgpt').accounts[0].account, 'chatgpt-only@example.com');
});
test('new IPC validates selection before mutation and legacy web adapters use the shared service', async t => {
  const { acc, root } = setup(t);
  const handlers = {};
  registerHubAccountsIpc({ handle: (id, fn) => { handlers[id] = fn; } }, acc);
  assert.equal((await handlers['hub-accounts:open']({}, { site: 'file:///private' })).ok, false);
  assert.equal((await handlers['hub-accounts:preference']({}, { site: 'chatgpt', identity: '../' })).ok, false);
  let opened;
  const browser = new HubAccountBrowser({ dataDir: root, accounts: { open: async x => { opened = x; } } });
  await browser.open('gemini'); assert.deepEqual(opened, { site: 'google', identity: 'main' });
  assert.equal(new HubAccountBrowser({ dataDir: root, env: {} }).accounts.chrome.root, path.join(root, 'hub-chrome'));
});
test('failed persistence still closes the exact inspection browser and releases ownership', async t => {
  const { chrome } = setup(t);
  let closed = 0, stage;
  const inspector = { ensure: async () => ({ ws: 'owned', headless: true }), endpoint: async () => ({ ws: 'owned', headless: true }),
    liveStatus: async () => ({ state: 'signed_in' }), close: async () => { closed++; } };
  await assert.rejects(inspectAccounts({ chrome, items: [{ identity: 'main', site: 'kimi' }], signal: new AbortController().signal,
    createInspector: () => inspector, onStage: (_item, value) => { stage = value; }, onResult: async () => { throw Error('disk full'); } }), /disk full/);
  assert.equal(closed, 1); assert.equal(stage, '正在释放检查资源');
  const release = acquire('account-check', path.join(chrome.root, 'locks'));
  assert.equal(typeof release, 'function'); release();
});
test('an aborted later check cannot resume websites from a previous successful check', async t => {
  let run = 0;
  const { acc } = setup(t, async ({ items, onResult, signal }) => {
    run++;
    if (run === 1) await onResult(items.find(i => i.site === 'kimi' && i.identity === 'main'), { state: 'signed_in', live: true });
    else acc.abort.abort();
  });
  const resumed = []; acc.recovery = { resume: async r => { resumed.push(r.provider); } };
  await acc.check(); assert.deepEqual(resumed, ['kimi']);
  await acc.check(); assert.deepEqual(resumed, ['kimi']);
});

test('website security gates are reported as restricted background checks, not sign-outs', async t => {
  const { chrome } = setup(t), results = [];
  const inspector = { ensure: async () => ({ ws: 'owned', headless: true }), endpoint: async () => ({ ws: 'owned', headless: true }),
    chatgptAccount: async () => { throw Object.assign(Error('gate'), { code: 'HUB_LOGIN_CHECK_RESTRICTED' }); },
    liveStatus: async () => ({ state: 'needs_attention', reason: 'challenge' }), close: async () => {} };
  await inspectAccounts({ chrome, items: [{ identity: 'main', site: 'chatgpt' }, { identity: 'main', site: 'claude' }],
    signal: new AbortController().signal, createInspector: () => inspector, onStage() {}, onResult: async (_item, result) => results.push(result) });
  for (const result of results) {
    assert.equal(result.state, 'needs_attention'); assert.equal(result.reason, 'headless_challenge');
    assert.match(result.error, /不代表登录失效/);
  }
});
test('paused sites and a person handoff reach the account page and turn the row into 去验证', async t => {
  const { root, acc } = setup(t);
  const guard = require('../core/web-risk-guard');
  guard.recordChallenge(root, { identity: 'alt', site: 'chatgpt', kind: 'cloudflare' });
  guard.releaseSite(root, 'alt', 'chatgpt');  // a person cleared it, then automation met it again
  guard.recordChallenge(root, { identity: 'alt', site: 'chatgpt', kind: 'cloudflare' });
  const lease = guard.startHandoff(root, { identity: 'alt', site: 'chatgpt' });
  const state = await acc.passiveState();
  assert.equal(state.risk.handoff.id, lease.id);
  assert.equal(state.risk.sites['alt:chatgpt'].strikes, 2);
  assert.equal(state.risk.sites['main:chatgpt'], undefined);
  await acc.preference({ site: 'chatgpt', identity: 'alt', add: true });
  const { aiHtml } = require('../renderer/account-workspace-view');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = aiHtml(await acc.passiveState(), '', esc);
  assert.match(html, /网页工具已暂停并断开/);
  assert.match(html, /自动化已暂停到/);
  assert.match(html, /第 2 次/);
  assert.match(html, /data-ac="open" data-site="chatgpt" data-identity="alt"[^>]*>去验证/);
  assert.doesNotMatch(html, /data-identity="main"[^>]*>去验证/);
  guard.endHandoff(root, lease.id); guard.clearSite(root, 'alt', 'chatgpt');
  assert.doesNotMatch(aiHtml(await acc.passiveState(), '', esc), /自动化已暂停|网页工具已暂停/);
});
