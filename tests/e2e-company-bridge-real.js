'use strict';
// 家里联动「真实流程」演练（长测，约 10–25 分钟，不进单元测试闸门）。
// 本机起两台隔离 Hub：家里（自用版，Codex 会话当提问的 Agent）和公司（公司一端，CodeAgent 用替身 = 真 Claude Haiku），
// 中间是真实的任务通道服务（company-drop 的 relay_server.py）前面套一层模拟公司代理：可以切到「要求放行」，
// 这时公司一端的请求拿到的是一张网页，界面点「打开放行页」→ 在弹出的窗口里点允许 → 自动接上。
// 全程按真实操作：家里在无线页生成配对码 → 公司在「设置菜单 → 家里联动」粘贴 → 两端接通；
// 公司页填代码位置；家里的 Agent 被要求用 ask_company 提问、收到回执后再追问一轮、最后总结；
// 核对：公司为这个问题新开 1 个 CodeAgent 会话、追问进同一会话、回执不含成段源码、读到了代码里的真实数值，
// 家里 Agent 被回执自动唤醒两次并写出总结。
// 通用场景（2026-10-15 放开成通用助手）：和无线无关的会话里用户说「问一下公司的 CodeAgent」查公司电脑上的周报，
// 核对公司默认权限能跑命令行、回执读到周报里的内容、公司会话没走 /model 菜单。BRIDGE_GENERAL_CHECK=0 跳过。
//   HUB_E2E_TMP=D:/Temp node tests/e2e-company-bridge-real.js
//   COMPANY_ENTRY=<公司版导出目录> 时公司一端跑导出的公司版（不再用角色覆盖）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const L2 = path.join(__dirname, 'fixtures', 'company-bridge', 'l2-code');
const COMPANY_ENTRY = process.env.COMPANY_ENTRY || null;

