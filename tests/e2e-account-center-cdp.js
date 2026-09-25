'use strict';
// The account page end to end in an isolated Hub: real Electron UI and IPC, real cookie
// store read from disk, real CLI token files, and a real (isolated) Hub Chrome launched by
// 登录. Proves the page's promises: two actions, checking never starts a browser, a login
// opens a window in the right identity, and nothing else on the page can start one.
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

  const out = path.resolve('artifacts/account-center-cdp'); fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, boundary: '真实隔离 Hub、DOM、IPC、磁盘 cookie 与 CLI 令牌文件；登录会在隔离目录启动一个真实 Chrome 并加载 1 个官网页面；不做任何真实登录', checks: [], root };
  let hub, cdp;
  const until = async (expr, label, ms = 35000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await cdp.eval('Boolean(' + expr + ')')) { console.log('PASS ' + label); return; } await sleep(150); } throw Error('timeout: ' + label); };
  const click = async selector => { await until('!!document.querySelector(' + JSON.stringify(selector) + ') && !document.querySelector(' + JSON.stringify(selector) + ').disabled', 'enabled ' + selector); const box = await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }); };
  const snap = async name => { const v = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(v.data, 'base64')); };
  const text = sel => cdp.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText||''`);
  const chrome = new HubChrome({ root: chromeRoot });
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), windowMode: 'visible', label: 'accounts-center', extraEnv: { CLAUDE_HUB_HOME_DIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AI_HUB_WORKSPACE_ROOT: root,
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'), CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'threads.json'),
      CLAUDE_HUB_ACCOUNT_FIXTURE: path.resolve('tests/fixtures/account-center-cli.js'),
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'empty') } });
    result.pid = hub.pid; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof accountCenterPanel!=="undefined"', 'renderer initialized');

    await click('#btn-rail-accounts'); await until('document.querySelectorAll(".ac-id").length===2', 'two identities');
    // Only two actions exist on the page (plus navigation and API-key configuration).
    const actions = await cdp.eval(`[...new Set([...document.querySelectorAll('#account-page [data-ac]')].map(b=>b.dataset.ac))].sort()`);
    assert.deepEqual(actions, ['authorize', 'back', 'check', 'close', 'config', 'login']);
    assert.match(await text('.ac-chrome'), /未运行/);
    const main = '.ac-id[data-identity="main"]';
    assert.match(await text(main + ' .ac-id-title'), /main@example\.com/);
    const chips = await cdp.eval(`[...document.querySelectorAll('${main} .ac-id-row:first-of-type .ac-chip')].map(c=>c.className.replace('ac-chip ','')+'|'+c.textContent)`);
    assert.ok(chips.includes('idle|ChatGPT · 有登录记录'), 'cookie presence never claims verified login: ' + chips);
    assert.ok(chips.includes('warn|Google · 需登录') && chips.includes('warn|千问 · 需登录') === false, 'cookie sites without a login ask for one; localStorage sites do not guess: ' + chips);
    assert.ok(chips.includes('idle|千问 · 待检查'));
    result.checks.push('网页提供登录/检查，CLI 提供独立授权；Cookie 只显示有记录，未知站点可点检查');

    // CLIs sit under the identity whose ChatGPT account they use; tokens never reach the page.
    const cli = sel => cdp.eval(`[...document.querySelectorAll('${sel} .ac-id-row:nth-of-type(2) .ac-chip')].map(c=>c.textContent)`);
    assert.deepEqual(await cli(main), ['Codex CLI（主账号） · 已配置 · 授权']);
    assert.ok((await text('.ac-unplaced')).includes('Codex CLI（副账号）'), 'signed-out web identity cannot borrow a cached email to place CLI');
    const publicState = JSON.stringify(await cdp.eval('ipcRenderer.invoke("hub-accounts:state")'));
    assert.ok(!/SECRET|fixture-codex-key|fixture-deepseek-key/.test(publicState), 'no token or key in what the page receives');
    result.checks.push('Codex 按已知邮箱归属；退出登录的网页不借用旧邮箱，未匹配 CLI 独立展示；页面无令牌或密钥');
    await snap('01-overview');
    await click('[data-ac="authorize"][data-id="kimi"]');
    await until('document.querySelector(".ac-status").textContent.includes("官方登录入口已启动")', 'CLI authorization routed');
    assert.ok(fs.existsSync(path.join(home, 'fixture-login-kimi')), 'Kimi button reaches its registered native connection');
    result.checks.push('CLI 授权按钮经过真实 IPC 到达对应原工具适配器（授权动作使用隔离夹具）');

    // 检查登录 must not start the browser.
    await click('[data-ac="check"]'); await until('document.querySelector(".ac-status").textContent.includes("已检查")', 'check finished', 90000);
    for (let i = 0; i < 40 && await chrome.running(); i++) await sleep(250);
    assert.equal(await chrome.running(), false, 'explicit check releases its temporary Chrome');
    result.checks.push('页面打开不启动浏览器；明确检查可临时打开一个共享 Chrome，结束后释放');

    // A login opens one ordinary window, in the right identity, at the site asked for.
    await click(`${main} .ac-chip[data-site="google"]`);
    await until('document.querySelector(".ac-status").textContent.includes("已打开 Hub 浏览器的登录窗口")', 'login acknowledged');
    // Google refuses sign-in in a browser with a debugging port, so a login is an ordinary
    // Chrome on the same profile: the profile is held, no debugging endpoint is offered, and
    // the launched command names the right identity and the site asked for.
    for (let i = 0; i < 40 && !chrome.profileHeld(); i++) await sleep(250);
    assert.equal(chrome.profileHeld(), true, 'the login started a Chrome on the Hub profile');
    assert.equal(await chrome.endpoint(), null, 'without a debugging port');
    const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object{$_.CommandLine -like '*${path.basename(root)}*' -and $_.CommandLine -notlike '*--type=*'}|Select-Object -First 1).CommandLine`], { encoding: 'utf8' });
    assert.match(cmd, /--profile-directory=main/); assert.match(cmd, /gemini\.google\.com/); assert.match(cmd, /--window-position=120,80/);
    assert.doesNotMatch(cmd, /remote-debugging/);
    await until('document.querySelector(".ac-chrome").textContent.includes("登录窗口开着")', 'page notices the login window');
    result.checks.push('点某个站点即以普通模式（无调试端口，Google 才允许登录）在对应身份、屏幕内打开该站登录页；页面如实显示"登录窗口开着"');
    await snap('02-login-opened');

    // API keys still have a home, and the general settings page does not overwrite them.
    await click('[data-ac="config"][data-id="codex"]'); await until('!document.querySelector("#account-editor").hidden', 'account config opened');
    await until('document.querySelector("#cfg-detail-codex").classList.contains("active")', 'Codex form');
    await cdp.eval('document.querySelector("#cfg-codex-profile-default-label").value="副账号·改"');
    await click('#account-config-save'); await until('document.querySelector("#account-config-msg").textContent.includes("已保存")', 'config saved');
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(config.unrelatedFixture, 'preserve-me'); assert.ok(JSON.stringify(config).includes('副账号·改'));
    await click('[data-ac="back"]'); await until('!!document.querySelector(".ac-id")', 'back to accounts');
    result.checks.push('接入配置（API Key 等）仍可编辑并真实保存，不影响其他配置项');

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
    await click('#btn-rail-accounts'); await until('!!document.querySelector(".ac-id")', 'narrow'); await snap('03-narrow');
    result.passed = true;
  } catch (e) { result.error = e.stack; if (cdp) { try { await snap('failure'); result.dom = await cdp.eval('document.body.innerText'); } catch {} } throw e; }
  finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { await chrome.close(); } catch {}
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object{$_.CommandLine -like '*${path.basename(root)}*'}|ForEach-Object{Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue}`]); } catch {}
    if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
