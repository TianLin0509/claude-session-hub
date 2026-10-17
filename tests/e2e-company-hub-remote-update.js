'use strict';
// 家里远程让公司 Hub 更新（2026-10-17，core/company-bridge/hub-admin.js）真实端到端：
//   node tests/e2e-company-hub-remote-update.js [--out <截图目录>]
// 两台隔离 Hub：家里 = 当前工作区源码（角色 home）；公司 = 当前工作区按公司目标导出、以源码方式启动（真的公司一端 + 真的一键更新控制器）。
// 中间是真实的任务通道服务（company-drop 的 relay_server.py）；本机 http 服务冒充更新源，提供 latest.json 和一个真的增量包。
// 开发运行没有 app.asar：AI_HUB_UPDATE_RESOURCES 指向临时的「resources」目录（里面一个旧 app.asar），
// AI_HUB_UPDATE_FORCE_APPLY=1 让开发运行也能走替换脚本。流程全按真实路径：
//   家里无线页「公司联动」点「让公司 Hub 更新」→ 通道 → 公司查版本、下载校验、没有在途任务 → 报「即将重启」→ apply
//   → 替换脚本等公司进程退出、换掉 app.asar、写结果、重新拉起公司 Hub → 新进程接通通道后报「已更新到 vX」→ 家里通知与面板。
// 差距：替换的是临时目录里的 app.asar，不是导出目录本身，所以重启后公司 Hub 显示的版本号不变（真包换版本见 e2e-app-update-packaged.js）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const { packPayload } = require('../core/app-update/payload');

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261017-company-hub-remote-update-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sha = buf => createHash('sha256').update(buf).digest('hex');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-remote-update-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, checks: [], scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务 + 本机更新源 + 真实替换脚本与重启' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, server, home, company, hc, cc, cport;
  try {
    // ---- 公司版导出（源码方式运行） ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    const current = JSON.parse(fs.readFileSync(path.join(exportDir, 'community-edition.json'), 'utf8')).version;
    const next = current.split('.').map((x, i) => (i === 2 ? String(Number(x) + 1) : x)).join('.');
    log(`公司版导出完成：v${current}，更新源提供 v${next}`);

    // ---- 「resources」目录：旧 app.asar；新版增量包里是新的 app.asar ----
    const res = path.join(root, 'resources'), newRes = path.join(root, 'new-resources');
    fs.mkdirSync(res, { recursive: true }); fs.mkdirSync(newRes, { recursive: true });
    const oldAsar = randomBytes(16384), newAsar = randomBytes(24576);
    fs.writeFileSync(path.join(res, 'app.asar'), oldAsar); fs.writeFileSync(path.join(newRes, 'app.asar'), newAsar);
    const payloadName = `AIHubHuawei-${next}-update.gz`;
    const packed = packPayload(newRes, path.join(root, payloadName));
    const payload = fs.readFileSync(packed.file);
    const electronVersion = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
    const latest = { schema: 1, product: 'AI HUB-Huawei', version: next, publishedAt: new Date().toISOString(), notes: [`v${next}：远程更新端到端测试`],
      runtime: { electron: electronVersion, native: {} }, incremental: { file: payloadName, bytes: packed.bytes, sha256: packed.sha256 },
      installer: { file: `AIHubHuawei-Setup-${next}.exe`, bytes: 4096, sha256: '1'.repeat(64) } };
    const requests = [];
    server = http.createServer((req, res2) => {
      requests.push(req.url);
      if (req.url === '/aliyun/latest.json') { res2.writeHead(200, { 'content-type': 'application/json' }); res2.end(j(latest)); return; }
      if (req.url === `/aliyun/v${next}/${payloadName}`) { res2.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length }); res2.end(payload); return; }
      res2.writeHead(404); res2.end('not found');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sources = [{ id: 'aliyun', name: '阿里云', manifest: `${base}/aliyun/latest.json`, files: `${base}/aliyun/v{version}/` }];

    // ---- 通道服务 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    // ---- 公司一端：本机已解锁过隐藏入口（口令不进仓库；配对过的电脑本来也算解锁） ----
    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') };
    cport = await freePort();
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'ru-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0' } }),
      launchIsolatedHub({ dataDir: cdata, port: cport, windowMode: 'background', label: 'ru-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_UPDATE_SOURCES: j(sources), AI_HUB_UPDATE_FORCE_APPLY: '1',
          AI_HUB_UPDATE_RESOURCES: res, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); log('截图 ' + path.join(out, name + '.png')); };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    await until('renderers', async () => (await hc.eval('typeof window.__wirelessHide==="function"')) && (await cc.eval('typeof sessions!=="undefined"')), 90000, 300);
    const cs0 = await status(cc);
    check(cs0.role === 'company' && cs0.unlocked && cs0.settings.allowRemoteAdmin === true, '公司版导出：公司一端已启用，「远程更新」默认允许');

    // ---- 配对（IPC，与界面按钮同一入口） ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    check(true, '家里与公司配对接通');
    await until('company version announced', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return (await status(hc)).companyHub.version === current; }, 90000, 3000);
    check(true, `公司 Hub 接通后报了版本 v${current}，家里面板能显示`);

    // ---- 家里在无线页「公司联动」点「让公司 Hub 更新」 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await hc.eval('document.getElementById("btn-toggle-navigation").click()');
    await hc.eval('document.getElementById("btn-wireless").click()');
    await until('hub row', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=hub-update]")'), 20000, 300);
    const rowText = await hc.eval('document.querySelector(".cl-hub").innerText');
    check(rowText.includes('v' + current) && /上次在线/.test(rowText), '家里面板显示「公司 Hub：v' + current + ' · 上次在线 …」');
    await hc.eval('document.querySelector(".cl-hub").scrollIntoView({block:"center"})');
    await shot(hc, '01-home-panel-before');
    await hc.eval('window.confirm = () => true');
    const p = await hc.eval('(()=>{const r=document.querySelector("[data-cl=hub-update]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    for (const type of ['mousePressed', 'mouseReleased']) await hc.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    const cmd = await until('command sent', async () => ((await hc.eval('require("electron").ipcRenderer.invoke("bridge:status")')).companyHub.pending || [])[0], 15000, 300);
    check(/^HA-/.test(cmd), '点按钮发出远程更新指令 ' + cmd);

    // ---- 公司：收指令 → 查 → 下载 → 即将重启（等公司自己的定时器，不手动触发） ----
    const companyPid = company.pid;
    const phasesHome = async () => ((await status(hc)).companyHub.recent || []).filter(x => x.id === cmd).map(x => x.phase);
    await until('restarting reported', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return (await phasesHome()).includes('restarting'); }, 180000, 3000);
    const before = (await status(hc)).companyHub.recent.filter(x => x.id === cmd);
    result.beforeRestart = before;
    check(before.some(x => x.phase === 'downloading' && x.note.includes('v' + next)) && before.some(x => x.phase === 'downloaded'), `家里收到「开始下载 v${next}」「已下载 v${next}，校验通过」`);
    check(requests.includes('/aliyun/latest.json') && requests.includes(`/aliyun/v${next}/${payloadName}`), '公司从本机更新源取了清单和增量包');

    // ---- 替换脚本：等公司进程退出、换 app.asar、重新拉起 ----
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until('company exited', async () => !alive(companyPid), 60000, 500);
    check(true, '公司 Hub 进程按指令退出（apply 已调用）');
    await until('asar replaced', async () => sha(fs.readFileSync(path.join(res, 'app.asar'))) === sha(newAsar), 120000, 1000);
    check(true, '替换脚本把 resources 里的 app.asar 换成了新版本（sha256 一致）');
    try { cc.close(); } catch {}
    // 替换脚本拉起的进程不是本测试的子进程：失败时留下进程清单便于定位。
    const procs = () => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(root)}*' } | ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine) -join ' ' }`], { encoding: 'utf8', windowsHide: true }).trim(); } catch (e) { return 'ERR ' + e.message; } };
    await _waitMs(3000);
    result.procsAfterReplace = procs(); log('替换后相关进程：' + result.procsAfterReplace.replace(/\s+/g, ' ').slice(0, 1500));
    cc = await until('relaunched company', async () => { const c = await connectFirstPage({ cdpHttpBase: `http://127.0.0.1:${cport}`, label: 'ru-company-relaunched' }, x => x.type === 'page' && /renderer\/index\.html/.test(x.url)); await c.eval('1'); return c; }, 120000, 1000);
    await until('relaunched renderer', () => cc.eval('typeof sessions!=="undefined"'), 90000, 500);
    check(true, '替换脚本重新拉起了公司 Hub（同一数据目录、同一调试端口）');

    // ---- 新进程报结果 → 家里 ----
    const final = await until('updated reported', async () => {
      await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")');
      return ((await status(hc)).companyHub.recent || []).find(x => x.id === cmd && ['updated', 'rolled-back', 'failed'].includes(x.phase));
    }, 180000, 3000);
    result.final = final;
    check(final.phase === 'updated' && final.note === `公司 Hub 已更新到 v${next}`, `家里收到「公司 Hub 已更新到 v${next}」`);
    const cst = await status(cc);
    check(cst.hubAdmin.job.phase === 'updated' && cst.link.state === 'paired', '重启后公司一端仍是配对状态，指令记为已完成');
    await hc.eval('document.querySelector(".cl-hub")?.scrollIntoView({block:"center"})');
    await until('panel shows result', () => hc.eval(`(document.querySelector(".cl-hub")?.innerText||"").includes(${j('已更新到 v')} + ${j(next)})`), 20000, 500);
    await shot(hc, '02-home-panel-updated');
    // 公司设置里的「远程更新」一行
    await cc.eval('window.__homeLinkOpen && window.__homeLinkOpen()');
    await until('company dialog', () => cc.eval('!!document.querySelector("[data-hl-f=allowRemoteAdmin]")'), 20000, 500);
    await cc.eval('document.querySelector("[data-hl-f=allowRemoteAdmin]").scrollIntoView({block:"center"})');
    await shot(cc, '03-company-settings-remote-admin');
    check(/已更新到 v/.test(await cc.eval('document.querySelector("[data-hl-f=allowRemoteAdmin]").parentElement.innerText')), '公司设置页「远程更新」一行显示最近一次结果');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    try { result.homeLog = home && home.log().slice(-30); } catch {}
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    // 重新拉起的公司 Hub 不是本测试的子进程：经它自己的调试端口关闭（端口是本测试独占的）。
    if (cport) {
      try {
        const version = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${cport}/json/version`, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
        const browser = await connectCDP(version.webSocketDebuggerUrl);
        await browser.send('Browser.close').catch(() => {});
      } catch {}
    }
    if (company) await gracefulQuit(company).catch(() => {});
    try { relay && relay.kill(); } catch {}
    try { server && server.close(); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
