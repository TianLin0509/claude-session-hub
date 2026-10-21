'use strict';
// 远程重启「先中断、重启后恢复」真实端到端（2026-10-17 v2.1.9，core/company-bridge/hub-admin.js）：
//   node tests/e2e-company-hub-restart-resume.js [--out <截图目录>]
// 田哥 22:40：「有时候不能等所有会话都完成，可以先记着，先重启中断，等重启完后再恢复——效率更高。」
// 沿用 e2e-company-hub-remote-update.js 的双 Electron 设施：家里 = 当前工作区源码（角色 home）；
// 公司 = 当前工作区按公司目标导出、以源码方式启动；中间是真实的任务通道服务（company-drop 的 relay_server.py）。
// CodeAgent 用替身 = 真 Claude Code + Haiku（tests/fixtures/codeagent-standin），各自独立的配置目录（凭据复制进去）。
// 流程全按真实路径：
//   家里一个会话用「问公司」命令行（和 AI 调 ask_company 同一个本机接口）提问 → 公司新开 CodeAgent 会话作答，
//   答到一半（在跑一条 75 秒的命令，模拟长编译）→ 家里用命令行 --hub-restart --force →
//   公司记下这个会话、报「中断 1 个任务后重启」→ app.relaunch + quit（真实优雅退出）→ 新进程接通通道报「已重启」→
//   按原编号恢复会话、经正规发送入口只发「继续」→ CodeAgent 接着做完 → 回执照常发回家里、送进提问的会话。
// --duplicate（2026-10-18，v2.1.9 验收第 1 次卡住的那类情况）：命令跑起来后像人一样按 Esc 打断，再经正规发送入口
//   把同一段提问原样再发一遍（同一轮的提问在原生记录里出现两次，和通道补发的效果一样），CodeAgent 重新开跑后再远程重启。
//   旧版回执核对见到两条一样的提问就判「不唯一」，这一轮一直卡在途；修好后最后一份之后的回答照常回执。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const BRIDGE_TEST_MASTER = require('node:crypto').randomBytes(32).toString('hex'); // 家里隔离实例的本机密钥（只在测试里指定）

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const DUPLICATE = argv.includes('--duplicate');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', DUPLICATE ? '20261018-company-hub-restart-resume-duplicate-claude1' : '20261017-company-hub-restart-resume-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// CodeAgent 替身的配置目录：复制本机 Claude 凭据，跳过首次引导，允许直接跑命令。
function standinConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  fs.copyFileSync(claudeAuth, path.join(dir, '.credentials.json'));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  // 通道按 CodeAgent 默认模型开会话（不带 --model）：替身的默认模型设成 Haiku，省 token。
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  return dir;
}
// Claude 格式原生记录里用户发出的文字（工具结果不算）。
function userTexts(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const outList = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"user"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (!blocks.length || blocks.every(b => b?.type === 'tool_result')) continue;
    outList.push(blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('\n'));
  }
  return outList;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-restart-resume-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const nonce = randomBytes(3).toString('hex');
  const token = 'RESUME-E2E-OK-' + nonce;
  const result = { passed: false, variant: DUPLICATE ? 'duplicate' : 'standard', root, out, token, checks: [],
    scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务 + CodeAgent 替身（真 Claude Code + Haiku）+ 真实 app.relaunch 优雅重启 + 真实会话恢复与正规发送入口' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc, cport;
  try {
    // ---- 公司版导出（源码方式运行） ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    log('公司版导出完成');

    // ---- 通道服务 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    // ---- 两端数据目录 ----
    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    const codeDir = path.join(root, 'company-code'); fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'README.md'), '# 端到端测试用的代码目录\n');
    const homeWork = path.join(root, 'home-work'); fs.mkdirSync(homeWork, { recursive: true });
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    const cac = standinConfig(path.join(root, 'company-cac')), hcac = standinConfig(path.join(root, 'home-cac'));
    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), AI_HUB_CODEAGENT_COMMAND: STANDIN, CODEAGENT_STANDIN_MODEL: 'haiku' };
    cport = await freePort();
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'rr-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_E2E_BRIDGE_MASTER: BRIDGE_TEST_MASTER, CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0',
          AI_HUB_CODEAGENT_CONFIG_DIR: hcac } }),
      launchIsolatedHub({ dataDir: cdata, port: cport, windowMode: 'background', label: 'rr-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' } }),
    ]);
    // 不给窗口过滤：connectFirstPage 默认连主窗口（本次一起修的「连到桌宠」）。
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); log('截图 ' + path.join(out, name + '.png')); };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    const sessions = c => c.eval('require("electron").ipcRenderer.invoke("get-sessions")');
    await until('renderers', async () => (await hc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')) && (await cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')), 90000, 300);
    check(true, '两台 Hub 都连到主窗口（renderer/index.html）');

    // ---- 配对（IPC，与界面按钮同一入口）+ 公司设置 ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ codeRoots: [codeDir], effort: 'low' })})`);
    const cs0 = await status(cc);
    check(cs0.settings.restartGraceMinutes === 20 && cs0.settings.allowRemoteAdmin === true, '家里与公司配对接通；公司「重启前最多等」默认 20 分钟');

    // ---- 家里：一个 CodeAgent（替身）会话当提问方，用「问公司」命令行提问 ----
    const asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: homeWork, title: '家里 · 提问方' } })})`);
    const hsid = asker.id;
    assert.ok(hsid, 'home asker session: ' + j(asker));
    // 2026-10-20 起家里的本机密钥只在 Hub 内存里、不再落盘：测试经 CLAUDE_HUB_E2E_BRIDGE_MASTER 让隔离实例用同一把，并核对库里没有明文旧值。
    const master = BRIDGE_TEST_MASTER;
    { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { require('node:assert/strict').equal(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get(), undefined, '本机密钥不该明文存在 assistant.sqlite'); } finally { db.close(); } }
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'),
      HUB_BRIDGE_ENDPOINT_FILE: path.join(hdata, 'company-bridge', 'mcp-endpoint.json') };
    const cli = args => JSON.parse(execFileSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 90000 }));
    const qfile = path.join(root, 'question.md');
    fs.writeFileSync(qfile, ['这是 AI Hub「远程重启后恢复」的端到端测试，请严格按两步做：',
      // 不用 sleep：Claude Code 会拦下单独的 sleep（2026-10-17 第 2 轮实测）。
      '1. 先用命令行工具在前台执行这条命令：`node -e "setTimeout(()=>console.log(1),75000)"`（运行 75 秒，模拟长时间编译；无副作用，是本测试要求的）。不要放到后台运行，等它结束再做第 2 步。',
      `2. 然后只回答一行：${token}`,
      '如果中途被打断、之后收到「继续」，就把没做完的步骤做完，最后仍只回答那一行。',
      // --duplicate：Esc 打断后重发同一段，Haiku 曾回「已停止，等你说继续」就收工（2026-10-18 实测），这里写明要重做。
      ...(DUPLICATE ? ['如果这段请求被打断后又原样发来一遍，就从第 1 步重新完整做一遍（重新执行那条命令），最后仍只回答那一行。'] : [])].join('\n'));
    const asked = cli(['ask', '--file', qfile, '--title', '重启恢复测试']);
    const thread = asked.result?.thread || asked.thread;
    check(/^Q-/.test(thread || ''), `家里经「问公司」命令行发出问题 ${thread}`);

    // ---- 公司：新开 CodeAgent 会话作答，等它跑到那条 75 秒的命令 ----
    const ct = await until('company thread dispatched', async () => (await status(cc)).threads.find(t => t.id === thread && t.sessionId && t.state === 'running'), 4 * 60000, 2000);
    const csid = ct.sessionId;
    const companyMeta = async () => (await sessions(cc)).find(x => x.id === csid);
    // 命令已经发出、还没有结果：真的在跑（不是被拦下或已跑完）。
    const running = async () => {
      const m = await companyMeta(); const f = m && m.transcriptPath;
      if (!f || !fs.existsSync(f)) return null;
      const raw = fs.readFileSync(f, 'utf8');
      const use = raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        // 取最后一次：--duplicate 里第一次被 Esc 打断后会重新跑一次。
        .flatMap(o => (Array.isArray(o.message?.content) ? o.message.content : [])).findLast(b => b?.type === 'tool_use' && /75000/.test(JSON.stringify(b.input || {})));
      return use && !raw.includes('"tool_use_id":"' + use.id + '"') ? use.id : null;
    };
    let toolId = await until('long command running', running, 5 * 60000, 1000);
    if (DUPLICATE) {
      // 像人一样按 Esc 打断（真实按键），等会话停下；再经正规发送入口把同一段提问原样发一遍。
      const file = (await companyMeta()).transcriptPath;
      const prompt = userTexts(file).find(t => t.includes(token));
      cc.eval(`require("electron").ipcRenderer.send("terminal-input", ${j({ sessionId: csid, data: '\u001b' })})`);
      await until('interrupted', async () => { const raw = fs.readFileSync(file, 'utf8'); const st = (await status(cc)).threads.find(t => t.id === thread);
        return raw.includes('"tool_use_id":"' + toolId + '"') && st.session && !st.session.busy; }, 120000, 1000);
      check(true, '按 Esc 打断了那条 75 秒的命令，会话停下');
      const resend = await cc.eval(`require("electron").ipcRenderer.invoke("session:send-prompt", ${j({ sessionId: csid, text: prompt, clientSubmissionId: 'e2e-duplicate-' + nonce })})`);
      result.duplicateSend = { ok: resend?.ok, sendStatus: resend?.sendStatus };
      await until('duplicate prompt in transcript', async () => userTexts(file).filter(t => t === prompt).length === 2, 180000, 1000);
      check(true, '经正规发送入口把同一段提问原样再发了一遍：原生记录里这一轮的提问出现两次');
      toolId = await until('long command running again', async () => { const id = await running(); return id && id !== toolId ? id : null; }, 5 * 60000, 1000);
      check(true, 'CodeAgent 按重发的那一份重新跑起 75 秒的命令');
    }
    const busyBefore = (await status(cc)).threads.find(t => t.id === thread).session;
    check(busyBefore?.busy === true, `公司 CodeAgent 会话 ${csid.slice(0, 8)} 正在跑 75 秒的命令（命令已发出、还没有结果）`);
    await shot(cc, '01-company-working-before-restart');

    // ---- 家里：命令行 --hub-restart --force ----
    const companyPid = company.pid;
    check((await running()) === toolId, '发重启指令时那条 75 秒的命令仍在运行（没有结果）');
    const sent = cli(['--hub-restart', '--force']);
    const cmd = sent.result?.id || sent.id;
    check(/^HA-/.test(cmd || '') && /force/.test(sent.result?.next || sent.next || ''), '家里经命令行发出远程重启（force）' + cmd);
    const recent = async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return ((await status(hc)).companyHub.recent || []).filter(x => x.id === cmd); };
    const restarting = await until('restarting reported', async () => (await recent()).find(x => x.phase === 'restarting'), 120000, 3000);
    result.restartingNote = restarting.note;
    check(/中断 1 个任务后重启（force：不等；重启后自动恢复这些会话并接着做）/.test(restarting.note), '家里收到「' + restarting.note + '」');
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until('company exited', async () => !alive(companyPid), 120000, 500);
    check(true, '公司 Hub 进程按指令优雅退出（app.relaunch + quit）');
    try { cc.close(); } catch {}
    cc = await until('relaunched company', async () => { const c = await connectFirstPage({ cdpHttpBase: `http://127.0.0.1:${cport}`, label: 'rr-company-relaunched' }); if (await c.eval('location.href.includes("renderer/index.html")')) return c; c.close(); return null; }, 180000, 1000);
    await until('relaunched renderer', () => cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")'), 90000, 500);
    await cc.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    check(true, '公司 Hub 重新拉起（同一数据目录、同一调试端口）');

    // ---- 重启后：报「已重启」→ 恢复会话、发「继续」→ 报「已恢复 1 个」 ----
    const resumed = await until('resumed reported', async () => (await recent()).find(x => x.phase === 'resumed'), 6 * 60000, 3000);
    const all = await recent();
    result.statuses = all;
    check(all.some(x => x.phase === 'restarted' && /重启前中断的 1 个任务正在恢复/.test(x.note)), '家里收到「公司 Hub 已重启…重启前中断的 1 个任务正在恢复」');
    check(/已恢复 1 个，失败 0 个/.test(resumed.note), '家里收到「' + resumed.note + '」');
    const meta2 = await until('company session live again', async () => { const m = await companyMeta(); return m && m.status !== 'dormant' && m; }, 60000, 1000);
    check(meta2.id === csid, '按原会话编号恢复（' + csid.slice(0, 8) + '），没有另开新会话');
    const texts = await until('bare continue in transcript', async () => { const m = await companyMeta(); const t = m && m.transcriptPath ? userTexts(m.transcriptPath) : []; return t.includes('继续') && t; }, 120000, 2000);
    result.companyUserTexts = texts.map(t => t.slice(0, 80));
    check(texts.filter(t => t === '继续').length === 1 && texts.findIndex(t => t.includes(token)) < texts.indexOf('继续'), 'CodeAgent 原生记录里：原提问之后收到一句纯「继续」（只一次，一字不多）');
    if (DUPLICATE) check(texts.filter(t => t.includes(token)).length === 2, '「继续」之前同一段提问出现过两次（重复请求）');
    const cthread = (await status(cc)).threads.find(t => t.id === thread);
    check(cthread.rounds[0].resumedAt && !cthread.rounds[0].error, '公司这一轮保持在途（记下恢复时间，没有报错）');
    // 公司版侧栏平时不列通道会话：像人一样点亮「特战」再看（tests/e2e-company-tezhan-sidebar-cdp.js 同一个按钮）。
    if (await cc.eval('document.getElementById("btn-sidebar-wireless")?.getAttribute("aria-pressed")') !== 'true') {
      await cc.eval('document.getElementById("btn-sidebar-wireless").scrollIntoView({block:"center"})');
      const p = await cc.eval('(()=>{const r=document.getElementById("btn-sidebar-wireless").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      for (const type of ['mousePressed', 'mouseReleased']) await cc.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    }
    try { await until('company session in sidebar', () => cc.eval(`!!document.querySelector('.session-item[data-session-id="${csid}"]')`), 30000, 500); }
    catch (error) {
      result.sidebarDiag = await cc.eval(`(()=>({items:[...document.querySelectorAll('.session-item')].map(e=>e.dataset.sessionId+' '+(e.innerText||'').slice(0,30)),
        inMap: typeof sessions!=='undefined' && sessions.get(${j(csid)}) ? { status: sessions.get(${j(csid)}).status, purpose: sessions.get(${j(csid)}).purpose, title: sessions.get(${j(csid)}).title } : null}))()`).catch(e => 'ERR ' + e.message);
      result.sessionDiag = (await sessions(cc)).filter(x => x.id === csid).map(x => ({ id: x.id, status: x.status, purpose: x.purpose, title: x.title }));
      await shot(cc, '02-company-after-restart-resumed-FAIL');
      throw error;
    }
    await shot(cc, '02-company-after-restart-resumed');

    // ---- 回执：CodeAgent 接着做完 → 家里收到该轮回执、送进提问的会话 ----
    const homeRound = await until('home receipt', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === thread); return t?.rounds[0]?.reply || (t?.rounds[0]?.error && 'ERR ' + t.rounds[0].error); }, 10 * 60000, 5000);
    result.reply = String(homeRound).slice(0, 600);
    // 只认单独成行的口令：回执里引用口令（如「没有输出 RESUME-…」）不算做完（第 3 轮实测踩过）。
    check(new RegExp('^\\s*' + token + '\\s*$', 'm').test(homeRound), `家里收到这一轮的回执（单独一行 ${token}：续跑做完了第 2 步）`);
    await until('home delivered', async () => (await status(hc)).threads.find(x => x.id === thread)?.rounds[0]?.delivered, 5 * 60000, 3000);
    check(true, '回执已送进家里提问的会话');
    const cfinal = (await status(cc)).threads.find(t => t.id === thread);
    check(cfinal.state === 'replied' && (await status(cc)).hubAdmin.resumeAfterRestart === null && (await status(cc)).hubAdmin.job.phase === 'restarted', '公司这一轮已回执；恢复清单已清空；指令记为已重启');
    await shot(hc, '03-home-after-receipt');
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
    if (company) await gracefulQuit(company, { allowAlreadyExited: true }).catch(() => {});
    try { relay && relay.kill(); } catch {}
    fs.writeFileSync(path.join(out, DUPLICATE ? '20261018-restart-resume-duplicate-result-claude1.json' : '20261017-restart-resume-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
