'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { PersonalChrome, MARKER } = require('../core/personal-chrome');
const { HubAccounts } = require('../core/hub-accounts');
const { HubChrome } = require('../core/hub-chrome');

function tmp(t, name) { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function cookieDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, expires_utc INTEGER)');
  const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,0)');
  for (const [host, name] of rows) ins.run(host, name, Buffer.from('v10secret'));
  db.close();
}
function names(file) {
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT name FROM cookies ORDER BY name').all().map(r => r.name); } finally { db.close(); }
}
function fakeHub(root, { ep = null, busy = 0, heldWindow = false } = {}) {
  const hub = new HubChrome({ root, env: {}, proxy: '' });
  let running = ep;
  Object.assign(hub, { lifecycle: fn => fn(), endpoint: async () => running, workTabs: async () => busy, profileHeld: () => heldWindow, closed: 0,
    close: async () => { hub.closed++; running = null; } });
  return hub;
}
function sourceProfile(root) {
  fs.writeFileSync(path.join(root, 'Local State'), '{"os_crypt":{"encrypted_key":"KEY"}}');
  cookieDb(path.join(root, 'main', 'Network', 'Cookies'), [['.chatgpt.com', '__Secure-next-auth.session-token.0'], ['.chatgpt.com', 'cf_clearance'],
    ['chatgpt.com', 'cf_chl_rc_ni'], ['.claude.ai', '__cf_bm'], ['.claude.ai', 'sessionKey']]);
  for (const dir of ['Cache/Cache_Data', 'Code Cache/js', 'Local Storage/leveldb', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache']) fs.mkdirSync(path.join(root, 'main', dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'main', 'Cache', 'Cache_Data', 'big'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(root, 'main', 'Local Storage', 'leveldb', '000003.log'), 'deepseek token');
  fs.writeFileSync(path.join(root, 'main', 'Bookmarks'), '{}');
}

test('the person gets a copy of the profile: logins, bookmarks and storage; no caches, no challenge state', async t => {
  const src = tmp(t, 'hub-src-'), dst = path.join(tmp(t, 'hub-dst-'), 'personal');
  sourceProfile(src);
  const hub = fakeHub(src, { ep: { ws: 'tools', headless: false } });
  const personal = new PersonalChrome({ root: dst, env: {}, proxy: '' });
  assert.equal(personal.ready(), false);
  const r = await personal.prepare(hub);
  assert.equal(hub.closed, 1, 'the idle AI browser was closed so its files could be copied');
  assert.deepEqual(r, { prepared: true, profiles: ['main'], scrubbed: 3 });
  assert.equal(personal.ready(), true);
  assert.equal(fs.readFileSync(path.join(dst, 'Local State'), 'utf8'), '{"os_crypt":{"encrypted_key":"KEY"}}', 'the cookie key comes along');
  assert.deepEqual(names(path.join(dst, 'main', 'Network', 'Cookies')), ['__Secure-next-auth.session-token.0', 'sessionKey']);
  assert.equal(names(path.join(src, 'main', 'Network', 'Cookies')).length, 5, 'the AI browser keeps its own cookies untouched');
  assert.equal(fs.readFileSync(path.join(dst, 'main', 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'deepseek token');
  assert.ok(fs.existsSync(path.join(dst, 'main', 'Bookmarks')));
  for (const gone of ['Cache', 'Code Cache', 'Service Worker/CacheStorage']) assert.equal(fs.existsSync(path.join(dst, 'main', gone)), false, gone);
  assert.ok(fs.existsSync(path.join(dst, 'main', 'Service Worker', 'ScriptCache')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dst, MARKER), 'utf8')).at);
  assert.deepEqual(await personal.prepare(hub), { prepared: false }, 'done once');
});

test('the copy waits for a window someone uses or a tool at work; nothing is closed', async t => {
  const src = tmp(t, 'hub-src-'), dst = path.join(tmp(t, 'hub-dst-'), 'personal');
  sourceProfile(src);
  const personal = new PersonalChrome({ root: dst, env: {}, proxy: '' });
  await assert.rejects(personal.prepare(fakeHub(src, { heldWindow: true })), { code: 'HUB_WINDOW_OPEN' });
  const busy = fakeHub(src, { ep: { ws: 'tools' }, busy: 2 });
  await assert.rejects(personal.prepare(busy), { code: 'HUB_BROWSER_BUSY' });
  assert.equal(busy.closed, 0); assert.equal(personal.ready(), false); assert.equal(fs.existsSync(dst), false);
});

test('the personal browser launches exactly like an ordinary Chrome', async t => {
  const dst = tmp(t, 'hub-personal-');
  fs.writeFileSync(path.join(dst, MARKER), '{}');
  const spawned = [];
  const personal = new PersonalChrome({ root: dst, env: {}, proxy: 'http://127.0.0.1:7890', executable: () => 'chrome.exe',
    spawnImpl: (_exe, args) => { spawned.push(args); const ee = new (require('events'))(); ee.unref = () => {}; ee.pid = 7; setImmediate(() => ee.emit('spawn')); return ee; } });
  const r = await personal.open('main', ['https://chatgpt.com/']);
  assert.equal(r.mode, 'personal');
  const args = spawned[0];
  assert.ok(args.includes('--user-data-dir=' + dst)); assert.ok(args.includes('--profile-directory=main'));
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:7890'));
  for (const bad of ['--remote-debugging-port', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--window-position', '--headless'])
    assert.ok(!args.some(a => a.startsWith(bad)), bad + ' must not be passed');
  assert.equal(args.at(-1), 'https://chatgpt.com/');
});

test('a window a person uses in the AI browser gets none of the tool switches', () => {
  const hub = new HubChrome({ root: 'C:/x', env: {}, proxy: '' });
  const plain = hub.launchArgs('main', { debug: false, visible: true, newWindow: false, urls: ['https://chatgpt.com/'] });
  assert.ok(!plain.some(a => /disable-(renderer-backgrounding|background-timer-throttling|backgrounding-occluded-windows)|remote-debugging/.test(a)));
  const tools = hub.launchArgs('main');
  assert.ok(tools.includes('--disable-renderer-backgrounding') && tools.some(a => a.startsWith('--remote-debugging-port')));
});

test('copying the logins of the person to the AI browser replaces its cookies and storage only', async t => {
  const src = tmp(t, 'hub-src-'), dst = path.join(tmp(t, 'hub-dst-'), 'personal');
  sourceProfile(src);
  const personal = new PersonalChrome({ root: dst, env: {}, proxy: '' });
  await personal.prepare(fakeHub(src));
  fs.rmSync(path.join(dst, 'main', 'Network', 'Cookies'));
  cookieDb(path.join(dst, 'main', 'Network', 'Cookies'), [['.chatgpt.com', '__Secure-next-auth.session-token.0'], ['.chatgpt.com', 'cf_clearance']]);
  fs.writeFileSync(path.join(src, 'main', 'Bookmarks'), '{"ai":1}');
  const r = await personal.copyLoginsTo(fakeHub(src), 'main');
  assert.equal(r.scrubbed, 1);
  assert.deepEqual(names(path.join(src, 'main', 'Network', 'Cookies')), ['__Secure-next-auth.session-token.0']);
  assert.equal(fs.readFileSync(path.join(src, 'main', 'Bookmarks'), 'utf8'), '{"ai":1}', 'nothing else of the AI browser changes');
  personal.held = () => true;
  await assert.rejects(personal.copyLoginsTo(fakeHub(src), 'main'), { code: 'PERSONAL_OPEN' });
});

test('打开 uses the personal browser, preparing it on first use; until then it falls back politely', async t => {
  const root = tmp(t, 'hub-acc-');
  const chrome = new HubChrome({ root, env: { CLAUDE_HUB_HOME_DIR: root } });
  chrome.running = async () => false; chrome.profileHeld = () => false;
  let ready = false, prepared = 0;
  const opened = [], fallback = [], logins = [];
  const personal = { ready: () => ready, prepare: async () => { prepared++; ready = true; },
    open: async (identity, urls) => { opened.push([identity, urls[0]]); return { mode: 'personal' }; } };
  const acc = new HubAccounts({ hubChrome: chrome, personalChrome: personal, env: { CLAUDE_HUB_HOME_DIR: root }, getConfig: () => ({}) });
  chrome.openWebsite = async (...a) => { fallback.push(a); return { mode: 'ordinary' }; };
  const first = await acc.open({ site: 'chatgpt' });
  assert.equal(prepared, 1); assert.deepEqual(opened, [['main', 'https://chatgpt.com/']]);
  assert.match(first.message, /你的浏览器.*第一次使用/);
  await acc.open({ site: 'claude' });
  assert.equal(prepared, 1, 'prepared once');
  ready = false; personal.prepare = async () => { throw Object.assign(Error('window'), { code: 'HUB_WINDOW_OPEN' }); };
  const later = await acc.open({ site: 'kimi' });
  assert.deepEqual(fallback, [['main', 'kimi']]); assert.match(later.message, /这次先在专属 Chrome 打开/);
  chrome.openLogin = async (...a) => { logins.push(a); return { mode: 'ordinary' }; };
  const ai = await acc.open({ site: 'chatgpt', login: true });
  assert.deepEqual(logins, [['main', ['chatgpt']]]); assert.match(ai.message, /AI 浏览器/);
});
