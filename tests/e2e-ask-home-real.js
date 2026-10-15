'use strict';
// 公司求助家里（ask_home）「真实流程」演练（长测，约 10–25 分钟，不进单元测试闸门）。
// 本机起两台隔离 Hub：公司（公司一端，CodeAgent 用替身 = 真 Claude Haiku，走 --mcp-config 挂上 ask_home）和
// 家里（自用版，作答用真 Claude；默认模型在隔离配置里设成 haiku，验证「用 Hub 的默认配置」），中间是真实的任务通道服务。
// 全程按真实操作：家里无线页生成配对码 → 公司「设置菜单 → AI特战队专用功能」粘贴 → 接通；
// 公司开 CodeAgent 会话，让它用 ask_home 求助，并要求家里先回公司查代码里的取值再拿主意；
// 核对：家里开了 1 个 Claude 求助会话（haiku）、家里回公司查证据（公司新开替家里办事的会话，不挂 ask_home）、
// 家里等回执送进去再答完、回复送回发起的 CodeAgent 会话并把它唤醒；2 万字关口用 Hub 写好的 .cmd 启动文件实跑（Electron 以 Node 方式运行脚本）；
// 两端界面列表可见，1440 宽截图留证。
//   HUB_E2E_TMP=D:/Temp node tests/e2e-ask-home-real.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const L2 = path.join(__dirname, 'fixtures', 'company-bridge', 'l2-code');

