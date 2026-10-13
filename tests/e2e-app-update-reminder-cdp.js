'use strict';
// 公司版新版本提醒（2026-10-13 用户：只弹窗提醒一次，之后「设置」出现红色未读标识，类似助理的红点；
// 右下角「国内正常 / 异常」删除）。
//   node tests/e2e-app-update-reminder-cdp.js [--out <截图目录>]
// 把当前工作区按公司目标导出到临时目录、以源码方式启动（node_modules 链接到本仓库的依赖，只读），
// 一个本机 http 服务冒充两个更新源，按需返回 v1.0.2 / v1.0.3。
//   ① 启动后静默查到 v1.0.2 → 自动弹出更新窗一次；设置按钮挂红点；标题栏不再出「有新版本」；
//   ② 点「稍后」关窗 → 红点还在；
//   ③ 重启（同一数据目录）→ 不再弹窗，红点还在；
//   ④ 打开设置菜单：「⬆️ 有新版本 v1.0.2」带红点 → 点开看到更新窗 → 红点消失；重启后也不再出现；
//   ⑤ 源上出现 v1.0.3 → 重启后再弹一次，红点重新出现；
//   ⑥ 右下角没有「国内正常 / 异常」，VPN / 直连那一项还在。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join('artifacts', '20261013-app-update-reminder-claude1'));
const repo = path.resolve(__dirname, '..');
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-reminder-'));
  const exportDir = path.join(root, 'export'), dataDir = path.join(root, 'data');
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
  const current = JSON.parse(fs.readFileSync(path.join(exportDir, 'community-edition.json'), 'utf8')).version;

  let served = '1.0.2';
  const asset = { file: 'AIHubHuawei-x-update.gz', bytes: 1024, sha256: '0'.repeat(64) };
  const server = http.createServer((req, res) => {
    if (/\/latest\.json$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(j({ schema: 1, product: 'AI HUB-Huawei', version: served, publishedAt: new Date().toISOString(), notes: [`v${served} 的更新说明`],
        runtime: { electron: '0.0.0', native: {} }, incremental: asset, installer: { file: 'AIHubHuawei-Setup-x.exe', bytes: 2048, sha256: '1'.repeat(64) } }));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sources = [{ id: 'github', name: 'GitHub', manifest: `${base}/github/latest.json`, files: `${base}/github/v{version}/` },
    { id: 'aliyun', name: '阿里云', manifest: `${base}/aliyun/latest.json`, files: `${base}/aliyun/v{version}/` }];

  const result = { checks: [], passed: false, current };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  let hub = null, c = null;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch (_) {} await _waitMs(250); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await _waitMs(300);
  };
  const dot = `document.getElementById('btn-options').classList.contains('update-has-unread') && getComputedStyle(document.querySelector('#btn-options .rail-utility-label'), '::after').content !== 'none'`;
  const dialogOpen = `!!document.querySelector('dialog.app-update-dialog[open]')`;
  const launch = async () => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'update-reminder', windowMode: 'hidden', entryPath: exportDir,
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_UPDATE_SOURCES: j(sources), AI_HUB_UPDATE_STARTUP_DELAY_MS: '1500',
        AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!window.__appUpdate', 'renderer', 90000);
  };
  const quit = async () => { try { c.close(); } catch (_) {} await gracefulQuit(hub).catch(() => {}); hub = null; };
  // 等静默检查做完（窗口没弹就看状态）。
  const waitChecked = version => until(`window.__appUpdate.state()?.latest?.version === ${j(version)}`, 'checked ' + version, 30000);

  try {
    // ① 首次查到 → 弹一次 + 红点
    await launch();
    await waitChecked('1.0.2');
    await until(dialogOpen, 'auto popup', 10000);
    const intro = await c.eval(`document.querySelector('.app-update-dialog').innerText`);
    check(intro.includes(`v${current}`) && /v1\.0\.2/.test(intro) && /v1\.0\.2 的更新说明/.test(intro), `启动后查到新版本，自动弹出更新窗（v${current} → v1.0.2，带更新说明）`);
    check(await c.eval(dot), '设置按钮同时挂上红点');
    check(!(await c.eval(`!!document.getElementById('hub-update-pill')`)), '标题栏不再出现「有新版本」小标签');
    await shot('01-popup');
    // ② 稍后
    await click('.app-update-dialog [data-au="close"]');
    await until(`!(${dialogOpen})`, 'closed', 5000);
    check(await c.eval(dot), '点「稍后」关掉后，设置按钮的红点还在');
    await shot('02-dot-after-later');
    // ⑥ 右下角
    const strip = await c.eval(`({ domestic: !!document.querySelector('.strip-route-domestic'), text: document.querySelector('.strip-network')?.innerText || '' })`);
    result.strip = strip;
    check(!strip.domestic && !/国内(正常|异常|检测中)/.test(strip.text) && /VPN|直连/.test(strip.text), '右下角没有「国内正常 / 异常」，VPN / 直连那一项还在');
    await quit();

    // ③ 重启：不再弹，红点还在
    await launch();
    await waitChecked('1.0.2');
    await _waitMs(1500);
    check(!(await c.eval(dialogOpen)), '重启后同一个版本不再弹窗');
    check(await c.eval(dot), '重启后红点还在');
    // ④ 设置菜单点开
    await click('#btn-options');
    await until(`getComputedStyle(document.getElementById('options-menu')).display !== 'none'`, 'menu', 10000);
    const item = await c.eval(`(()=>{const e=document.getElementById('options-check-update');return {text:e.textContent,unread:e.classList.contains('update-has-unread')};})()`);
    check(item.text.includes('有新版本 v1.0.2') && item.unread, '设置菜单里是「⬆️ 有新版本 v1.0.2」，带红点');
    await shot('03-menu');
    await click('#options-check-update');
    await until(dialogOpen, 'dialog from menu', 10000);
    check(!(await c.eval(dot)), '从设置里点开更新窗后，红点消失');
    await shot('04-opened-from-menu');
    await click('.app-update-dialog [data-au="close"]');
    await quit();
    await launch();
    await waitChecked('1.0.2');
    await _waitMs(1500);
    check(!(await c.eval(dialogOpen)) && !(await c.eval(dot)), '看过之后重启：不弹窗、也没有红点');
    await quit();

    // ⑤ 新的版本再提醒
    served = '1.0.3';
    await launch();
    await waitChecked('1.0.3');
    await until(dialogOpen, 'popup for 1.0.3', 10000);
    check(/v1\.0\.3/.test(await c.eval(`document.querySelector('.app-update-dialog').innerText`)) && await c.eval(dot), '源上出现 v1.0.3 后，重启再弹一次，红点重新出现');
    await shot('05-next-version');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1200)'); } catch (_) {} }
    if (hub) { try { result.hubLog = hub.log().slice(-40); } catch (_) {} }
  } finally {
    if (hub) await quit();
    server.close();
    try { execFileSync('cmd.exe', ['/c', 'rmdir', path.join(exportDir, 'node_modules')], { stdio: 'ignore' }); } catch (_) {}
    if (!fs.existsSync(path.join(exportDir, 'node_modules'))) fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
