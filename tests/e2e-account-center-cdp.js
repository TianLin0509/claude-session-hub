'use strict';
// Real isolated Hub GUI and IPC; external websites and CLI authorization use explicit fixtures.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { HubChrome } = require('../core/hub-chrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const jwt = p => 'x.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.y';
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
function seedCookies(root, identity, rows) {
  const dir = path.join(root, identity, 'Network'); fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec('CREATE TABLE IF NOT EXISTS cookies (host_key TEXT, name TEXT, expires_utc INTEGER, encrypted_value BLOB)');
  const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?)');
  for (const r of rows) ins.run(r.host, r.name, (r.expiresMs + 11644473600000) * 1000, Buffer.from('v10fixture'));
  db.close();
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-accounts-gui-')), data = path.join(root, 'data'), home = path.join(root, 'home'), cwd = path.join(root, 'project');
  for (const p of [data, home, cwd, path.join(root, 'empty')]) fs.mkdirSync(p, { recursive: true });
  write(path.join(data, 'config.json'), { proxy: '', providers: { codex: { backend: 'subscription', api_key: 'fixture-codex-key',
    subscription_profile: 'second', subscription_profiles: [{ id: 'default', label: '副账号', home: path.join(home, '.codex') }, { id: 'second', label: '主账号', home: path.join(home, '.codex-second') }] },
    deepseek: { api_key: 'fixture-deepseek-key' } }, unrelatedFixture: 'preserve-me' });
  write(path.join(data, 'prepared-projects.json'), { schemaVersion: 1, projects: [], migrations: [] });
  write(path.join(home, '.agents/skills/bailian-gen/SKILL.md'), '---\nname: bailian-gen\ndescription: fixture\n---\n');
  write(path.join(home, '.bailian/config.json'), { api_key: 'ACCOUNT-SECRET-FIXTURE' });
  write(path.join(home, '.claude.json'), { mcpServers: { 'chatgpt-web-images': { command: 'unused-fixture' } } });
  write(path.join(home, '.mcporter/mcporter.json'), { mcpServers: { douyin: { command: 'unused', env: { DASHSCOPE_API_KEY: 'ACCOUNT-SECRET-FIXTURE' } } } });
  // CLI token files: two Codex profiles on two accounts, Claude expired, Gemini fine, Kimi absent.
  write(path.join(home, '.codex', 'auth.json'), { tokens: { id_token: jwt({ email: 'alt@example.com' }), refresh_token: 'SECRET-1' } });
  write(path.join(home, '.codex-second', 'auth.json'), { tokens: { id_token: jwt({ email: 'main@example.com' }), refresh_token: 'SECRET-2' } });
  write(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: { refreshToken: 'SECRET-3', refreshTokenExpiresAt: Date.now() - 1000 } });
  write(path.join(home, '.gemini', 'oauth_creds.json'), { refresh_token: 'SECRET-4' });
  // Web logins as Chrome stores them: main holds ChatGPT until well after today, nothing else.
  const chromeRoot = path.join(data, 'hub-chrome'), in90 = Date.now() + 90 * 86400000;
  seedCookies(chromeRoot, 'main', [{ host: '.chatgpt.com', name: '__Secure-next-auth.session-token', expiresMs: in90 }]);
  // Pretend an earlier check learned which ChatGPT account each identity holds.
  write(path.join(chromeRoot, 'last-check.json'), { identities: { main: { account: 'main@example.com', sites: {} }, alt: { account: 'alt@example.com', sites: {} } } });

  const fixture = path.join(root, 'accounts-fixture.json');
  write(fixture, { recordOpens: true, delayMs: 500, main: { account: 'main@example.com', sites: { chatgpt: { state: 'signed_in' }, google: { state: 'needs_attention' }, deepseek: { state: 'signed_in' } } }, alt: { account: 'alt@example.com', sites: { chatgpt: { state: 'signed_in' } } } });
  const toolsRoot = path.join(chromeRoot, 'tool-fixtures'), pool = path.join(toolsRoot, 'ChatGPTWebImagesPool');
  const laneConfig = path.join(pool, 'accounts/primary/config'), laneData = path.join(toolsRoot, 'old-browser');
  fs.mkdirSync(laneData, { recursive: true });
  const oldCli = path.join(toolsRoot, 'old-cli.cjs'); write(oldCli, 'process.stdout.write("closed fixture browser");');
  write(path.join(laneConfig, 'settings.json'), { data_dir: laneData, cli_entry: oldCli, account_name: 'main@example.com' });
  const { DatabaseSync } = require('node:sqlite');
  const queue = new DatabaseSync(path.join(pool, 'queue.sqlite3'));
  queue.exec('CREATE TABLE accounts (id TEXT, config_dir TEXT, login_group TEXT); CREATE TABLE jobs (account_id TEXT, status TEXT, updated REAL, error TEXT, result TEXT)');
  queue.prepare('INSERT INTO accounts VALUES (?,?,?)').run('primary', laneConfig, 'primary'); queue.close();
  const out = path.resolve('artifacts/account-center-cdp'); fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, boundary: '真实隔离 Hub、鼠标键盘、DOM、IPC、磁盘记录；官网响应和打开网页使用显式夹具；真实无头 Chrome 另见 e2e-hub-accounts-headless', checks: [], root };
  let hub, cdp;
  const until = async (expr, label, ms = 35000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await cdp.eval('Boolean(' + expr + ')')) { console.log('PASS ' + label); return; } await sleep(150); } throw Error('timeout: ' + label); };
  const click = async selector => { await until('!!document.querySelector(' + JSON.stringify(selector) + ') && !document.querySelector(' + JSON.stringify(selector) + ').disabled', 'enabled ' + selector); const box = await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }); };
  const snap = async name => { const v = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(v.data, 'base64')); };
  const text = sel => cdp.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText||''`);
  const chrome = new HubChrome({ root: chromeRoot });
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), windowMode: 'background', label: 'accounts-center', extraEnv: { CLAUDE_HUB_HOME_DIR: home, HUB_ACCOUNTS_FIXTURE: fixture, DEEPSEEK_API_KEY: '', CODEX_SQLITE_HOME: '', CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AI_HUB_WORKSPACE_ROOT: root,
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'), CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'threads.json'),
      CLAUDE_HUB_ACCOUNT_FIXTURE: path.resolve('tests/fixtures/account-center-cli.js'),
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'empty') } });
    result.pid = hub.pid; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof accountCenterPanel!=="undefined"', 'renderer initialized');

    await click('#btn-rail-accounts'); await until('document.querySelectorAll(".ac-company").length===7', 'seven companies');
    assert.equal(await chrome.running(), false, 'opening the page is passive');
    const main = '.ac-company[data-site="chatgpt"]';
    assert.match(await text(main), /main@example\.com/);
    assert.match(await text(main), /暂无使用记录/);
    assert.equal(await cdp.eval('document.querySelectorAll(".ac-tabs [role=tab]").length'), 5);
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector("#account-page")).backgroundColor'), 'rgb(255, 255, 255)');
    assert.equal(await cdp.eval('document.querySelectorAll("[data-ac=check],[data-ac=cancel],.ac-progress").length'), 0);
    assert.equal(await cdp.eval('document.querySelectorAll(".ac-company[data-site=chatgpt] .ac-account").length'), 2);
    await snap('01-clear-white');
    result.checks.push('白色五分类界面、七家公司和双 ChatGPT；进入页面不启动浏览器，无主动检查入口');
    await click('.ac-search'); await cdp.send('Input.insertText', { text: 'Claude' });
    assert.equal(await cdp.eval('document.querySelectorAll(".ac-company").length'), 1);
    await click('[data-tab="work"]');
    await until('document.querySelector("[data-account-service=github]")', 'work accounts loaded');
    assert.equal(await cdp.eval('document.querySelectorAll(".ac-company").length'), 0);
    assert.ok(await cdp.eval('!!document.querySelector("[data-account-service=yuque]")'));
    for (const service of ['github', 'yuque']) {
      await click('[data-ac="external"][data-service="' + service + '"][data-operation="open"]');
      await until('document.querySelector("[data-account-service=' + service + ']")?.textContent.includes("打开过网页")', 'passive ' + service + ' use');
    }
    assert.deepEqual(fs.readFileSync(path.join(home, 'external-open.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(r => r.action), ['open', 'open']);
    await snap('02-work');
    await click('[data-tab="content"]');
    await until('document.querySelector("[data-account-service=social]")', 'content accounts');
    assert.equal(await cdp.eval('document.querySelectorAll("[data-account-service=github]").length'), 0);
    await click('[data-tab="api"]');
    await until('document.querySelector("[data-account-service=bailian]")', 'API and services');
    assert.ok(!(await text('#account-page')).includes('ACCOUNT-SECRET-FIXTURE'));
    result.checks.push('搜索只筛当前分类；工作/内容/API 各自独立，GitHub 和语雀打开后只记录打开时间');
    await click('[data-tab="ai"]');
    await click('.ac-company[data-site="claude"] summary');
    await click('.ac-company[data-site="claude"] [data-ac="add"]');
    await until('document.querySelectorAll(".ac-company[data-site=claude] .ac-account").length===2', 'second Claude account');
    await click('.ac-company[data-site="claude"] [data-identity="alt"] summary');
    await click('.ac-company[data-site="claude"] [data-ac="preferred"][data-identity="alt"]');
    await until('document.querySelector(".ac-company[data-site=claude] [data-identity=alt] .ac-default")', 'default persisted');
    assert.equal(JSON.parse(fs.readFileSync(path.join(chromeRoot, 'accounts.json'), 'utf8')).sites.claude.preferred, 'alt');
    await click('.ac-company[data-site="claude"] [data-ac="open"][data-identity="alt"]');
    await until('document.querySelector(".ac-company[data-site=claude] [data-identity=alt]").textContent.includes("打开过网页")', 'opened only, not validated login');
    assert.ok(!(await text('.ac-company[data-site="claude"]')).includes('已登录'));
    assert.deepEqual(fs.readFileSync(path.join(home, 'accounts-open.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[0], { site: 'claude', identity: 'alt', url: 'https://claude.ai/' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', modifiers: 1, windowsVirtualKeyCode: 49 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', modifiers: 1, windowsVirtualKeyCode: 49 });
    await until('document.querySelector(".ac-status").textContent.includes("ChatGPT")', 'Alt+1 opens ChatGPT');
    assert.equal(fs.readFileSync(path.join(home, 'accounts-open.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1).site, 'chatgpt');
    const activity = require('../core/hub-account-activity');
    activity.recordActivity(chromeRoot, { site: 'google', source: 'roundtable', outcome: 'success' });
    await until('document.querySelector(".ac-company[data-site=google]").textContent.includes("使用成功")', 'tool result refreshes without check', 12000);
    activity.recordActivity(chromeRoot, { site: 'google', source: 'roundtable', outcome: 'login_required' });
    await until('document.querySelector(".ac-company[data-site=google] [data-ac=login]")', 'real use login error actionable', 12000);
    assert.match(await text('.ac-company[data-site="google"]'), /上次成功/);
    result.checks.push('更多菜单添加/默认账号、鼠标和 Alt+1 打开正确身份；夹具工具事件被动刷新并提示登录异常');
    await click('[data-tab="cli"]');
    await click('[data-ac="authorize"][data-id="kimi"]');
    await until('document.querySelector(".ac-status").textContent.includes("官方登录入口已启动")', 'CLI authorization routed');
    assert.ok(fs.existsSync(path.join(home, 'fixture-login-kimi')));
    await click('[data-ac="config"][data-id="codex"]');
    await until('!document.querySelector("#account-editor").hidden', 'account config opened');
    await until('document.querySelector("#cfg-detail-codex").classList.contains("active")', 'Codex form');
    await click('#cfg-codex-profile-default-label');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.insertText', { text: '副账号·改' });
    await click('#account-config-save');
    await until('document.querySelector("#account-config-msg").textContent.includes("已保存")', 'config saved');
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(config.unrelatedFixture, 'preserve-me'); assert.ok(JSON.stringify(config).includes('副账号·改'));
    await snap('03-config');
    await click('[data-ac="back"]'); await click('[data-tab="ai"]');
    result.checks.push('CLI 原生授权和实际配置保存仍可用，保留无关配置');
    await click('.ac-connections>summary');
    await click('[data-ac="tools"]');
    await until('document.querySelector("[data-tool-choice]")', 'existing tool bindings discovered');
    await cdp.eval('document.querySelector("[data-tool-choice]").focus()');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await until('document.querySelector("[data-tool-choice]").value==="main"', 'selected shared identity');
    await click('[data-ac="tools-connect"]');
    await until('document.querySelector(".ac-tool-setup").textContent.includes("已统一接入")', 'tools bound', 60000);
    const bindings = JSON.parse(fs.readFileSync(path.join(chromeRoot, 'tool-bindings.json'), 'utf8'));
    assert.equal(bindings.tools[0].identity, 'main');
    result.checks.push('收起的工具连接仍能选择原账号并真实保存绑定，旧浏览器关闭使用夹具');
    await click('.ac-connections>summary');
    await click('[data-ac="close"]');
    assert.equal(await cdp.eval('document.querySelector("#account-page").hidden'), true);
    await click('#btn-rail-accounts');
    await until('!!document.querySelector(".ac-company")', 'reopen preserves workspace');
    const publicState = JSON.stringify(await cdp.eval('ipcRenderer.invoke("hub-accounts:state")'));
    assert.ok(!/SECRET|fixture-codex-key|fixture-deepseek-key/.test(publicState));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 680, height: 820, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 350, deltaY: -4000, deltaX: 0 });
    await sleep(300);
    assert.equal(await cdp.eval('document.querySelector(".ac-content").scrollWidth > document.querySelector(".ac-content").clientWidth'), false);
    await snap('04-narrow');
    assert.equal(await chrome.running(), false);
    result.checks.push('680px 窄窗口无水平溢出；关闭重开正常；公开状态不含凭据；全过程未启动官网浏览器');
    result.passed = true;
  } catch (e) { result.error = e.stack; if (cdp) { try { await snap('failure'); result.dom = await cdp.eval('document.body.innerText'); } catch {} } throw e; }
  finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { await chrome.close(); } catch {}
    if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
