'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { HubChrome, defaultRoot, chromeTimeToMs, hostMatches } = require('../core/hub-chrome');
const { cliAuthStatus } = require('../core/cli-auth');
const { HubAccounts } = require('../core/hub-accounts');

function tmp(t, prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
// A real Chrome cookie table, minimal columns: offline checks read names and expiry only.
function cookieDb(root, identity, rows) {
  const dir = path.join(root, identity, 'Network'); fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER, encrypted_value BLOB)');
  const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?)');
  for (const r of rows) ins.run(r.host, r.name, r.expiresMs ? (r.expiresMs + 11644473600000) * 1000 : 0, Buffer.from('v10secret'));
  db.close();
}

test('an isolated Hub never points at the production Chrome', () => {
  assert.equal(defaultRoot({}), 'C:\\VibeData\\HubChrome');
  assert.equal(defaultRoot({ CLAUDE_HUB_DATA_DIR: 'C:\\t\\data' }), path.join('C:\\t\\data', 'hub-chrome'));
  assert.equal(defaultRoot({ CLAUDE_HUB_HOME_DIR: 'C:\\t\\home' }), path.join('C:\\t\\home', 'hub-chrome'));
  assert.equal(defaultRoot({ HUB_CHROME_ROOT: 'C:\\x', CLAUDE_HUB_DATA_DIR: 'C:\\t' }), path.resolve('C:\\x'));
});
test('Chrome time and cookie hosts are read the way Chrome writes them', () => {
  assert.equal(chromeTimeToMs(0), 0, 'session cookie: no expiry');
  // Chrome counts from 1601-01-01; the Unix epoch is 11,644,473,600 s later.
  const when = Date.UTC(2026, 11, 24, 3, 4, 5);
  assert.equal(chromeTimeToMs(when + 11644473600000), when);
  assert.ok(hostMatches('.chatgpt.com', 'chatgpt.com') && hostMatches('chatgpt.com', 'chatgpt.com') && hostMatches('.auth.chatgpt.com', 'chatgpt.com'));
  assert.ok(!hostMatches('.notchatgpt.com', 'chatgpt.com'), 'a lookalike host is not the site');
});
test('"检查登录" answers from the cookie file alone: present, expired, missing, unknowable', t => {
  const root = tmp(t, 'hub-chrome-unit-'), now = Date.UTC(2026, 8, 25);
  cookieDb(root, 'main', [
    { host: '.chatgpt.com', name: '__Secure-next-auth.session-token.0', expiresMs: now + 90 * 86400000 },
    { host: '.chatgpt.com', name: '__Secure-next-auth.session-token.1', expiresMs: now + 90 * 86400000 },
    { host: '.google.com', name: '__Secure-1PSID', expiresMs: now - 1000 },            // expired
    { host: '.doubao.com', name: 'sessionid', expiresMs: 0 },                          // session cookie
    { host: '.notclaude.ai', name: 'sessionKey', expiresMs: now + 86400000 },          // lookalike
  ]);
  const hub = new HubChrome({ root, now: () => now });
  const s = hub.offlineStatus('main');
  assert.deepEqual(s.sites.chatgpt, { state: 'cookie_present', expiresAt: now + 90 * 86400000 });
  assert.deepEqual(s.sites.google, { state: 'signed_out' }, 'an expired login is not a login');
  assert.deepEqual(s.sites.doubao, { state: 'cookie_present', expiresAt: 0 });
  assert.deepEqual(s.sites.claude, { state: 'signed_out' });
  assert.deepEqual(s.sites.deepseek, { state: 'needs_browser' }, 'localStorage sites say so instead of guessing');
  assert.deepEqual(hub.offlineStatus('alt').sites, { chatgpt: { state: 'signed_out' } }, 'a profile never used has no login');
});
test('login refuses a site the identity does not hold, and unknown identities', async () => {
  const hub = new HubChrome({ root: os.tmpdir() });
  await assert.rejects(hub.openLogin('alt', 'qwen'), /不负责/);
  assert.throws(() => hub.identity('nope'), /未知的账号身份/);
});
test('CLI status reads token files only, reports the account, and never returns a token', t => {
  const home = tmp(t, 'hub-cli-unit-');
  const jwt = p => 'x.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.y';
  const write = (rel, v) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
  write('.codex/auth.json', { tokens: { id_token: jwt({ email: 'main@x.com' }), access_token: 'SECRET-A', refresh_token: 'SECRET-R' } });
  write('.claude/.credentials.json', { claudeAiOauth: { refreshToken: 'SECRET-C', refreshTokenExpiresAt: Date.now() - 1000 } });
  write('.claude.json', { oauthAccount: { emailAddress: 'd@x.com' } });
  write('.gemini/oauth_creds.json', { refresh_token: 'SECRET-G' });
  write('.gemini/google_accounts.json', { active: 'main@x.com' });
  const out = cliAuthStatus({ env: { CLAUDE_HUB_HOME_DIR: home }, config: {} });
  const by = Object.fromEntries(out.map(c => [c.id, c]));
  assert.deepEqual([by['codex:default'].state, by['codex:default'].account], ['authorized', 'main@x.com']);
  assert.deepEqual([by.claude.state, by.claude.account], ['expired', 'd@x.com'], 'an expired refresh token is not an authorisation');
  assert.equal(by.gemini.state, 'authorized');
  assert.equal(by.kimi.state, 'missing');
  assert.ok(!/SECRET/.test(JSON.stringify(out)));
});
test('a CLI sits under the identity that holds its web login; Codex is matched by account', () => {
  const acc = new HubAccounts({ hubChrome: new HubChrome({ root: os.tmpdir() }) });
  const identities = [
    { id: 'main', account: 'lintian0509@gmail.com', sites: [{ key: 'chatgpt', state: 'signed_in' }, { key: 'claude', state: 'signed_in' }] },
    { id: 'alt', account: 'd@gmail.com', sites: [{ key: 'chatgpt', state: 'signed_in' }] },
  ];
  assert.equal(acc.owner({ kind: 'codex', site: 'chatgpt', account: 'D@gmail.com' }, identities), 'alt');
  assert.equal(acc.owner({ kind: 'codex', site: 'chatgpt', account: 'x@y.z' }, identities), '', 'an unknown account is not guessed');
  assert.equal(acc.owner({ kind: 'claude', site: 'claude' }, identities), '', 'a common provider is not identity evidence');
  assert.equal(acc.owner({ kind: 'claude', site: 'claude', account: 'lintian0509@gmail.com' }, identities), 'main');
});

