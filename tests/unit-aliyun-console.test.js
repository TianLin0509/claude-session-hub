'use strict';
// 2026-10-13 账号页「阿里云控制台」：独立专用浏览器，AI 只读查看。
// 锁住：条目字段与登录提示、状态判断只看 cookie 名字和页面地址、只开阿里云网址、密钥不外露。
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const aliyun = require('../core/aliyun-console');
const { SERVICES } = require('../core/tool-account-catalog');
const { buildToolAccounts } = require('../core/tool-accounts');
const { readExternalState } = require('../core/external-accounts');
const { HubAccounts } = require('../core/hub-accounts');
const view = require('../renderer/account-workspace-view');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aliyun-console-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const page = url => ({ type: 'page', url, title: 'x', id: 'T' + url.length });

test('entry fields: home page, purpose and login hint', () => {
  assert.equal(aliyun.HOME_URL, 'https://bailian.console.aliyun.com/');
  assert.equal(aliyun.PURPOSE, '阿里云 / 百炼控制台（AI 可查看）');
  assert.match(aliyun.LOGIN_HINT, /阿里云 App/); assert.match(aliyun.LOGIN_HINT, /支付宝扫码/); assert.match(aliyun.LOGIN_HINT, /账号密码/);
  const s = SERVICES[aliyun.SERVICE_ID];
  assert.equal(s.name, '阿里云控制台'); assert.equal(s.purpose, aliyun.PURPOSE); assert.match(s.help, /扫码/); assert.match(s.help, /本人操作/);
  assert.match(aliyun.profileDir('D:/x'), /account-browsers[\\/]aliyun-console$/);
});

test('account list always shows the console in API 与服务 with its own browser status', t => {
  const root = tmp(t);
  const data = buildToolAccounts({ rows: [] }, { root, homeDir: root, env: {} });
  const row = data.services.find(s => s.id === 'aliyunConsole');
  assert.ok(row); assert.equal(row.website, true); assert.equal(row.canCheck, true); assert.equal(row.status, 'native'); assert.equal(row.purpose, aliyun.PURPOSE);
  const html = view.servicesHtml(data, 'api', '', {}, s => String(s));
  assert.match(html, /data-account-service="aliyunConsole"/);
  assert.match(html, /阿里云 \/ 百炼控制台（AI 可查看）/);
  assert.match(html, /data-service="aliyunConsole" data-operation="open">登录 ↗/);
  assert.match(html, /data-service="aliyunConsole" data-operation="check">检查登录/);
  assert.match(html, /还没检查登录/);
  const signed = { services: [{ ...row, nativeStatus: { state: 'signed_in', message: 'x', checkedAt: Date.now() } }] };
  const htmlSigned = view.servicesHtml(signed, 'api', '', {}, s => String(s));
  assert.match(htmlSigned, /data-operation="open">打开 ↗/); assert.match(htmlSigned, /已登录/);
  assert.doesNotMatch(view.servicesHtml(data, 'work', '', {}, s => String(s)), /aliyunConsole/);
});

test('login state comes from the redirect and login cookie names only', () => {
  const ticket = [{ name: 'login_aliyunid_ticket', domain: '.aliyun.com' }];
  assert.equal(aliyun.classifyLogin({ pages: [page('https://signin.aliyun.com/login.htm')], cookies: [] }).state, 'signed_out');
  assert.equal(aliyun.classifyLogin({ pages: [page('https://bailian.console.aliyun.com/')], cookies: ticket }).state, 'signed_in');
  assert.equal(aliyun.classifyLogin({ pages: [], cookies: ticket }).state, 'signed_in');
  // 只剩登录页时，残留票据不算已登录；同时开着控制台页才算。
  assert.equal(aliyun.classifyLogin({ pages: [page('https://signin.aliyun.com/login.htm')], cookies: ticket }).state, 'signed_out');
  assert.equal(aliyun.classifyLogin({ pages: [page('https://signin.aliyun.com/x'), page('https://home.console.aliyun.com/')], cookies: ticket }).state, 'signed_in');
  assert.equal(aliyun.classifyLogin({ pages: [page('https://bailian.console.aliyun.com/')], cookies: [{ name: 'cna', domain: '.aliyun.com' }] }).state, 'signed_out');
  assert.equal(aliyun.classifyLogin({ pages: [], cookies: [{ name: 'login_aliyunid_ticket', domain: '.evil.com' }] }).state, 'signed_out');
  assert.equal(aliyun.classifyLogin({ pages: [page('https://bailian.console.aliyun.com/')], cookies: null }).state, 'unknown');
  // 非阿里云页面不参与判断
  assert.equal(aliyun.classifyLogin({ pages: [page('https://signin.aliyun.com.evil.com/')], cookies: null }).state, 'unknown');
});

test('only https aliyun / alibabacloud URLs are opened', () => {
  for (const ok of ['https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal', 'https://usercenter2.aliyun.com/home', 'https://www.alibabacloud.com/']) assert.ok(aliyun.hostAllowed(ok), ok);
  for (const bad of ['http://bailian.console.aliyun.com/', 'https://aliyun.com.evil.com/', 'https://user@bailian.console.aliyun.com/', 'file:///C:/x', 'javascript:alert(1)', 'https://evilaliyun.com/']) {
    assert.ok(!aliyun.hostAllowed(bad), bad); assert.throws(() => aliyun.assertUrl(bad), /只能打开阿里云/);
  }
});

