'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { HubChrome } = require('../core/hub-chrome');
const { HubAccounts } = require('../core/hub-accounts');
function service(t, site, previous = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let running = false, starts = 0, closes = 0;
  const chrome = { root, identities: [{ id: 'main', label: '主', sites: ['chatgpt', 'deepseek'] }],
    running: async () => running, profileHeld: () => false,
    lifecycle: fn => fn(), ensure: async () => { starts++; running = true; },
    closeIfIdle: async () => { closes++; running = false; },
    loginStatus: async () => ({ sites: { chatgpt: { state: 'cookie_present' }, deepseek: site } }) };
  const acc = new HubAccounts({ hubChrome: chrome, env: { CLAUDE_HUB_HOME_DIR: root }, getConfig: () => ({}), now: () => 5000 });
  acc.writeCache({ identities: { main: { account: 'old@example.com', sites: { deepseek: previous } } } });
  return { acc, chrome, stats: () => ({ starts, closes }) };
}
test('passive refresh never opens ChatGPT to rediscover the account', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-passive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = new HubChrome({ root, identities: [{ id: 'main', sites: ['chatgpt'] }] });
  hub.running = async () => true;
  hub.liveCookieRows = async () => [{ host: 'chatgpt.com', name: '__Secure-next-auth.session-token', expiresAt: 0 }];
  hub.chatgptAccount = async () => { throw Error('must not query a page during refresh'); };
  const value = await hub.loginStatus('main', { live: false });
  assert.equal(value.sites.chatgpt.state, 'cookie_present');
  assert.equal(value.account, undefined);
});
test('old website proof stays visibly old and cannot release a waiting task', async t => {
  const { acc, stats } = service(t, { state: 'needs_browser' }, { state: 'signed_in', live: true, verified: true, checkedAt: 1000 });
  const resumed = []; acc.recovery = { resume: async row => resumed.push(row) };
  const passive = await acc.state();
  assert.deepEqual(stats(), { starts: 0, closes: 0 });
  const old = passive.identities[0].sites.find(s => s.key === 'deepseek');
  assert.equal(old.stale, true); assert.equal(old.checkedAt, 1000);
  await acc.check();
  assert.deepEqual(resumed, []);
  assert.deepEqual(stats(), { starts: 1, closes: 1 });
  const again = await acc.state();
  assert.equal(again.checkedAt, 5000);
  assert.equal(again.identities[0].sites.find(s => s.key === 'deepseek').checkedAt, 1000);
});
test('explicit checks coalesce and fresh proof alone resumes a waiting task', async t => {
  const { acc, stats } = service(t, { state: 'signed_in', live: true });
  const resumed = []; acc.recovery = { resume: async row => resumed.push(row.provider) };
  await Promise.all([acc.check(), acc.check(), acc.state()]);
  assert.deepEqual(stats(), { starts: 1, closes: 1 });
  assert.deepEqual(resumed, ['deepseek']);
});
test('sign-out clears cached web identity instead of assigning CLI by an old email', async t => {
  const { acc, chrome } = service(t, { state: 'needs_browser' });
  chrome.loginStatus = async () => ({ sites: { chatgpt: { state: 'signed_out' }, deepseek: { state: 'needs_browser' } } });
  const state = await acc.state();
  assert.equal(state.identities[0].account, '');
  assert.equal(acc.owner({ kind: 'codex', account: 'old@example.com' }, state.identities), '');
});