// 模拟公司代理：/api/* 去掉前缀转给通道服务（同 Caddy）；gate 打开时公司一端的请求拿到放行网页；/ 是放行页，点按钮放行。
function startGateProxy(relayPort) {
  const state = { gate: false, companyBlocked: 0, allowedAt: null };
  const page = '<!doctype html><meta charset="utf-8"><title>访问确认</title><body style="font:16px sans-serif;padding:40px"><h2>公司网络：访问外部网站需要确认</h2><button id="allow" onclick="fetch(\'/allow\',{method:\'POST\'}).then(()=>{document.body.insertAdjacentHTML(\'beforeend\',\'<p id=ok>已允许访问</p>\')})">允许访问</button></body>';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/allow' && req.method === 'POST') { state.gate = false; state.allowedAt = Date.now(); res.end('ok'); return; }
      if (!req.url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
      const fromCompany = /[?&]to=company/.test(req.url) || /"to":"home"/.test(body.toString('utf8'));
      if (state.gate && fromCompany) { state.companyBlocked += 1; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
      const up = http.request({ host: '127.0.0.1', port: relayPort, path: req.url.slice(4), method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', 'content-length': body.length } }, r => {
        res.writeHead(r.statusCode, r.headers); r.pipe(res);
      });
      up.on('error', e => { res.writeHead(502); res.end(String(e)); });
      up.end(body);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, state })));
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'bridge-flow-'));
  const out = path.resolve('artifacts/company-bridge-real-flow', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now(), at = () => Math.round((Date.now() - t0) / 1000) + 's';
  const timeline = [], log = msg => { const line = '[' + at() + '] ' + msg; timeline.push(line); console.log(line); fs.writeFileSync(path.join(out, 'timeline.txt'), timeline.join('\n')); };
  const result = { passed: false, scope: '两台隔离 Hub（家里自用版 + 公司一端' + (COMPANY_ENTRY ? '·公司版导出' : '·角色覆盖') + '）+ 真实通道服务 + 模拟公司代理 + 真实 Codex（家里 Agent）+ CodeAgent 替身（真 Claude Haiku）', root, out, checks: [], timeline };
  const check = msg => { result.checks.push(msg); log('✔ ' + msg); };
  let relay, proxy, home, company, hc, cc;
  try {
    // ---- 通道服务 + 模拟代理 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await wait(200); }
    proxy = await startGateProxy(relayPort);
    const apiUrl = `http://127.0.0.1:${proxy.port}/api`;
    log('通道服务与模拟公司代理已启动：' + apiUrl);

    // ---- 家里 Hub：Codex 登录复制进测试目录 ----
    const hdata = path.join(root, 'home-data'), workspaces = path.join(root, 'workspaces'), cwd = path.join(workspaces, 'superran-pf-align');
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const prov = cfg.providers?.codex || {}, profile = (prov.subscription_profiles || []).find(p => p.id === prov.subscription_profile) || { id: 'default', label: '主账号', home: '' };
    const codexAuth = path.join(profile.home || path.join(os.homedir(), '.codex'), 'auth.json'), codexHome = path.join(root, 'codex');
    for (const d of [codexHome, hdata, cwd]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
    const models = path.join(path.dirname(codexAuth), 'models_cache.json'); if (fs.existsSync(models)) fs.copyFileSync(models, path.join(codexHome, 'models_cache.json'));
    // 技能「问公司」放进测试用的 Codex 目录（命令路径由 Hub 注入的 HUB_BRIDGE_CLI 给出，测试与生产一致）。
    const skillSrc = path.join(os.homedir(), '.codex', 'skills', 'ask-company-codeagent', 'SKILL.md');
    const plainCwd = path.join(workspaces, 'notes-harq'); fs.mkdirSync(plainCwd, { recursive: true });
    if (fs.existsSync(skillSrc)) { fs.mkdirSync(path.join(codexHome, 'skills', 'ask-company-codeagent'), { recursive: true }); fs.copyFileSync(skillSrc, path.join(codexHome, 'skills', 'ask-company-codeagent', 'SKILL.md')); }
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [root, workspaces, cwd, plainCwd].map(p => "[projects.'" + p.toLowerCase() + "']\ntrust_level = \"trusted\"").join('\n') + '\n');
    fs.writeFileSync(path.join(hdata, 'config.json'), j({ providers: { codex: { backend: 'subscription', subscription_profile: profile.id, subscription_profiles: [{ id: profile.id, label: profile.label, home: codexHome }] } } }));
    // ---- 公司 Hub：CodeAgent 替身用真 Claude，凭据复制进它的配置目录 ----
    const cdata = path.join(root, 'company-data'), cac = path.join(root, 'cac'), l2 = path.join(root, 'company-code', 'l2');
    // 公司电脑上的一份非代码资料（不在代码位置里）：通用场景去查它。
    const docs = path.join(root, 'company-docs', 'weekly'); fs.mkdirSync(docs, { recursive: true });
    for (const [d, plan] of [['2026-10-01', '整理 HARQ 统计口径'], ['2026-10-08', '评审 MCS 表'], ['2026-10-15', '联调 PF-Z9 调度器']])
      fs.writeFileSync(path.join(docs, 'weekly-' + d + '.md'), '# 周报 ' + d + '\n\n## 本周进展\n- 例行工作\n\n## 下周计划\n1. ' + plan + '\n2. 例会\n');
    fs.mkdirSync(cac, { recursive: true }); fs.cpSync(L2, l2, { recursive: true });
    const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
      hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'bridge-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl,
          CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '', AI_HUB_WORKSPACE_ROOT: workspaces, CLAUDE_HUB_WIRELESS_TIMER: '0' } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'bridge-company', allowExternalState: true, ...(COMPANY_ENTRY ? { entryPath: COMPANY_ENTRY } : {}),
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), ...(COMPANY_ENTRY ? {} : { CLAUDE_HUB_BRIDGE_ROLE: 'company' }),
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
    await until('renderers', async () => (await hc.eval('typeof window.__wirelessHide==="function"')) && (await cc.eval('typeof window.__hubOpenSession==="function"')), 60000, 300);
    log('两台隔离 Hub 已启动');

    // ---- 1. 配对：家里无线页生成配对码 → 公司「设置菜单 → 家里联动」粘贴 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click(hc, '#btn-toggle-navigation');
    await click(hc, '#btn-wireless');
    await until('company link section', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=create]")'), 20000, 300);
    await click(hc, '.cl-section [data-cl=create]');
    const code = await until('pairing code', () => hc.eval('document.querySelector(".cl-code")?.value || ""'), 15000, 300);
    assert.match(code, /^AIHUB-LINK-1\./);
    await shot(hc, '01-home-pairing-code');
    check('家里无线页生成配对码');
    await click(cc, '#btn-options');
    await until('menu entry', () => cc.eval('!!document.getElementById("options-home-link")'), 15000, 300);
    await click(cc, '#options-home-link');
    await until('dialog', () => cc.eval('!!document.querySelector("#home-link-dialog[open] [data-hl-f=code]")'), 15000, 300);
    await cc.eval('(()=>{const t=document.querySelector("[data-hl-f=code]");t.value=' + j('请在公司 Hub 粘贴：' + code) + ';t.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await click(cc, '[data-hl=pair]');
    await until('company paired', async () => (await status(cc)).link.state === 'paired' || (await cc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")')).link.state === 'paired', 120000, 3000);
    await until('home paired', async () => (await status(hc)).link.state === 'paired', 120000, 2000);
    const hs = await status(hc), cs = await status(cc);
    assert.equal(hs.link.state, 'paired'); assert.equal(cs.link.state, 'paired');
    check('公司粘贴配对码后两端接通（公司换钥，家里收到 hello 回 welcome）');

    // ---- 2. 公司页：填代码位置、检查间隔调到 10 秒（测试加速）----
    await until('settings form', () => cc.eval('!!document.querySelector("[data-hl-f=codeRoots]")'), 20000, 300);
    await cc.eval('(()=>{const t=document.querySelector("[data-hl-f=codeRoots]");t.value=' + j(l2) + ';t.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-hl-f=effort]").value="low";const p=document.querySelector("[data-hl-f=pollSeconds]");p.insertAdjacentHTML("beforeend","<option value=10>10 秒</option>");p.value="10"})()');
    await click(cc, '[data-hl=save]');
    await until('saved', async () => (await status(cc)).settings.codeRoots[0] === l2, 15000, 500);
    await shot(cc, '02-company-dialog-paired');
    check('公司页保存代码位置');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');

    // ---- 3. 公司网络要求放行：公司一端拿到网页 → 界面提示 → 点放行页 → 允许 → 接上 ----
    proxy.state.gate = true;
    log('模拟公司代理：要求重新放行');
    // ---- 4. 家里：在 SuperRAN 目录开 Codex 会话，让 Agent 用 ask_company 提问 ----
    const created = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codex', opts: { cwd, model: 'gpt-6-luna', effort: 'low', title: 'SuperRAN · PF 对齐' } })})`);
    const hsid = created.id;
    log('家里开 Codex 会话 ' + hsid.slice(0, 8));
    const task = ['你在 SuperRAN 里实现 PF 调度，需要和公司 AirView 平台的 L2 实现对齐。这是家里联动的端到端演练，请严格按步骤：',
      '1. 现在调用 ask_company 工具向公司提问（question 用 Markdown）：目的是对齐 PF 调度；要问的点：① 平均吞吐的遗忘因子取值与更新时机；② 没被调度的 UE 怎么更新平均吞吐；③ 新接入 UE 的平均吞吐初值怎么给。家里现在的做法：每 TTI 更新、alpha=0.01；没被调度按 0 吞吐衰减；初值固定 1 kbps。建议去看 src/sched 下 PF 相关文件。title 写「PF 调度对齐」。',
      '2. 调用后立刻结束本轮，只回复一句「已发出」。不要等待、不要查询。',
      '3. 之后你会收到一条以【公司回执 开头的消息（第 1 轮）。收到后，无论是否清楚，都调用一次 followup_company 追问：新 UE 初值的折扣系数和上限分别是多少、单位是什么。追问后结束本轮，只回复「已追问」。',
      '4. 收到第 2 轮回执后，第一行写 HOME-DONE，然后用三句话总结家里与公司实现的差异（要写出具体数值）。'].join('\n');
    const sent = await hc.eval(`require("electron").ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: hsid, text: task })})`);
    assert.notEqual(sent && sent.ok, false, 'send prompt: ' + j(sent));
    const homeThread = await until('home thread', async () => (await status(hc)).threads[0], 6 * 60000, 3000);
    check(`家里 Agent 调用 ask_company 发出问题 ${homeThread.id}（来自会话「${homeThread.session?.title || ''}」）`);
    result.thread = homeThread.id;

    const gate = await until('company sees gate', async () => (await status(cc)).net.gate, 120000, 2000);
    assert.ok(proxy.state.companyBlocked > 0);
    await click(cc, '#btn-options'); await click(cc, '#options-home-link');
    await until('gate banner', () => cc.eval('!!document.querySelector("#home-link-dialog[open] [data-hl=gate]")'), 20000, 500);
    await shot(cc, '03-company-gate-banner');
    check('公司一端识别出「要求放行」：' + gate.url);
    await click(cc, '[data-hl=gate]');
    // 放行窗口是另一个页面：找到它，点「允许访问」，再关掉
    const targets = async () => (await (await fetch(`${company.cdpHttpBase}/json/list`)).json());
    const gateTarget = await until('gate window', async () => (await targets()).find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${proxy.port}`)), 20000, 500);
    const gw = await require('./helpers/cdp-client').connectCDP(gateTarget.webSocketDebuggerUrl);
    await until('allow button', () => gw.eval('!!document.getElementById("allow")'), 15000, 300);
    await gw.eval('document.getElementById("allow").click()');
    await until('allowed', () => gw.eval('!!document.getElementById("ok")'), 10000, 300);
    await gw.eval('window.close()').catch(() => {});
    await until('gate window closed', async () => !(await targets()).some(t => t.id === gateTarget.id), 10000, 500);
    assert.equal(proxy.state.gate, false);
    await until('company gate cleared', async () => !(await status(cc)).net.gate, 60000, 1000);
    check('点放行页里的「允许访问」并关窗后，公司一端自动接上');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');

    // ---- 5. 公司收到问题 → 新开 CodeAgent 会话作答 ----
    const ct = await until('company thread running', async () => (await status(cc)).threads.find(t => t.id === homeThread.id && t.sessionId), 3 * 60000, 2000);
    const companySession = ct.sessionId;
    await until('company session in sidebar', () => cc.eval(`!!document.querySelector('.session-item[data-session-id="${companySession}"]')`), 30000, 500);
    await shot(cc, '04-company-session-in-sidebar');
    check('公司为这个问题新开 CodeAgent 会话 ' + companySession.slice(0, 8) + '，会话栏可见');
    const r1 = await until('round 1 replied', async () => { const t = (await status(hc)).threads.find(x => x.id === homeThread.id); return t && t.rounds[0]?.reply && t; }, 12 * 60000, 5000);
    const reply1 = r1.rounds[0].reply;
    result.reply1 = reply1;
    assert.match(reply1, /1\s*\/\s*64|0\.015625|0\.0156|64/, '回执读到了遗忘因子 1/64');
    assert.doesNotMatch(reply1, /```[^\n]*\n(?:[^\n]*\n){16,}?```/, '回执没有成段源码');
    check('第 1 轮回执到家里：读到了代码里的 alpha = 1/64');

    // ---- 6. 家里 Agent 被回执唤醒 → 追问 → 公司同一会话作答 → 家里总结 ----
    const r2 = await until('round 2 replied', async () => { const t = (await status(hc)).threads.find(x => x.id === homeThread.id); return t && t.rounds[1]?.reply && t; }, 15 * 60000, 5000);
    const companyAfter = await status(cc);
    assert.equal(companyAfter.threads.filter(t => t.id === homeThread.id).length, 1);
    assert.equal(companyAfter.threads.find(t => t.id === homeThread.id).sessionId, companySession, '追问进同一个 CodeAgent 会话');
    const ownSessions = await cc.eval('(async()=>(await require("electron").ipcRenderer.invoke("get-sessions")).filter(x=>x.purpose==="company-bridge").map(x=>x.id))()');
    assert.deepEqual(ownSessions, [companySession], '整个往返只开了 1 个公司会话');
    result.reply2 = r2.rounds[1].reply;
    assert.match(result.reply2, /0\.8|80\s*%/, '第 2 轮读到了折扣 0.8');
    assert.match(result.reply2, /200/, '第 2 轮读到了上限 200 Mbps');
    check('家里 Agent 被唤醒后追问；追问进同一个公司会话，第 2 轮读到折扣 0.8 与上限 200 Mbps');
    // 第 2 轮回执送进会话之后，Agent 的回答里才算总结（提示词本身也含 HOME-DONE 字样）。
    await until('round 2 delivered', async () => (await status(hc)).threads.find(x => x.id === homeThread.id).rounds[1]?.delivered, 8 * 60000, 3000);
    const summary = await until('home summary', async () => {
      const text = await hc.eval(`(async()=>{const s=(await require("electron").ipcRenderer.invoke("get-sessions")).find(x=>x.id===${j(hsid)});const f=s&&s.transcriptPath;return f?require("fs").readFileSync(f,"utf8"):""})()`);
      const from = text.lastIndexOf('第 2 轮'); const idx = from >= 0 ? text.indexOf('HOME-DONE', from) : -1;
      return idx > from && text.slice(idx, idx + 1500);
    }, 8 * 60000, 5000);
    result.summary = summary.slice(0, 1200);
    check('家里 Agent 第二次被唤醒，写出 HOME-DONE 总结');
    const delivered = (await status(hc)).threads.find(x => x.id === homeThread.id).rounds.every(r => r.delivered);
    assert.ok(delivered, '两轮回执都已送达');

    // ---- 6b. 技能自己触发：不在 SuperRAN 目录（没挂 MCP），只提 AirView，看 Agent 会不会按技能用命令问公司 ----
    if (process.env.BRIDGE_SKILL_CHECK !== '0') {
      const plain = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codex', opts: { cwd: plainCwd, model: 'gpt-6-luna', effort: 'medium', title: 'HARQ 参数' } })})`);
      const before = (await status(hc)).threads.length;
      await hc.eval(`require("electron").ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: plain.id, text: '我要在 SuperRAN 里实现下行 HARQ，参数想和公司 AirView 平台的实际代码保持一致：AirView 里每个 UE 的下行 HARQ 进程数和最大重传次数分别是多少？查到后告诉我，并给一句实现建议。' })})`);
      const t2 = await until('skill-triggered thread', async () => (await status(hc)).threads.length > before && (await status(hc)).threads[0], 6 * 60000, 3000);
      assert.equal(t2.sessionId, plain.id, '新问题来自没挂 MCP 的会话（走命令）');
      check(`技能自动触发：没挂 MCP 的会话按技能用 company-ask 命令发出 ${t2.id}`);
      const answer = await until('skill answer', async () => {
        const t = (await status(hc)).threads.find(x => x.id === t2.id);
        if (!t?.rounds[0]?.delivered) return false;
        const text = await hc.eval(`(async()=>{const s=(await require("electron").ipcRenderer.invoke("get-sessions")).find(x=>x.id===${j(plain.id)});const f=s&&s.transcriptPath;return f?require("fs").readFileSync(f,"utf8"):""})()`);
        const from = text.lastIndexOf('第 1 轮'); const tail = from >= 0 ? text.slice(from + 200) : '';
        return /16/.test(tail) && /"role":"assistant"/.test(tail) && tail.slice(0, 4000);
      }, 15 * 60000, 5000);
      result.skillAnswer = answer.slice(0, 600);
      check('回执送回该会话，Agent 给出 16 个进程等结论');
    }

    // ---- 6c. 通用场景：和无线无关的会话，用户点名「问一下公司的 CodeAgent」查公司电脑上的资料 ----
    if (process.env.BRIDGE_GENERAL_CHECK !== '0') {
      const miscCwd = path.join(workspaces, 'notes-misc'); fs.mkdirSync(miscCwd, { recursive: true });
      fs.appendFileSync(path.join(codexHome, 'config.toml'), "[projects.'" + miscCwd.toLowerCase() + "']\ntrust_level = \"trusted\"\n");
      const misc = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codex', opts: { cwd: miscCwd, model: 'gpt-6-luna', effort: 'medium', title: '杂事' } })})`);
      const before = (await status(hc)).threads.length;
      await hc.eval(`require("electron").ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: misc.id, text: '问一下公司的 CodeAgent：公司电脑上 ' + docs + ' 这个目录里有哪些周报？最新一份是哪天的？里面「下周计划」的第一条是什么？请它用命令行列一下目录。查到后告诉我结果。' })})`);
      const t3 = await until('general thread', async () => (await status(hc)).threads.length > before && (await status(hc)).threads[0], 6 * 60000, 3000);
      assert.equal(t3.sessionId, misc.id, '通用请求来自和无线无关的会话');
      check(`通用请求：和无线无关的会话按技能发出 ${t3.id}`);
      const reply3 = await until('general reply', async () => { const t = (await status(hc)).threads.find(x => x.id === t3.id); return t?.rounds[0]?.reply || (t?.rounds[0]?.error && 'ERROR ' + t.rounds[0].error); }, 15 * 60000, 5000);
      result.generalReply = reply3.slice(0, 1500);
      assert.match(reply3, /PF-Z9/, '回执读到了最新周报里的下周计划');
      assert.match(reply3, /2026-10-15/, '回执认出最新一份是 10-15');
      const cThread = (await status(cc)).threads.find(x => x.id === t3.id);
      const cMeta = await cc.eval(`(async()=>(await require("electron").ipcRenderer.invoke("get-sessions")).find(x=>x.id===${j(cThread.sessionId)}))()`);
      const cTranscript = cMeta && cMeta.transcriptPath && fs.existsSync(cMeta.transcriptPath) ? fs.readFileSync(cMeta.transcriptPath, 'utf8') : '';
      result.generalCompanyTools = [...new Set([...cTranscript.matchAll(/"type":"tool_use","id":"[^"]+","name":"([^"]+)"/g)].map(m => m[1]))];
      assert.ok(result.generalCompanyTools.includes('Bash'), '公司默认权限下能跑命令行：' + j(result.generalCompanyTools));
      const buffer = String(await cc.eval(`require("electron").ipcRenderer.invoke('debug:get-session-buffer', ${j(cThread.sessionId)})`) || '');
      assert.doesNotMatch(buffer, /\/model\b/, '公司会话没走 /model 菜单');
      check('公司会话默认可跑命令行（用了 ' + result.generalCompanyTools.join('/') + '）、没走 /model；回执读到最新周报 10-15 的「联调 PF-Z9 调度器」');
      const told = await until('general delivered', async () => {
        const t = (await status(hc)).threads.find(x => x.id === t3.id);
        if (!t?.rounds[0]?.delivered) return false;
        const text = await hc.eval(`(async()=>{const s=(await require("electron").ipcRenderer.invoke("get-sessions")).find(x=>x.id===${j(misc.id)});const f=s&&s.transcriptPath;return f?require("fs").readFileSync(f,"utf8"):""})()`);
        const from = text.lastIndexOf('第 1 轮'); const tail = from >= 0 ? text.slice(from + 200) : '';
        return /PF-Z9/.test(tail) && /"role":"assistant"/.test(tail) && tail.slice(0, 3000);
      }, 10 * 60000, 5000);
      result.generalAnswer = told.slice(0, 600);
      check('回执送回该会话，Agent 把结果告诉用户');
    }

    // ---- 7. 截图：两边的列表与会话 ----
    await click(hc, '#btn-wireless'); await wait(1200);
    await hc.eval('document.querySelector(".cl-section details")?.setAttribute("open","")'); await hc.eval('document.querySelector(".cl-section")?.scrollIntoView()'); await wait(500);
    await shot(hc, '05-home-company-link-list');
    await click(cc, '#btn-options'); await click(cc, '#options-home-link'); await wait(1500);
    await cc.eval('document.querySelector("#home-link-dialog details")?.setAttribute("open","")'); await wait(400);
    await shot(cc, '06-company-dialog-threads');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');
    await cc.eval(`window.__hubOpenSession(${j(companySession)})`); await wait(2500);
    await shot(cc, '07-company-codeagent-card');
    await hc.eval(`window.__hubOpenSession(${j(hsid)})`); await wait(2500);
    await shot(hc, '08-home-agent-card');
    result.companySessionTitle = (await cc.eval(`(async()=>(await require("electron").ipcRenderer.invoke("get-sessions")).find(x=>x.id===${j(companySession)})?.title)()`));
    result.elapsed = at();
    result.passed = true;
    log('全部通过，用时 ' + at());
  } catch (error) {
    result.error = error && error.stack || String(error);
    log('失败：' + (error && error.message));
    for (const [c, n] of [[hc, 'fail-home'], [cc, 'fail-company']]) { if (c) { try { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, n + '.png'), Buffer.from(r.data, 'base64')); } catch {} } }
    for (const [h, n] of [[home, 'home'], [company, 'company']]) { if (h) { try { result[n + 'LogTail'] = h.log().filter(l => /bridge|codeagent|mcp|error/i.test(l)).slice(-60); } catch {} } }
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
    for (const h of [home, company]) { if (h) { try { await gracefulQuit(h); } catch {} } }
    try { relay?.kill(); } catch {}
    try { proxy?.server.close(); } catch {}
    console.log(result.passed ? 'PASS' : 'FAIL', out);
    process.exitCode = result.passed ? 0 : 1;
  }
}
main();
