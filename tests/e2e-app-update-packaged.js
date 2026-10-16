'use strict';
// 公司版一键更新 · 打包版真实端到端（2026-10-13）。
//   node tests/e2e-app-update-packaged.js --build <公司版导出目录（已 npm run dist）> [--out <截图目录>]
//
// 「旧版本」= 把这次打出来的 win-unpacked 复制到临时目录，再把 app.asar 里的版本号改成 1.0.0
// （真正的 v1.0.0 没有一键更新功能，只能装一次 v1.0.1 完整包；之后的版本都走这里验证的路径）。
// 两个本机 http 服务冒充 GitHub 与阿里云，提供这次真正的增量包和 latest.json。
//   第 1 轮：GitHub 源返回 3.5 KB 拦截网页 → 界面写出原因并自动切到阿里云 → 下载校验 → 模拟替换失败
//           → 重启后提示「没有完成，已恢复原来的版本」，版本仍是 v1.0.0；
//   第 2 轮：重新打开，再更新一次（不模拟失败）→ 立即重启 → 替换脚本等程序退出、换文件、重新打开 →
//           标题与左上角显示 v1.0.1、产品名和「内测先锋版」，提示「已更新到 v1.0.1」，CodeAgent 卡片是智谱头像。
// 更新后的程序由替换脚本拉起，不是本测试的子进程：结束时用 CDP 关闭，再按端口 + 可执行文件路径确认退出。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const build = path.resolve(arg('--build') || '');
const out = path.resolve(arg('--out') || path.join('artifacts', '20261013-app-update-packaged-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function patchVersion(resources, version) {
  const asar = require(path.join(build, 'node_modules', '@electron', 'asar'));
  const asarFile = path.join(resources, 'app.asar');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-asar-'));
  asar.extractAll(asarFile, tmp);
  for (const rel of ['package.json', 'community-edition.json']) {
    const file = path.join(tmp, rel);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.version = version;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  const unpacked = [];
  const walk = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), r); else unpacked.push(r); } };
  walk(path.join(resources, 'app.asar.unpacked'), '');
  return asar.createPackageWithOptions(tmp, asarFile, { unpack: `{${unpacked.join(',')}}` }).then(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

async function main() {
  assert.ok(fs.existsSync(path.join(build, 'dist', 'win-unpacked')), '需要 --build 指向已打包的公司版导出目录');
  const latest = JSON.parse(fs.readFileSync(path.join(build, 'dist', 'latest.json'), 'utf8'));
  const payload = fs.readFileSync(path.join(build, 'dist', latest.incremental.file));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-app-update-e2e-'));
  const install = path.join(root, 'install'), dataDir = path.join(root, 'data');
  // robocopy 的退出码小于 8 都算成功（1 = 复制了文件）。
  const copy = require('child_process').spawnSync('robocopy', [path.join(build, 'dist', 'win-unpacked'), install, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' });
  if (copy.status === null || copy.status >= 8) throw Error('复制安装目录失败，robocopy 退出码 ' + copy.status);
  await patchVersion(path.join(install, 'resources'), '1.0.0');
  const exe = path.join(install, fs.readdirSync(install).find(f => /\.exe$/i.test(f) && !/uninstall|elevate/i.test(f)));

  // 两个冒充的源：GitHub 的增量包返回拦截网页，阿里云正常；限速到约 4 MB/s，界面上看得到进度。
  const blockPage = Buffer.from('<!DOCTYPE html><html><head><title>Access Denied</title></head><body>访问被拒绝：该站点类别受限。</body></html>' + ' '.repeat(3300));
  const log = [];
  const server = http.createServer((req, res) => {
    log.push(req.url);
    const m = /^\/(github|aliyun)\/(latest\.json|v[\d.]+\/(.+))$/.exec(req.url);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    if (m[2] === 'latest.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(latest)); return; }
    if (decodeURIComponent(m[3]) !== latest.incremental.file) { res.writeHead(404); res.end('not found'); return; }
    if (m[1] === 'github') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': blockPage.length }); res.end(blockPage); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
    let offset = 0;
    const pump = () => { if (offset >= payload.length) { res.end(); return; } res.write(payload.subarray(offset, offset + 256 * 1024)); offset += 256 * 1024; setTimeout(pump, 60); };
    pump();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sources = [{ id: 'github', name: 'GitHub', manifest: `${base}/github/latest.json`, files: `${base}/github/v{version}/` },
    { id: 'aliyun', name: '阿里云', manifest: `${base}/aliyun/latest.json`, files: `${base}/aliyun/v{version}/` }];
  const result = { checks: [], passed: false, install, exe };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  let hub = null, c = null, port = null;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch (_) {} await _waitMs(250); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await _waitMs(300);
  };
  const launch = async extraEnv => {
    port = await freePort();
    hub = await launchIsolatedHub({ dataDir, port, label: 'app-update', executablePath: exe, windowMode: 'background',
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_UPDATE_SOURCES: j(sources), AI_HUB_UPDATE_STARTUP_DELAY_MS: '1500', ...extraEnv } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!window.__appUpdate', 'renderer', 90000);
  };
  // 替换脚本重新拉起的程序：等同一端口再次可连。
  const reconnect = async () => {
    try { c.close(); } catch (_) {}
    // 先等旧进程真正退出，否则会连到正在关闭的旧窗口。
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    const quitBy = Date.now() + 60000;
    while (hub && hub.pid && alive(hub.pid)) { if (Date.now() > quitBy) throw Error('old Hub did not exit after apply'); await _waitMs(250); }
    const end = Date.now() + 120000;
    for (;;) {
      try { c = await connectFirstPage({ cdpHttpBase: `http://127.0.0.1:${port}`, label: 'relaunched' }); await c.eval('1'); break; }
      catch (error) { if (Date.now() > end) throw Error('relaunched Hub not reachable on port ' + port); await _waitMs(500); }
    }
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!window.__appUpdate', 'relaunched renderer', 90000);
  };
  const closeRelaunched = async () => {
    try {
      const version = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/json/version`, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
      const browser = await connectCDP(version.webSocketDebuggerUrl);
      await browser.send('Browser.close').catch(() => {});
    } catch (_) {}
    await _waitMs(3000);
    // 仍在监听这个端口、且可执行文件在本测试临时目录里的进程，才是本测试拉起的，确认退出。
    const owner = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8' }).trim();
    if (owner) {
      const procPath = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${owner} -ErrorAction SilentlyContinue).Path`], { encoding: 'utf8' }).trim();
      if (procPath && path.resolve(procPath).toLowerCase().startsWith(install.toLowerCase())) execFileSync('taskkill', ['/PID', owner, '/T', '/F'], { stdio: 'ignore' });
    }
  };
  const runUpdate = async tag => {
    await until(`!!document.getElementById('hub-update-pill')`, 'update pill', 60000);
    check(/有新版本 v1\.0\.1/.test(await c.eval(`document.getElementById('hub-update-pill').textContent`)), `${tag}：启动后静默查到新版本，标题栏出现「有新版本 v1.0.1」，没有弹窗打断`);
    await shot(`${tag}-01-pill`);
    await click('#hub-update-pill');
    await until(`!!document.querySelector('.app-update-dialog [data-au="download"]')`, 'dialog');
    const intro = await c.eval(`document.querySelector('.app-update-dialog').innerText`);
    check(/v1\.0\.0/.test(intro) && /v1\.0\.1/.test(intro) && /程序更新（不含运行库） · 7\.\d MB/.test(intro) && /CodeAgent 回答卡片显示智谱头像/.test(intro), `${tag}：弹窗显示 v1.0.0 → v1.0.1、增量包大小和发布说明`);
    await shot(`${tag}-02-dialog`);
    await click('.app-update-dialog [data-au="download"]');
    await until(`!!document.querySelector('.app-update-dialog .au-progress') && /阿里云/.test(document.querySelector('.app-update-dialog .au-section')?.textContent||'')`, 'downloading from aliyun', 30000);
    await _waitMs(400);
    await shot(`${tag}-03-downloading`);
    await until(`!!document.querySelector('.app-update-dialog [data-au="apply"]')`, 'ready', 120000);
    const sourcesText = await c.eval(`[...document.querySelectorAll('.app-update-dialog .au-sources li')].map(li=>li.innerText.replace(/\\s+/g,' ')).join(' | ')`);
    result[tag + 'Sources'] = sourcesText;
    check(/GitHub 失败：收到 3\.\d KB 的网页而不是更新包，可能被公司代理拦截/.test(sourcesText) && /阿里云 下载完成并校验通过/.test(sourcesText), `${tag}：GitHub 返回拦截页时写明原因并自动切到阿里云，下载校验通过`);
    await shot(`${tag}-04-ready`);
    await click('.app-update-dialog [data-au="apply"]');
  };

  try {
    // 第 1 轮：模拟替换失败 → 回滚
    await launch({ AI_HUB_UPDATE_SIMULATE_FAILURE: '模拟：替换后最后一步出错' });
    await until(`document.getElementById('hub-version').textContent === 'v1.0.0'`, 'old version shown', 30000);
    check(true, '旧版本左上角显示 v1.0.0');
    await runUpdate('round1');
    await reconnect();
    await until(`!!document.querySelector('.au-toast')`, 'rollback toast', 30000);
    const toast1 = await c.eval(`document.querySelector('.au-toast').innerText`);
    check(/没有完成，已恢复原来的版本/.test(toast1) && /模拟/.test(toast1), '第 1 轮：替换失败自动回滚，重启后提示原因');
    await until(`/v1\\.0\\.0/.test(document.getElementById('hub-version').textContent)`, 'still 1.0.0', 30000);
    check(true, '第 1 轮：回滚后仍是 v1.0.0，程序正常打开');
    await shot('round1-05-rolled-back');
    await closeRelaunched();
    try { await gracefulQuit(hub); } catch (_) {}

    // 第 2 轮：正常更新
    await launch({});
    await runUpdate('round2');
    await reconnect();
    await until(`!!document.querySelector('.au-toast')`, 'success toast', 30000);
    check(/已更新到 v1\.0\.1/.test(await c.eval(`document.querySelector('.au-toast').innerText`)), '第 2 轮：重启后提示「已更新到 v1.0.1」');
    await until(`document.getElementById('hub-version').textContent === 'v1.0.1'`, 'version 1.0.1', 30000);
    const brand = await c.eval(`({ name: document.querySelector('#hub-identity strong').textContent, badge: document.getElementById('hub-edition-badge')?.textContent, title: document.title })`);
    result.brand = brand;
    check(brand.name === 'AI HUB-Huawei' && brand.badge === '内测先锋版', '更新后左上角是「AI HUB-Huawei」+「内测先锋版」，版本 v1.0.1');
    await shot('round2-05-updated');
    // CodeAgent 回答卡片头像（Claude 格式记录里回合 kind 是 claude）
    const avatar = await c.eval(`(async () => {
      const sid = 'codeagent-avatar-e2e';
      sessions.set(sid, { id: sid, kind: 'codeagent', title: 'CodeAgent 头像', status: 'idle', createdAt: Date.now(), lastMessageTime: Date.now() });
      activeMeetingId = null; activeSessionId = sid; currentView = 'card';
      document.getElementById('terminal-panel').style.display = ''; document.getElementById('terminal-panel').classList.remove('home-active');
      const empty = document.getElementById('empty-state'); if (empty) empty.style.display = 'none';
      const overlay = document.getElementById('msg-overlay'); overlay.innerHTML = ''; overlay.classList.remove('hidden');
      window._sessionTurns.clear();
      window._mountSessionTurnCard(sid, { id: 'q1', role: 'user', kind: 'claude', text: '你好', ts: Date.now() }, { kind: 'codeagent' });
      window._mountSessionTurnCard(sid, { id: 'a1', role: 'assistant', kind: 'claude', model: 'GLM-5.2', text: '你好，我是 CodeAgent。', ts: Date.now() + 1 }, { kind: 'codeagent' });
      const img = overlay.querySelector('.turn-card.assistant .turn-avatar img');
      if (!img) return { missing: true };
      if (!img.complete) await new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 5000); });
      return { src: img.getAttribute('src'), width: img.naturalWidth };
    })()`);
    result.avatar = avatar;
    check(avatar.src === 'assets/ai-avatars/cel-v2/glm.png' && avatar.width > 0, '更新后 CodeAgent 回答卡片是智谱头像，图片正常加载');
    await shot('round2-06-avatar');
    // 设置菜单里的「检查更新」：已是最新
    await click('#btn-options');
    await until(`getComputedStyle(document.getElementById('options-menu')).display !== 'none' && !!document.getElementById('options-check-update')`, 'options menu', 10000);
    await click('#options-check-update');
    await until(`/已是最新版本 v1\\.0\\.1/.test(document.querySelector('.app-update-dialog')?.innerText || '')`, 'up to date', 30000);
    check(true, '设置菜单「检查更新」：更新后显示「已是最新版本 v1.0.1」，两个源都可用');
    await shot('round2-07-up-to-date');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1200)'); } catch (_) {} }
    if (hub) { try { result.hubLog = hub.log().slice(-40); } catch (_) {} }
    try { result.updateDir = fs.readdirSync(path.join(dataDir, 'app-update')); result.lastResult = fs.readFileSync(path.join(dataDir, 'app-update', 'last-result.json.seen'), 'utf8'); } catch (_) {}
  } finally {
    try { c && c.close(); } catch (_) {}
    if (port) await closeRelaunched().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
    result.requests = log.slice(0, 40);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
