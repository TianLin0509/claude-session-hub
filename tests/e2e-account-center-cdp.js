'use strict';
// Real isolated Hub GUI and IPC; website checks and opening use explicit fixtures.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
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
  queue.exec('CREATE TABLE accounts (id TEXT, config_dir TEXT, login_group TEXT); CREATE TABLE jobs (status TEXT)');
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
    assert.match(await text(main), /有登录记录/);
    assert.equal(await cdp.eval('document.querySelectorAll(".ac-launch").length'), 7);
    result.checks.push('公司分组、网页入口和账号信息；进入页面不启动浏览器');
    await snap('01-overview');
    await click('.ac-company[data-site="claude"] [data-ac="add"]');
    await until('document.querySelectorAll(".ac-company[data-site=claude] .ac-account").length===2', 'second Claude account');
    await click('.ac-company[data-site="claude"] [data-ac="preferred"][data-identity="alt"]');
    await until('document.querySelector(".ac-company[data-site=claude] [data-identity=alt] .ac-default")', 'default persisted');
    const prefs = JSON.parse(fs.readFileSync(path.join(chromeRoot, 'accounts.json'), 'utf8'));
    assert.equal(prefs.sites.claude.preferred, 'alt');
    await click('.ac-company[data-site="claude"] .ac-launch');
    await until('document.querySelector(".ac-status").textContent.includes("已在 AI Hub")', 'website open acknowledged');
    const opened = fs.readFileSync(path.join(home, 'accounts-open.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(opened[0], { site: 'claude', identity: 'alt', url: 'https://claude.ai/' });
    result.checks.push('添加第二账号、设为默认、打开网页：实际点击和 IPC 确认正确公司及身份（打开动作夹具）');
    await click('.ac-head-actions [data-ac="check"]');
    await until('document.querySelector(".ac-progress progress")?.value > 0 && document.querySelector("[data-ac=cancel]")', 'incremental progress');
    await snap('02-progress');
    await click('[data-ac="cancel"]');
    await until('document.querySelector(".ac-progress")?.textContent.includes("已取消")', 'cancelled with retained results');
    await click('.ac-head-actions [data-ac="check"]');
    await until('document.querySelector(".ac-progress")?.textContent.includes("检查完成")', 'full check finished');
    assert.match(await text('.ac-company[data-site="google"]'), /需要你完成验证/);
    assert.match(await text(main), /已登录/);
    assert.equal(await chrome.running(), false);
    result.checks.push('逐项进度、取消和结果保留；官网夹具的已登录和待验证状态如实展示');
    await snap('03-checked');
    const publicState = JSON.stringify(await cdp.eval('ipcRenderer.invoke("hub-accounts:state")'));
    assert.ok(!/SECRET|fixture-codex-key|fixture-deepseek-key/.test(publicState));
    await click('.ac-company[data-site="kimi"] summary');
    await click('[data-ac="authorize"][data-id="kimi"]');
    await until('document.querySelector(".ac-status").textContent.includes("官方登录入口已启动")', 'CLI authorization routed');
    assert.ok(fs.existsSync(path.join(home, 'fixture-login-kimi')));
    result.checks.push('CLI 授权按公司保留原入口；公开状态不含令牌');
    // API keys still have a home, and the general settings page does not overwrite them.
    await click('[data-ac="config"][data-id="codex"]'); await until('!document.querySelector("#account-editor").hidden', 'account config opened');
    await until('document.querySelector("#cfg-detail-codex").classList.contains("active")', 'Codex form');
    await cdp.eval('document.querySelector("#cfg-codex-profile-default-label").value="副账号·改"');
    await click('#account-config-save'); await until('document.querySelector("#account-config-msg").textContent.includes("已保存")', 'config saved');
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(config.unrelatedFixture, 'preserve-me'); assert.ok(JSON.stringify(config).includes('副账号·改'));
    await click('[data-ac="back"]'); await until('!!document.querySelector(".ac-company")', 'back to accounts');
    result.checks.push('接入配置（API Key 等）仍可编辑并真实保存，不影响其他配置项');

    // Keyboard shortcut uses the same selected-account open path.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', modifiers: 1, windowsVirtualKeyCode: 49 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', modifiers: 1, windowsVirtualKeyCode: 49 });
    await until('document.querySelector(".ac-status").textContent.includes("ChatGPT")', 'Alt+1 opens ChatGPT');
    const keyOpen = fs.readFileSync(path.join(home, 'accounts-open.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(keyOpen.site, 'chatgpt'); assert.equal(keyOpen.identity, 'main');
    await click('[data-ac="tools"]');
    await until('document.querySelector("[data-tool-choice]")', 'tool bindings discovered');
    // Native select driven by keyboard, not a backend bypass.
    await cdp.eval('document.querySelector("[data-tool-choice]").focus()');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await until('document.querySelector("[data-tool-choice]").value==="main"', 'selected shared ChatGPT identity');
    await click('[data-ac="tools-connect"]');
    await until('document.querySelector(".ac-tool-setup").textContent.includes("已统一接入")', 'tools bound', 60000);
    await until('document.querySelector(".ac-tool-list").textContent.includes("已接入")', 'actual tool connection badge updated');
    const bindings = JSON.parse(fs.readFileSync(path.join(chromeRoot, 'tool-bindings.json'), 'utf8'));
    assert.equal(bindings.tools[0].identity, 'main');
    assert.equal(JSON.parse(fs.readFileSync(path.join(laneConfig, 'settings.json'), 'utf8')).cli_entry, bindings.tools[0].entry);
    assert.equal(fs.existsSync(path.join(pool, 'stop-primary')), false);
    result.checks.push('Alt+1 键盘打开；真实选择工具账号并接入：配置、备份、绑定落盘（旧浏览器关闭为夹具）');
    await snap('04-tools-connected');

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal(await cdp.eval('document.querySelector("#account-page").hidden'), true);
    const s = await cdp.eval('ipcRenderer.invoke("create-session",' + JSON.stringify({ kind: 'codex', opts: { cwd, model: 'gpt-6-astra', effort: 'medium', mcpProfile: 'none' } }) + ')'); assert.ok(s.id, JSON.stringify(s));
    await click('.session-item[data-session-id="' + s.id + '"]'); await until('!!document.querySelector(".floating-input-box")', 'composer');
    await cdp.eval('document.querySelector(".floating-input-box").textContent="保留这份草稿"');
    await click('#btn-rail-accounts'); await until('!document.querySelector("#account-page").hidden', 'accounts during session'); await click('[data-ac="close"]');
    assert.equal(await cdp.eval('document.querySelector(".floating-input-box").textContent'), '保留这份草稿');
    await click('#btn-rail-accounts'); await click('#btn-rail-memory'); await until('!document.querySelector("#memory-page").hidden', 'memory opens');
    assert.equal(await cdp.eval('document.querySelector("#account-page").hidden'), true);
    result.checks.push('进出账号页保留会话草稿；与记忆页互斥');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 920, height: 820, deviceScaleFactor: 1, mobile: false });
    await click('#btn-rail-accounts'); await until('!!document.querySelector(".ac-company")', 'narrow');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 350, deltaY: -4000, deltaX: 0 });
    await sleep(300); await snap('05-narrow');
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
