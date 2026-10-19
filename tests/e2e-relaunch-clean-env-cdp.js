'use strict';
// 干净启动环境（core/clean-launch-env.js，2026-10-19）真实端到端：
//   node tests/e2e-relaunch-clean-env-cdp.js [--out <结果目录>]
// 一台隔离 Hub 模拟「从号池会话的进程树里、在系统目录下被拉起」：环境里带着 CODEAGENT3_CONFIG_DIR=号池号 1 的目录、
// CodeAgent / Hub 会话标记，工作目录是 C:\Windows\System32；另带一个用户变量和一段额外的 PATH（这两样必须原样保留）。
// 验证：
//   1. 启动自检：会话标记立刻从主进程环境去掉，号池目录判定后去掉，工作目录改为程序目录；用户变量、PATH 原样；
//   2. Hub 里新开的 PowerShell 终端（真实 PTY）里同样没有这些变量；
//   3. 走「重启并继续」（真实 app.relaunch + 优雅退出）拉起的新进程：继承来的环境里已经没有这些变量（它的启动自检无事可做），
//      用户变量、PATH 照旧，工作目录正常。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261019-relaunch-clean-env-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const MARKERS = ['CODEAGENT_HUB_X', 'CLAUDE_HUB_SESSION_ID', 'CODEAGENT3_LAUNCHER_PID', 'AI_HUB_NO_CHOICE'];
const NAMES = [...MARKERS, 'CODEAGENT3_CONFIG_DIR', 'MY_E2E_KEEP', 'Path', 'CLAUDE_HUB_DATA_DIR'];
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-relaunch-clean-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, checks: [], scope: '真实 Electron（隔离实例）+ 真实 PowerShell 终端 + 真实「重启并继续」（app.relaunch + 优雅退出）；环境与工作目录经主进程只读接口读取' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let hub, c, port;
  try {
    const data = path.join(root, 'data');
    const POOL_ID = 'rlc0e2e1';
    const poolDir = path.join(data, 'codeagent-pool', 'accounts', POOL_ID);
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: 'e2e', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
    const junkPath = path.join(root, 'launcher-only-bin');
    fs.mkdirSync(junkPath);
    const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'Path';
    port = await freePort();
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'background', label: 'relaunch-clean', allowExternalState: true, cwd: SYS32,
      extraEnv: { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', AI_HUB_CODEAGENT_CONFIG_DIR: '', HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'),
        CODEAGENT3_CONFIG_DIR: poolDir, CODEAGENT_HUB_X: '1', CLAUDE_HUB_SESSION_ID: 'parent-session', CODEAGENT3_LAUNCHER_PID: '4242', AI_HUB_NO_CHOICE: '1',
        MY_E2E_KEEP: 'keep-me', [pathKey]: junkPath + ';' + process.env[pathKey] } });
    c = await connectFirstPage(hub);
    const until = async (label, read, timeout = 60000, every = 500) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const launchEnv = cl => cl.eval(`require("electron").ipcRenderer.invoke("debug:launch-env", ${j(NAMES)})`);
    await until('renderer', () => c.eval('typeof sessions!=="undefined" && location.href.includes("index.html")'), 90000, 300);

    // ---- 1. 启动自检 ----
    const first = await until('configdir dropped', async () => { const v = await launchEnv(c); return v && v.startup && v.startup.configDir ? v : null; }, 60000);
    result.first = { ...first, env: { ...first.env, Path: '(略)' } };
    check(MARKERS.every(n => first.startup.removed.includes(n)) && MARKERS.every(n => first.env[n] === null), '启动自检：继承来的会话标记已从主进程环境去掉（' + MARKERS.join('、') + '）');
    check(first.env.CODEAGENT3_CONFIG_DIR === null && first.startup.configDir.reason === 'in-pool', '继承的 CODEAGENT3_CONFIG_DIR 判定落在号池里，已从主进程环境去掉');
    check(path.resolve(first.startup.initialCwd).toLowerCase() === SYS32.toLowerCase() && path.resolve(first.cwd).toLowerCase() === repo.toLowerCase(),
      `启动时的工作目录是 ${first.startup.initialCwd}（异常），已改为程序目录`);
    check(first.env.MY_E2E_KEEP === 'keep-me' && String(first.env.Path).startsWith(junkPath + ';') && first.env.CLAUDE_HUB_DATA_DIR === data, '用户变量、PATH、隔离数据目录原样保留');

    // ---- 2. Hub 里新开的 PowerShell 终端 ----
    const psOut = path.join(root, 'ps-env.json');
    const ps = await c.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'powershell', opts: { cwd: root, title: '环境检查' } })})`);
    check(ps && ps.id, 'Hub 里新开了一个 PowerShell 终端 ' + (ps && ps.id));
    const cmd = `[IO.File]::WriteAllText('${psOut}', (ConvertTo-Json -Compress @{ x=$env:CODEAGENT_HUB_X; s=$env:CLAUDE_HUB_SESSION_ID; p=$env:CODEAGENT3_LAUNCHER_PID; n=$env:AI_HUB_NO_CHOICE; d=$env:CODEAGENT3_CONFIG_DIR; k=$env:MY_E2E_KEEP }))`;
    await _waitMs(3000);
    await c.eval(`require("electron").ipcRenderer.send("terminal-input", ${j({ sessionId: ps.id, data: cmd + '\r' })})`);
    const psEnv = await until('ps env file', async () => (fs.existsSync(psOut) ? JSON.parse(fs.readFileSync(psOut, 'utf8').replace(/^\uFEFF/, '')) : null), 30000);
    result.psEnv = psEnv;
    check(!psEnv.x && !psEnv.s && !psEnv.p && !psEnv.n && !psEnv.d && psEnv.k === 'keep-me', 'PowerShell 终端里没有会话标记和号池目录，用户变量照旧');
    await c.eval(`require("electron").ipcRenderer.invoke('close-session', ${j(ps.id)})`);
    await _waitMs(1500);

    // ---- 3. 重启并继续：真实 app.relaunch ----
    const oldPid = hub.pid;
    const req = c.eval('require("electron").ipcRenderer.invoke("hub-restart:request", {})').catch(e => ({ ok: false, error: e.message }));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until('old hub exited', async () => !alive(oldPid), 120000, 500);
    result.restartRequest = await Promise.race([req, _waitMs(100).then(() => 'pending')]);
    check(true, '「重启并继续」：旧 Hub 进程已优雅退出');
    try { c.close(); } catch {}
    c = await until('relaunched hub', async () => { const x = await connectFirstPage({ cdpHttpBase: `http://127.0.0.1:${port}`, label: 'relaunched' }); if (await x.eval('location.href.includes("renderer/index.html")')) return x; x.close(); return null; }, 120000, 1000);
    await until('relaunched renderer', () => c.eval('typeof sessions!=="undefined"'), 90000, 500);
    const second = await until('relaunched launch env', async () => { const v = await launchEnv(c); return v && v.pid !== oldPid ? v : null; }, 30000);
    result.second = { ...second, env: { ...second.env, Path: '(略)' } };
    check(second.pid !== oldPid, `新进程 PID ${second.pid} 已拉起（同一数据目录、同一调试端口）`);
    check(second.startup.removed.length === 0 && second.startup.cwdChanged === null && MARKERS.every(n => second.env[n] === null),
      '新进程继承来的环境里已经没有会话标记，工作目录也正常（启动自检无事可做）——再启动路径本身就是干净的');
    check(second.env.CODEAGENT3_CONFIG_DIR === null && !second.startup.configDir, '新进程没有继承号池目录');
    check(path.resolve(second.startup.initialCwd).toLowerCase() === repo.toLowerCase(), '新进程启动时的工作目录就是程序目录');
    check(second.env.MY_E2E_KEEP === 'keep-me' && String(second.env.Path).startsWith(junkPath + ';') && second.env.CLAUDE_HUB_DATA_DIR === data, '用户变量、PATH、隔离数据目录照旧带下去');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    try { result.logTail = hub && hub.log().slice(-30); } catch {}
  } finally {
    try { c && c.close(); } catch {}
    // 重新拉起的 Hub 不是本测试的子进程：经它自己的调试端口关闭（端口是本测试独占的）。
    if (port) {
      try {
        const version = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/json/version`, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
        const browser = await connectCDP(version.webSocketDebuggerUrl);
        await browser.send('Browser.close').catch(() => {});
      } catch {}
    }
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true }).catch(() => {});
    fs.writeFileSync(path.join(out, '20261019-relaunch-clean-env-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