test('only logins in the identity roundtable tasks run in can release them', async () => {
  const resumed = [];
  const acc = new HubAccounts({ hubChrome: new HubChrome({ root: os.tmpdir() }), recovery: { resume: async row => { resumed.push(row.provider); } } });
  await acc.resumeWaiting([
    { id: 'main', sites: [{ key: 'deepseek', state: 'signed_in', live: true }, { key: 'google', state: 'signed_in', live: true }, { key: 'kimi', state: 'signed_out' }, { key: 'claude', state: 'signed_in' }] },
    { id: 'alt', sites: [{ key: 'chatgpt', state: 'signed_in' }] },
  ]);
  assert.deepEqual(resumed, ['deepseek', 'gemini'], 'Google is Gemini to the roundtable; alt and non-roundtable sites release nothing');
});
test('the scripted-login seam is ignored outside an isolated home', t => {
  const file = path.join(tmp(t, 'hub-fixture-'), 'f.json');
  fs.writeFileSync(file, JSON.stringify({ running: true, main: { sites: { chatgpt: { state: 'signed_in' } } } }));
  const prod = new HubAccounts({ hubChrome: new HubChrome({ root: os.tmpdir() }), env: { HUB_ACCOUNTS_FIXTURE: file } });
  assert.equal(prod.fixture(), null);
  const isolated = new HubAccounts({ hubChrome: new HubChrome({ root: os.tmpdir() }), env: { HUB_ACCOUNTS_FIXTURE: file, CLAUDE_HUB_HOME_DIR: os.tmpdir() } });
  assert.equal(isolated.fixture().running, true);
});

test('a login window is always placed on screen, never left to the position Chrome remembers', () => {
  const hub = new HubChrome({ root: path.join(os.tmpdir(), 'hub-args') });
  const login = hub.launchArgs('main', { debug: false, visible: true, urls: ['https://www.kimi.com/'] });
  assert.ok(login.includes('--window-position=120,80'), 'the Hub parks work windows off screen; Chrome would restore that');
  assert.ok(!login.some(a => a.startsWith('--remote-debugging')), 'and no debugging port, or Google refuses the login');
  assert.ok(hub.launchArgs('main').includes('--window-position=-32000,-32000'), 'work windows stay off screen');
});