test('page text hides keys; pages showing keys are flagged for no screenshot', () => {
  const raw = 'AccessKey ID LTAI5tAbCdEfGhIjKlMn12\nAccessKey Secret: abcdefghijklmnopqrstuvwxyz0123\nAPI Key sk-0123456789abcdef0123456789abcdef\n额度 100 万';
  const out = aliyun.redact(raw);
  for (const secret of ['LTAI5tAbCdEfGhIjKlMn12', 'abcdefghijklmnopqrstuvwxyz0123', 'sk-0123456789abcdef0123456789abcdef']) assert.ok(!out.includes(secret), secret);
  assert.match(out, /额度 100 万/);
  assert.ok(aliyun.containsSecret(raw)); assert.ok(aliyun.containsSecret(raw)); // 正则状态不残留
  assert.ok(!aliyun.containsSecret('Token Plan 个人版 已用 12%'));
});

test('live status reads cookie names through CDP and never keeps values', async t => {
  const c = new aliyun.AliyunConsole({ dataDir: tmp(t), env: {} });
  c.endpoint = async () => ({ port: 9999, ws: 'ws://127.0.0.1:9999/devtools/browser/x' });
  c.pages = async () => [page('https://bailian.console.aliyun.com/')];
  c.connect = async () => ({ call: async method => { assert.equal(method, 'Storage.getCookies'); return { cookies: [{ name: 'login_aliyunid_ticket', value: 'SECRET-TICKET', domain: '.aliyun.com' }, { name: 'sid', value: 'SECRET-OTHER', domain: '.google.com' }] }; }, close() {} });
  const v = await c.status();
  assert.equal(v.state, 'signed_in'); assert.equal(v.running, true);
  assert.ok(!JSON.stringify(v).includes('SECRET'));
  const names = await c.liveCookies(await c.endpoint());
  assert.deepEqual(names, [{ name: 'login_aliyunid_ticket', domain: '.aliyun.com' }]);
});

test('closed browser: never opened is unknown, offline cookie names decide otherwise', async t => {
  const dir = tmp(t), c = new aliyun.AliyunConsole({ dataDir: dir, env: {} });
  assert.match((await c.status()).message, /还没打开过/);
  const db = path.join(c.profile, 'Default', 'Network'); fs.mkdirSync(db, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const conn = new DatabaseSync(path.join(db, 'Cookies'));
  conn.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER, encrypted_value BLOB)');
  conn.prepare('INSERT INTO cookies VALUES (?,?,?,?)').run('.aliyun.com', 'login_aliyunid_ticket', (Date.now() + 86400000 + 11644473600000) * 1000, Buffer.from('v10SECRET'));
  conn.close();
  const v = await c.status();
  assert.equal(v.state, 'signed_in'); assert.equal(v.running, false); assert.ok(!JSON.stringify(v).includes('SECRET'));
});

test('isolated background tests park the user window instead of taking focus', t => {
  const dir = tmp(t);
  const prod = new aliyun.AliyunConsole({ dataDir: dir, env: {} });
  assert.ok(prod.launchArgs(aliyun.HOME_URL, { visible: true }).includes('--start-maximized'));
  assert.ok(prod.launchArgs(aliyun.HOME_URL, { visible: false }).includes('--window-position=-32000,-32000'));
  const iso = new aliyun.AliyunConsole({ dataDir: dir, env: { CLAUDE_HUB_DATA_DIR: dir, CLAUDE_HUB_E2E_WINDOW_MODE: 'background' } });
  const args = iso.launchArgs(aliyun.HOME_URL, { visible: true });
  assert.ok(args.includes('--window-position=-32000,-32000') && !args.includes('--start-maximized'));
  assert.ok(args.includes('--remote-debugging-port=0') && args.includes('--user-data-dir=' + iso.profile));
});

test('account page actions: open shows the login hint, check stores only a fixed status', async t => {
  const root = tmp(t), opened = [];
  const accounts = Object.create(HubAccounts.prototype);
  Object.assign(accounts, { env: {}, now: () => 4242, chrome: { root }, setup: {},
    aliyunBrowser: { openForUser: async url => { opened.push(url); return { launched: true }; }, status: async () => ({ state: 'signed_out', message: '页面停在阿里云登录页，还没登录', running: true }) } });
  const o = await accounts.external({ service: 'aliyunConsole', action: 'open' });
  assert.deepEqual(opened, [aliyun.HOME_URL]); assert.match(o.message, /支付宝扫码/); assert.match(o.message, /检查登录/);
  const c = await accounts.external({ service: 'aliyunConsole', action: 'check' });
  assert.match(c.message, /阿里云控制台/);
  assert.deepEqual(readExternalState(root).aliyunConsole, { state: 'signed_out', account: '', source: '阿里云控制台专用浏览器', checkedAt: 4242, message: '页面停在阿里云登录页，还没登录' });
  await assert.rejects(accounts.external({ service: 'aliyunConsole', action: 'authorize' }), /只支持打开和检查登录/);
});

test('command line parses options and refuses non-aliyun URLs before starting a browser', async t => {
  const { parse, main } = require('../scripts/aliyun-console');
  assert.deepEqual(parse(['text', '--tab', 'ABC', '--max', '50', '--json']), { command: 'text', rest: [], opts: { tab: 'ABC', max: '50', json: true } });
  const dir = tmp(t);
  await assert.rejects(main(['open', 'https://example.com/', '--data-dir', dir], () => {}), /只能打开阿里云/);
  assert.ok(!fs.existsSync(aliyun.profileDir(dir)), 'no profile created for a refused URL');
  const lines = []; await main(['list', '--data-dir', dir], s => lines.push(s));
  assert.match(lines[0], /没在运行/);
});
