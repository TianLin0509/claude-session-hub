'use strict';
// 远程维护（2026-10-18 三期，core/company-bridge/remote-act.js）真实端到端：
//   node tests/e2e-company-remote-act.js [--out <截图目录>]
// 沿用直查 / 远程重启的双 Electron 设施：家里 = 当前工作区源码；公司 = 当前工作区按公司目标导出、以源码方式启动；中间是真实的通道服务（relay_server.py，绑 localhost）。
// CodeAgent 用替身 = 真 Claude Code + Haiku（tests/fixtures/codeagent-standin），家里一个会话用「问公司」命令行提一个只要一行回答的问题，
// 公司开出一个真的通道会话（purpose=company-bridge）答完后空着。公司 Hub 里另有一个人自己开的 PowerShell 会话。
// 测试进程再人为制造一个「重启残留」：脱离任何 Hub 进程树、父进程已退出、入口脚本路径带 codeagent 的 node。
// 公司测试实例把残留最短存活时间改成 5 秒（CLAUDE_HUB_DIAG_LEFTOVER_MIN_AGE_MS）、把「1 小时」缩成 20 秒（CLAUDE_HUB_ACT_HOUR_MS），只对隔离实例生效。
//   1. 家里无线页「公司电脑状态」→ 卡片里「结束可结束的残留」（二次确认）→ 只结束那个残留；两台 Hub 都还活着。
//   2. 命令行 --act suspend-idle → 只休眠空闲的通道会话，人自己开的 PowerShell 会话不动。
//   3. 命令行 --act set-parallel（内存保底 5%、同时 1 个、0.25 小时后恢复）→ 生效 → 到点恢复原值并告诉家里。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261018-company-remote-act-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function standinConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  fs.copyFileSync(claudeAuth, path.join(dir, '.credentials.json'));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  return dir;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-remote-act-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const token = 'ACT-E2E-OK-' + randomBytes(3).toString('hex');
  const result = { passed: false, root, out, checks: [], scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务 + CodeAgent 替身（真 Claude Code + Haiku）+ 真实进程枚举与按 PID 结束' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc, orphan = null;
  try {
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;
    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    const codeDir = path.join(root, 'company-code'); fs.mkdirSync(codeDir, { recursive: true });
    const homeWork = path.join(root, 'home-work'); fs.mkdirSync(homeWork, { recursive: true });
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    const cac = standinConfig(path.join(root, 'company-cac')), hcac = standinConfig(path.join(root, 'home-cac'));
    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), AI_HUB_CODEAGENT_COMMAND: STANDIN, CODEAGENT_STANDIN_MODEL: 'haiku' };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'act-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0', AI_HUB_CODEAGENT_CONFIG_DIR: hcac } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'act-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000',
          CLAUDE_HUB_DIAG_LEFTOVER_MIN_AGE_MS: '5000', CLAUDE_HUB_ACT_HOUR_MS: '20000' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); log('截图 ' + f); return f; };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    const sessions = c => c.eval('require("electron").ipcRenderer.invoke("get-sessions")');
    await until('renderers', async () => (await hc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')) && (await cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')), 90000, 300);

    // ---- 配对 + 公司设置 ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ codeRoots: [codeDir], effort: 'low' })})`);
    const cs0 = await status(cc);
    check(cs0.settings.allowRemoteMaintain === true, '配对接通；公司「远程维护」默认允许');
    await until('company caps', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return ((await status(hc)).companyHub.caps || []).includes('act'); }, 120000, 3000);

    // ---- 家里提问 → 公司开真的通道会话答完 ----
    const asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: homeWork, title: '家里 · 提问方' } })})`);
    const hsid = asker.id;
    const master = (() => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get().value); } finally { db.close(); } })();
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'), HUB_BRIDGE_ENDPOINT_FILE: path.join(hdata, 'company-bridge', 'mcp-endpoint.json') };
    const cli = args => JSON.parse(execFileSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 120000 }));
    const qfile = path.join(root, 'question.md');
    fs.writeFileSync(qfile, `这是 AI Hub「远程维护」的端到端测试。不用读任何文件、不用运行命令，只回答一行：${token}\n`);
    const thread = cli(['ask', '--file', qfile, '--title', '远程维护测试']).thread;
    check(/^Q-/.test(thread || ''), '家里经「问公司」命令行发出问题 ' + thread);
    const ct = await until('company replied', async () => (await status(cc)).threads.find(t => t.id === thread && t.state === 'replied' && t.sessionId), 5 * 60000, 3000);
    const bridgeSession = ct.sessionId;
    const repliedAt = Date.now();
    check(!!bridgeSession, `公司开了通道会话 ${bridgeSession.slice(0, 8)} 并答完`);

    // ---- 公司：人自己开的 PowerShell 会话；测试进程制造一个「重启残留」 ----
    const userShell = await cc.eval('require("electron").ipcRenderer.invoke("create-session", { kind: "powershell", opts: { title: "我自己的终端" } })');
    const orphanJs = path.join(root, 'codeagent-orphan', 'cli.js');
    fs.mkdirSync(path.dirname(orphanJs), { recursive: true }); fs.writeFileSync(orphanJs, 'setInterval(() => {}, 1e9);\n');
    const spawner = `const c=require('child_process').spawn(process.execPath,[${j(orphanJs)},'serve'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();process.stdout.write(String(c.pid))`;
    orphan = Number(execFileSync(process.execPath, ['-e', spawner], { encoding: 'utf8', windowsHide: true }).trim());
    log('残留 PID ' + orphan);
    await _waitMs(7000);

    // ---- 1. 卡片：公司电脑状态 → 结束可结束的残留 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await hc.eval('document.getElementById("btn-toggle-navigation").click()');
    await hc.eval('document.getElementById("btn-wireless").click()');
    await until('diag button', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=diag]")'), 20000, 300);
    await hc.eval('document.querySelector("[data-cl=diag]").scrollIntoView({block:"center"})');
    const p = await hc.eval('(()=>{const r=document.querySelector("[data-cl=diag]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    for (const type of ['mousePressed', 'mouseReleased']) await hc.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await until('card result', () => hc.eval('!!document.querySelector("dialog.cl-diag[open] [data-diag-act=kill-orphans]")'), 120000, 500);
    // 安全：这台开发机上若还有别的「可结束」进程（不是本测试制造的），不点「全部结束」，改用命令行只结束本测试的那个
    const seen = await hc.eval('require("electron").ipcRenderer.invoke("bridge:diag-result", {})');
    const killable = (seen.diag?.processes?.leftovers || []).filter(x => x.killable).map(x => x.pid);
    result.killableSeen = killable;
    if (killable.length !== 1 || killable[0] !== orphan) throw new Error('直查列出的可结束进程不只本测试制造的那个，为安全起见停止：' + j(killable));
    const killBtn = await hc.eval('document.querySelector("dialog.cl-diag [data-diag-act=kill-orphans]").innerText');
    check(/结束可结束的残留（1 个）/.test(killBtn), '卡片列出 1 个可结束的残留，按钮写明个数：' + killBtn);
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag-act=kill-orphans]").scrollIntoView({block:"center"})');
    result.shots = [await shot(hc, '01-card-kill-button')];
    await hc.eval('window.__confirmText = ""; window.confirm = t => { window.__confirmText = t; return true; }');
    const kb = await hc.eval('(()=>{const r=document.querySelector("dialog.cl-diag [data-diag-act=kill-orphans]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    for (const type of ['mousePressed', 'mouseReleased']) await hc.send('Input.dispatchMouseEvent', { type, ...kb, button: 'left', clickCount: 1 });
    check(new RegExp(`PID ${orphan}`).test(await hc.eval('window.__confirmText')), '结束前二次确认，列出要结束的 PID');
    const banner = await until('kill result', () => hc.eval('(()=>{const e=document.querySelector("dialog.cl-diag .cl-diag-act-result");return e&&/结束了/.test(e.innerText)?e.innerText:null})()'), 90000, 500);
    check(/结束了 1 个/.test(banner) && !alive(orphan), `只结束了那个残留（PID ${orphan} 已不在）：${banner.replace(/\s+/g, ' ').slice(0, 120)}`);
    check(alive(company.pid) && alive(home.pid), '两台 Hub 都还活着');
    result.shots.push(await shot(hc, '02-card-kill-result'));
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag=close]").click()');

    // ---- 2. suspend-idle：只休眠空闲的通道会话 ----
    await _waitMs(Math.max(0, 65000 - (Date.now() - repliedAt))); // 休眠底线：空闲满 1 分钟
    const s1 = cli(['--act', 'suspend-idle']);
    result.suspend = s1;
    check(s1.status === '已执行' && s1.act.suspended.length === 1 && s1.act.suspended[0].thread === thread, `suspend-idle 休眠了通道会话（${thread}）：${s1.note}`);
    const after = await until('dormant', async () => { const list = await sessions(cc); const b = list.find(s => s.id === bridgeSession); return !b || b.status === 'dormant' ? list : null; }, 30000, 1000);
    const shell = after.find(s => s.id === userShell.id);
    check(shell && shell.status !== 'dormant', '人自己开的 PowerShell 会话没被动');

    // ---- 3. set-parallel：生效并到点恢复 ----
    const before = (await status(cc)).settings;
    const s2 = cli(['--act', 'set-parallel', '--mem-floor', '5', '--max-parallel', '1', '--restore-hours', '0.25']);
    result.setParallel = s2;
    const mid = (await status(cc)).settings;
    check(s2.status === '已执行' && s2.act.ok && mid.memFloorPct === 5 && mid.maxParallel === 1, `set-parallel 生效：${s2.note}`);
    await until('restored', async () => { const s = (await status(cc)).settings; return s.memFloorPct === before.memFloorPct && s.maxParallel === before.maxParallel; }, 60000, 2000);
    await until('home told', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return ((await status(hc)).companyHub.recent || []).some(x => /已到时恢复/.test(x.note)); }, 60000, 3000);
    check(true, `到点（测试实例 0.25 小时 = 5 秒）恢复原值 memFloorPct=${before.memFloorPct}、maxParallel=${before.maxParallel}，并告诉了家里`);
    // ---- 公司审计日志 ----
    const audit = fs.readFileSync(path.join(cdata, 'logs', 'company-act.log'), 'utf8');
    check(/done .* kill-orphans/.test(audit) && /done .* suspend-idle/.test(audit) && /done .* set-parallel/.test(audit) && /restored/.test(audit), '公司审计日志记下了每个动作');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    if (company) await gracefulQuit(company).catch(() => {});
    if (orphan && alive(orphan)) { try { const name = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${orphan} -ErrorAction SilentlyContinue).ProcessName`], { encoding: 'utf8', windowsHide: true }).trim(); if (name === 'node') process.kill(orphan); } catch {} }
    try { relay && relay.kill(); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