// 通道服务前面的一层转发：/api/* 去掉前缀（同线上 Caddy）。
function startApiProxy(relayPort) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (!req.url.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      const up = http.request({ host: '127.0.0.1', port: relayPort, path: req.url.slice(4), method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', 'content-length': body.length } }, r => {
        res.writeHead(r.statusCode, r.headers); r.pipe(res);
      });
      up.on('error', e => { res.writeHead(502); res.end(String(e)); });
      up.end(body);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'ask-home-'));
  const out = path.resolve('artifacts/ask-home-real-flow', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now(), at = () => Math.round((Date.now() - t0) / 1000) + 's';
  const timeline = [], log = msg => { const line = '[' + at() + '] ' + msg; timeline.push(line); console.log(line); fs.writeFileSync(path.join(out, 'timeline.txt'), timeline.join('\n')); };
  const result = { passed: false, scope: '两台隔离 Hub（家里自用版 + 公司一端·角色覆盖）+ 真实通道服务 + 家里真实 Claude（默认模型 haiku）+ CodeAgent 替身（真 Claude Haiku）', root, out, checks: [], timeline };
  const check = msg => { result.checks.push(msg); log('✔ ' + msg); };
  let relay, proxy, home, company, hc, cc;
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), claudeAuth = path.join(claudeSource, '.credentials.json');
  try {
    // ---- 通道服务 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await wait(200); }
    proxy = await startApiProxy(relayPort);
    const apiUrl = `http://127.0.0.1:${proxy.port}/api`;
    log('通道服务已启动：' + apiUrl);

    // ---- 家里 Hub：真实 Claude，凭据复制进隔离目录；默认模型设成 haiku；Codex 登录也带上（替补用） ----
    const hdata = path.join(root, 'home-data'), claudeHome = path.join(root, 'claude-home');
    for (const d of [hdata, claudeHome]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    require('../core/claude-hook-integration').ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const prov = cfg.providers?.codex || {}, profile = (prov.subscription_profiles || []).find(p => p.id === prov.subscription_profile) || { id: 'default', label: '主账号', home: '' };
    const codexAuth = path.join(profile.home || path.join(os.homedir(), '.codex'), 'auth.json'), codexHome = path.join(root, 'codex');
    fs.mkdirSync(codexHome, { recursive: true }); fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
    fs.writeFileSync(path.join(hdata, 'config.json'), j({ models: { defaults: { claude: 'haiku' } },
      providers: { codex: { backend: 'subscription', subscription_profile: profile.id, subscription_profiles: [{ id: profile.id, label: profile.label, home: codexHome }] } } }));
    // ---- 公司 Hub：CodeAgent 替身用真 Claude Haiku，凭据复制进它的配置目录 ----
    const cdata = path.join(root, 'company-data'), cac = path.join(root, 'cac'), l2 = path.join(root, 'company-code', 'l2');
    fs.mkdirSync(cac, { recursive: true }); fs.cpSync(L2, l2, { recursive: true });
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
      hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'ask-home-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_CONFIG_DIR: claudeHome,
          CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '', CLAUDE_HUB_WIRELESS_TIMER: '0' } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'ask-home-company', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'company',
          AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CODEAGENT_STANDIN_MODEL: 'haiku' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 30000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { last = await read(); if (last) return last; await wait(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); log('截图 ' + name + '.png'); };
    const click = async (c, selector) => {
      await until('clickable ' + selector, () => c.eval('(()=>{const e=document.querySelector(' + j(selector) + ');if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'), 20000, 300);
      const p = await c.eval('(()=>{const r=document.querySelector(' + j(selector) + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    const sessionsOf = c => c.eval('require("electron").ipcRenderer.invoke("get-sessions")');
    const transcript = async (c, id) => { const s = (await sessionsOf(c)).find(x => x.id === id); return s && s.transcriptPath && fs.existsSync(s.transcriptPath) ? fs.readFileSync(s.transcriptPath, 'utf8') : ''; };
    await until('renderers', async () => (await hc.eval('typeof window.__wirelessHide==="function"')) && (await cc.eval('typeof window.__hubOpenSession==="function"')), 60000, 300);
    log('两台隔离 Hub 已启动');

    // ---- 1. 配对（界面操作） ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click(hc, '#btn-toggle-navigation');
    await click(hc, '#btn-wireless');
    await until('company link section', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=create]")'), 20000, 300);
    await click(hc, '.cl-section [data-cl=create]');
    const code = await until('pairing code', () => hc.eval('document.querySelector(".cl-code")?.value || ""'), 15000, 300);
    await click(cc, '#btn-options');
    await until('menu entry', () => cc.eval('!!document.getElementById("options-home-link")'), 15000, 300);
    await click(cc, '#options-home-link');
    await until('dialog', () => cc.eval('!!document.querySelector("#home-link-dialog[open] [data-hl-f=code]")'), 15000, 300);
    await cc.eval('(()=>{const t=document.querySelector("[data-hl-f=code]");t.value=' + j(code) + ';t.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await click(cc, '[data-hl=pair]');
    await until('company paired', async () => (await status(cc)).link.state === 'paired', 180000, 3000);
    await until('home paired', async () => (await status(hc)).link.state === 'paired', 180000, 2000);
    check('界面配对：家里生成配对码、公司粘贴后两端接通');
    await until('settings form', () => cc.eval('!!document.querySelector("[data-hl-f=codeRoots]")'), 20000, 300);
    await cc.eval('(()=>{const t=document.querySelector("[data-hl-f=codeRoots]");t.value=' + j(l2) + ';t.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-hl-f=effort]").value="low"})()');
    await click(cc, '[data-hl=save]');
    await until('saved', async () => (await status(cc)).settings.codeRoots[0] === l2, 15000, 500);
    await cc.eval('document.getElementById("home-link-dialog")?.close()');
    assert.equal((await status(hc)).polling.intervalSeconds, 60, '家里空闲时每分钟检查');
    check('公司页保存代码位置；家里空闲每 60 秒检查');

    // ---- 2. 公司开 CodeAgent 会话：确认 ask_home 挂上了 ----
    const created = await cc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: l2, title: 'L2 PF 排查', effort: 'low' } })})`);
    const csid = created.id;
    const mcpFile = path.join(cdata, 'extra-mcp', `codeagent-${csid}.json`);
    await until('ask_home mcp config', () => fs.existsSync(mcpFile), 20000, 500);
    const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.home_bridge;
    assert.ok(mcp && /ask-home-mcp\.js$/.test(mcp.args[0]) && mcp.env.ELECTRON_RUN_AS_NODE === '1');
    check('公司新开的 CodeAgent 会话带上 home_bridge（ask_home）MCP，由 Hub 程序以 Node 方式运行');

    // ---- 3. 2 万字关口：用 Hub 写好的 .cmd 实跑（同一个会话通行证） ----
    const runCmd = (file) => new Promise(resolve => execFile('cmd.exe', ['/d', '/c', mcp.env.HUB_ASK_HOME_CMD, 'ask', '--file', file], { env: { ...process.env, ...mcp.env, ELECTRON_RUN_AS_NODE: '' }, windowsHide: true, timeout: 60000 },
      (error, stdout) => resolve({ code: error ? error.code : 0, out: String(stdout || '') })));
    const big = path.join(root, 'big.md'); fs.writeFileSync(big, '码'.repeat(20000));
    const denied = await runCmd(big);
    result.gateOutput = denied.out.trim().slice(0, 300);
    assert.match(denied.out, /20000 字.*必须少于 20000 字.*没有发出/);
    assert.equal((await status(cc)).askHome.length, 0, '超限的没有发出');
    check('2 万字关口：命令行启动文件实跑，20000 字被拒（' + result.gateOutput.slice(0, 80) + '…）');

    // ---- 4. CodeAgent 用 ask_home 求助，要求家里先回公司查代码 ----
    const task = ['这是「问家里」功能的端到端演练，请严格按步骤：',
      '1. 现在调用 ask_home 工具向家里求助。question 用 Markdown 写：背景——我在核对公司 L2 的 PF 调度实现，要决定新接入 UE 的平均吞吐初值策略是否合理；',
      '要求——请家里先用 ask_company 向公司查清 src/sched 下 PF 实现里「新接入 UE 平均吞吐初值」的折扣系数和上限分别是多少（必须查，不要猜），再给出是否合理的判断和一条改进建议；回复第一行写 HOME-VERDICT。title 写「PF 初值策略」。',
      '2. 调用后立刻结束本轮，只回复一句「已求助」。不要等待、不要查询、也不要自己去读代码。',
      '3. 之后你会收到一条以【家里回复 开头的消息。收到后，第一行写 COMPANY-DONE，然后用两句话复述家里的结论（写出具体数值）。'].join('\n');
    const sent = await cc.eval(`require("electron").ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: csid, text: task })})`);
    assert.notEqual(sent && sent.ok, false, 'send prompt: ' + j(sent));
    const askThread = await until('ask_home thread', async () => (await status(cc)).askHome[0], 6 * 60000, 3000);
    result.thread = askThread.id;
    assert.equal(askThread.sessionId, csid);
    check(`CodeAgent 调用 ask_home 发出 ${askThread.id}（${askThread.rounds[0].chars} 字）`);

    // ---- 5. 家里开 Claude 求助会话（默认配置 haiku） ----
    const consult = await until('home consult', async () => (await status(hc)).consults.find(t => t.id === askThread.id && t.sessionId), 4 * 60000, 2000);
    const homeSessions = await sessionsOf(hc);
    const hsess = homeSessions.find(x => x.id === consult.sessionId);
    result.homeSession = { kind: hsess?.kind, model: hsess?.currentModel?.id || hsess?.model, purpose: hsess?.purpose };
    assert.equal(hsess.kind, 'claude', '优先 Claude');
    assert.match(String(hsess.model || hsess.currentModel?.id || ''), /haiku/i, '用 Hub 的默认模型（隔离配置里是 haiku）');
    check(`家里收到求助，新开 Claude 会话 ${consult.sessionId.slice(0, 8)}（模型 ${result.homeSession.model}）`);

    // ---- 6. 家里回公司查证据：公司为它新开替家里办事的会话（不挂 ask_home） ----
    const q = await until('home asks company', async () => (await status(hc)).threads.find(t => t.sessionId === consult.sessionId), 10 * 60000, 3000);
    result.companyAsk = q.id;
    check(`家里 Claude 用 ask_company 回公司查证据 ${q.id}`);
    const bridgeThread = await until('company bridge session', async () => (await status(cc)).threads.find(t => t.id === q.id && t.sessionId), 4 * 60000, 2000);
    assert.ok(!fs.existsSync(path.join(cdata, 'extra-mcp', `codeagent-${bridgeThread.sessionId}.json`)), '替家里办事的会话不挂 ask_home');
    const note = await until('company sees progress', async () => { const t = (await status(cc)).askHome.find(x => x.id === askThread.id); return /查证据/.test(t?.rounds[0]?.note || '') && t.rounds[0].note; }, 4 * 60000, 3000);
    check('公司看到进度：' + note);
    await click(cc, '#btn-options'); await click(cc, '#options-home-link');
    await until('ask-home list', () => cc.eval('!!document.querySelector("#home-link-dialog[open] [data-hl-sec=ask-home] .hl-item")'), 20000, 500);
    await cc.eval('document.querySelector("[data-hl-sec=ask-home]").scrollIntoView()');
    await shot(cc, '01-company-ask-home-in-progress');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');

    // ---- 7. 公司回执送进家里会话 → 家里答完 → 回复公司 → 送进 CodeAgent 会话 ----
    const done = await until('home replied', async () => { const t = (await status(cc)).askHome.find(x => x.id === askThread.id); return t?.rounds[0]?.reply && t; }, 20 * 60000, 5000);
    const reply = done.rounds[0].reply;
    result.reply = reply.slice(0, 1500);
    result.replyMeta = done.rounds[0].meta;
    assert.equal(done.rounds[0].meta.agent, 'claude');
    assert.ok(done.rounds[0].meta.companyAsks >= 1, '家里回公司查过证据');
    assert.match(reply, /HOME-VERDICT/);
    assert.match(reply, /0\.8|80\s*%/, '回复里有公司代码里的折扣 0.8');
    assert.match(reply, /200/, '回复里有上限 200');
    assert.doesNotMatch(reply, /已用 ask_company 发出|等(待)?公司回执/, '没有把「已发出」当答案');
    const homeQ = (await status(hc)).threads.find(t => t.id === q.id);
    assert.ok(homeQ.rounds.every(r => r.delivered), '公司回执已送进家里会话');
    check(`家里 Claude 拿到公司回执后答完，回复公司（用时 ${Math.round(done.rounds[0].meta.elapsedSec / 60)} 分钟，含回公司查证据 ${done.rounds[0].meta.companyAsks} 次）`);
    const summary = await until('codeagent woke up', async () => {
      const text = await transcript(cc, csid);
      const from = text.lastIndexOf('【家里回复'); const idx = from >= 0 ? text.indexOf('COMPANY-DONE', from + 20) : -1;
      return idx > from && text.slice(idx, idx + 800);
    }, 8 * 60000, 5000);
    result.companySummary = summary.slice(0, 600);
    check('回复送进发起求助的 CodeAgent 会话，它被唤醒并写出 COMPANY-DONE 复述');

    // ---- 8. 界面：两端列表 ----
    await click(cc, '#btn-options'); await click(cc, '#options-home-link');
    await until('replied pill', () => cc.eval('[...document.querySelectorAll("[data-hl-sec=ask-home] .hl-pill.ok")].length>0'), 20000, 500);
    await cc.eval('document.querySelector("[data-hl-sec=ask-home]").scrollIntoView()');
    await shot(cc, '02-company-ask-home-replied');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');
    await click(hc, '#btn-wireless').catch(() => {});
    await until('home consult list', () => hc.eval('[...document.querySelectorAll(".cl-section .wp-item strong")].some(e=>e.textContent.includes(' + j(askThread.id) + '))'), 30000, 1000);
    await hc.eval('[...document.querySelectorAll(".cl-section .cl-sub")].at(-1)?.scrollIntoView()');
    await shot(hc, '03-home-consult-list');
    check('两端界面都列出这次求助（公司「向家里求助」、家里「公司来的求助」）');
    result.passed = true;
  } catch (error) {
    result.error = String(error && error.stack || error);
    log('✘ ' + result.error);
    try { if (cc) fs.writeFileSync(path.join(out, 'company-status.json'), j(await cc.eval('require("electron").ipcRenderer.invoke("bridge:status")'), null, 1)); } catch {}
    try { if (hc) fs.writeFileSync(path.join(out, 'home-status.json'), j(await hc.eval('require("electron").ipcRenderer.invoke("bridge:status")'), null, 1)); } catch {}
  } finally {
    result.elapsedSec = Math.round((Date.now() - t0) / 1000);
    fs.writeFileSync(path.join(out, 'result.json'), j(result, null, 1));
    for (const h of [home, company]) { try { await gracefulQuit(h); } catch {} }
    try { relay?.kill(); } catch {}
    try { proxy?.server.close(); } catch {}
    for (const f of [path.join(root, 'claude-home', '.credentials.json'), path.join(root, 'cac', '.credentials.json'), path.join(root, 'codex', 'auth.json')]) { try { fs.rmSync(f, { force: true }); } catch {} }
    console.log(JSON.stringify({ passed: result.passed, out, elapsedSec: result.elapsedSec }));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
