'use strict';
// 直查通道（2026-10-18，core/company-bridge/diag.js）真实端到端：
//   node tests/e2e-company-diag.js [--out <截图目录>]
// 两台隔离 Hub：家里 = 当前工作区源码；公司 = 当前工作区按公司目标导出、以源码方式启动。中间是真实的通道服务（relay_server.py，绑 localhost）。
// 公司电脑上的进程是真的：Hub 里开一个 PowerShell 会话、在里面跑一个命令行带 codeagent 字样的 node（Hub 进程树里的「CodeAgent」），
// 测试进程自己再起一个同样的 node（不在 Hub 进程树里的「残留」）。号池放一个带备注的号、个人账号带工号，日志里埋令牌。
// 流程：家里无线页「公司联动」点「公司电脑状态」→ 通道 → 公司主进程直接采集（真实 Get-CimInstance）→ 压缩回报 → 卡片显示；
// 再查一次（30 秒内）→ 公司回「30 秒内只查一次」；过 30 秒再查 → 计时（公司此时按 10 秒检查通道）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261018-company-diag-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const LEAKS = ['abc123', '张三的号', 'w00123456', 'w001****56', 'w00999888', 'w009****88', 'SECRETTOKEN', 'AIHUB-LINK-1.eyJ'];

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-company-diag-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, checks: [], timings: {}, scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务（localhost）+ 真实进程枚举' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc, outsider, intreePid = null;
  try {
    // ---- 公司版导出 ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    check(fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'diag.js')) && !fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'home.js'))
      && !fs.existsSync(path.join(exportDir, 'renderer', 'company-diag-card.js')) && !fs.existsSync(path.join(exportDir, 'scripts', 'company-ask.js')), '公司版导出：带公司侧 diag.js，不带家里侧 home.js / 卡片 / company-ask.js');

    // ---- 通道服务 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    // ---- 公司数据：已解锁；号池一个带备注的号；个人账号带工号；日志里埋令牌 ----
    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data'), cac = path.join(root, 'cac');
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    const future = Date.now() + 7 * 86400000;
    fs.mkdirSync(path.join(cdata, 'codeagent-pool', 'accounts', 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(cdata, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: 'abc123', note: '张三的号', createdAt: Date.now() }] }));
    fs.writeFileSync(path.join(cdata, 'codeagent-pool', 'accounts', 'abc123', '.credentials.json'), j({ idaasOAuth: { accountId: 'w00123456', xAuthExpires: future } }));
    fs.mkdirSync(cac, { recursive: true });
    fs.writeFileSync(path.join(cac, '.credentials.json'), j({ idaasOAuth: { accountId: 'w00999888', xAuthExpires: future } }));
    fs.mkdirSync(path.join(cdata, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(cdata, 'logs', 'company-bridge.log'), Array.from({ length: 30 }, (_, i) => `2026-10-18T08:00:${String(i).padStart(2, '0')}.000Z route Q-1018-0${i % 9} account=w001****56（张三的号） token=SECRETTOKEN${i} pair AIHUB-LINK-1.eyJ1IjoiaHR0cHM6Ly9leGFtcGxl`).join('\n') + '\n');

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'diag-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0' } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'diag-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
          AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]), AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); log('截图 ' + f); return f; };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    await until('renderers', async () => (await hc.eval('typeof window.__wirelessHide==="function"')) && (await cc.eval('typeof sessions!=="undefined"')), 90000, 300);

    // ---- 公司 Hub 里的会话：PowerShell 里跑一个命令行带 codeagent 的 node（Hub 进程树里）----
    const ps = await cc.eval('require("electron").ipcRenderer.invoke("create-session", { kind: "powershell", opts: { title: "diag-probe-shell" } })');
    check(ps && ps.id, '公司 Hub 里开了一个 PowerShell 会话 ' + (ps && ps.id));
    await _waitMs(3000);
    await cc.eval(`require("electron").ipcRenderer.send("terminal-input", { sessionId: ${j(ps.id)}, data: 'node -e "setInterval(()=>{},1e9)" codeagent-diag-intree-probe\\r' })`);
    // 「重启残留」：一个中间进程起一个脱离的 node 后自己退出——父进程不在了，也不在任何 Hub 进程树里（同公司重启后留下的 CodeAgent）
    const spawner = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e9)','codeagent-diag-outside-probe'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();process.stdout.write(String(c.pid))";
    outsider = { pid: Number(execFileSync(process.execPath, ['-e', spawner], { encoding: 'utf8', windowsHide: true }).trim()) };
    log('残留 node PID：' + outsider.pid);
    await _waitMs(2000);

    // ---- 配对 ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    check(true, '家里与公司配对接通');
    await until('company version announced', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return !!(await status(hc)).companyHub.version; }, 120000, 3000);
    const cpoll = (await status(cc)).polling;
    result.companyPollingBefore = cpoll;
    log(`公司此刻检查通道：每 ${cpoll.intervalSeconds} 秒（${cpoll.active ? '活跃' : '空闲'}）`);

    // ---- 家里在无线页「公司联动」点「公司电脑状态」 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await hc.eval('document.getElementById("btn-toggle-navigation").click()');
    await hc.eval('document.getElementById("btn-wireless").click()');
    await until('diag button', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=diag]")'), 20000, 300);
    await hc.eval('document.querySelector("[data-cl=diag]").scrollIntoView({block:"center"})');
    const p = await hc.eval('(()=>{const r=document.querySelector("[data-cl=diag]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    const clickAt = Date.now();
    for (const type of ['mousePressed', 'mouseReleased']) await hc.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await until('waiting card', () => hc.eval('!!document.querySelector("dialog.cl-diag[open] .cl-diag-wait")'), 10000, 200);
    await shot(hc, '01-card-waiting');
    await until('card result', () => hc.eval('(document.querySelector("dialog.cl-diag[open] .cl-diag-body")?.innerText||"").includes("内存都去哪了")'), 90000, 500);
    result.timings.firstMs = Date.now() - clickAt;
    check(true, `点按钮到卡片显示结果 ${(result.timings.firstMs / 1000).toFixed(1)} 秒（公司当时每 ${cpoll.intervalSeconds} 秒检查通道）`);
    await hc.eval('document.querySelector("dialog.cl-diag .cl-diag-body").scrollTop = 0');
    result.shots = [await shot(hc, '02-card-result')];
    await hc.eval('(()=>{const d=document.querySelector("dialog.cl-diag");d.scrollTop=d.scrollHeight*0.45})()');
    result.shots.push(await shot(hc, '03-card-result-middle'));

    // ---- 回报内容 ----
    const view = await hc.eval('require("electron").ipcRenderer.invoke("bridge:diag-result", {})');
    result.firstView = { id: view.id, status: view.status, waitedSec: view.waitedSec, elapsedMs: view.elapsedMs, bytes: view.bytes, degraded: view.degraded, summary: view.summary };
    fs.writeFileSync(path.join(out, 'diag-view.json'), JSON.stringify(view, null, 1));
    const d = view.diag;
    check(view.status === '已回报' && view.bytes > 0 && view.bytes < 60000, `回报一条消息 ${view.bytes} 字节（< 60000），公司采集 ${view.elapsedMs} 毫秒`);
    check(d.machine.memory.totalMB > 0 && d.machine.memory.freePct >= 0 && d.machine.cpu.cores > 0 && d.machine.disks.some(x => x.drive === 'C:' && x.freeGB > 0) && d.machine.uptimeHours > 0, '电脑：内存、CPU、开机时长、C 盘剩余都有');
    const companyPid = company.pid;
    check(d.processes.hubFound && d.processes.summary.hubSelf.count >= 2 && d.processes.summary.hubSelf.memMB > 0 && d.processes.top.length === 20, `进程：前 20、Hub 自身 ${d.processes.summary.hubSelf.count} 个进程 ${d.processes.summary.hubSelf.memMB} MB（真实 Win32_Process）`);
    const leftover = d.processes.leftovers.find(x => x.pid === outsider.pid);
    check(leftover && leftover.kind === 'codeagent' && leftover.hint === 'CodeAgent' && leftover.parentAlive === false && d.processes.leftovers[0].kind === 'codeagent', `树外残留嫌疑认出父进程已退出的 node（PID ${outsider.pid}），CodeAgent 类排最前`);
    // 环境里另有正在运行的 Hub（家里这台隔离 Hub；跑测试的电脑上还有生产 Hub）：一律归「别的 Hub」，不进残留
    const otherPids = (d.processes.otherHubs || []).map(x => x.pid);
    check(otherPids.includes(home.pid) && !d.processes.leftovers.some(x => x.pid === home.pid)
      && d.processes.leftovers.every(x => ['codeagent', 'node', 'electron-helper'].includes(x.kind) && x.parentAlive === false)
      && !d.processes.leftovers.some(x => otherPids.includes(x.pid)),
      `正在运行的别的 Hub（家里隔离 Hub PID ${home.pid} 等 ${otherPids.length} 个主进程）归「别的 Hub」，没有一个进残留；残留只有父进程不在的 CodeAgent / node / 孤立 Electron 子进程`);
    check(d.processes.summary.codeAgent.inHub >= 1 && d.processes.summary.codeAgent.outside >= 1 && !d.processes.leftovers.some(x => x.pid === companyPid), `CodeAgent：Hub 会话里 ${d.processes.summary.codeAgent.inHub} 个、树外 ${d.processes.summary.codeAgent.outside} 个；公司 Hub 主进程不在残留里`);
    const sess = d.hub.sessions.list.find(s => s.title === 'diag-probe-shell');
    check(sess && sess.state === 'active' && sess.pid > 0 && sess.memMB > 0 && sess.processes >= 2, `Hub 会话列表对上了 PID ${sess && sess.pid} 与内存 ${sess && sess.memMB} MB（含会话里的 node）`);
    // 会话里起的 node：按会话终端 PID 的子进程找（测试收尾时按这个 PID 结束）
    try { intreePid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(sess.pid)} AND Name='node.exe'" | Select-Object -First 1).ProcessId`], { encoding: 'utf8', windowsHide: true }).trim()) || null; } catch { intreePid = null; }
    log('会话里的 node PID：' + intreePid);
    check(d.hub.parallel && Number.isInteger(d.hub.parallel.cap) && typeof d.hub.parallel.limitedBy === 'string' && d.hub.queue && Array.isArray(d.hub.queue.threads), `并行与队列：上限 ${d.hub.parallel.cap}（受${d.hub.parallel.limitedBy}限制），队列快照在`);
    check(d.pool.accounts.map(a => a.alias).join(',') === '个人,号 1' && d.pool.accounts.every(a => a.state === '可用'), '号池只用「个人 / 号 1」代称');
    const blog = d.logs.files.find(f => f.key === 'bridge');
    check(blog && blog.lines.length === 30 && blog.lines.every(l => /token=<已隐去>/.test(l) && /AIHUB-LINK-1\.<已隐去>/.test(l)), '通道日志 30 行带回、令牌与配对码已隐去');
    const text = JSON.stringify(view);
    const leaks = LEAKS.filter(s => text.includes(s));
    check(!leaks.length, '回报里没有号编号、备注、工号、令牌、配对码' + (leaks.length ? '（漏了：' + leaks.join('、') + '）' : ''));
    check(!/codeagent-diag-(intree|outside)-probe/.test(text), '回报里没有命令行原文');
    const cardText = await hc.eval('document.querySelector("dialog.cl-diag").innerText');
    check(/内存都去哪了/.test(cardText) && /通道并行与队列/.test(cardText) && /残留嫌疑/.test(cardText) && /别的 Hub（不算残留）/.test(cardText) && /号 1/.test(cardText) && !/abc123|张三/.test(cardText), '卡片用人话标签显示各段，号用代称');

    // ---- 公司：审计日志；界面轻提示中性措辞 ----
    const audit = fs.readFileSync(path.join(cdata, 'logs', 'company-diag.log'), 'utf8');
    check(audit.includes(`diag ${view.id} sections=machine,processes,hub,pool,logs`), '公司审计日志记下这次直查');
    const cs = await status(cc);
    check(cs.hubAdmin.lastDiag && cs.hubAdmin.lastDiag.id === view.id, '公司状态里记着最近一次直查');

    // ---- 30 秒内再查：公司回「30 秒内只查一次」；再过 30 秒查：计时 ----
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag=again]").click()');
    const againAt = Date.now();
    await until('refused shown', () => hc.eval('/30 秒内只查一次/.test(document.querySelector("dialog.cl-diag .cl-diag-body")?.innerText||"")'), 60000, 500);
    result.timings.refusedMs = Date.now() - againAt;
    check(true, `30 秒内再查：公司回「30 秒内只查一次」，卡片同时保留上一次结果（${(result.timings.refusedMs / 1000).toFixed(1)} 秒）`);
    result.shots.push(await shot(hc, '04-card-refused'));
    const firstAt = Date.parse(new Date(view.receivedAt).toISOString()) || Date.now();
    await _waitMs(Math.max(0, 33000 - (Date.now() - clickAt)));
    const cpoll2 = (await status(cc)).polling;
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag=again]").click()');
    const thirdAt = Date.now();
    await until('third result', async () => { const v = await hc.eval('require("electron").ipcRenderer.invoke("bridge:diag-result", {})'); return v.status === '已回报' && v.id !== view.id ? v : null; }, 90000, 500);
    result.timings.activeMs = Date.now() - thirdAt;
    check(result.timings.activeMs < 15000, `公司活跃（每 ${cpoll2.intervalSeconds} 秒检查通道）时：发出到拿到回报 ${(result.timings.activeMs / 1000).toFixed(1)} 秒（< 15 秒）`);
    void firstAt;
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    if (company) await gracefulQuit(company).catch(() => {});
    // 测试自己起的两个 node：按 PID 结束（只认这两个 PID，且确认它们是 node）
    for (const pid of [outsider && outsider.pid, intreePid].filter(Boolean)) {
      try { const name = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).ProcessName`], { encoding: 'utf8', windowsHide: true }).trim(); if (name === 'node') process.kill(pid); } catch {}
    }
    try { relay && relay.kill(); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, timings: result.timings, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
