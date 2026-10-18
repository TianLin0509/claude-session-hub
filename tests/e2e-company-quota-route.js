'use strict';
// 额度感知路由（2026-10-18）真实端到端：
//   node tests/e2e-company-quota-route.js [--out <截图目录>]
// 沿用 e2e-company-model-route.js 的双 Electron 设施：家里 = 当前工作区源码（角色 home）；公司 = 当前工作区按公司目标导出、以源码方式启动；
// 中间是真实的任务通道服务（company-drop 的 relay_server.py，本机临时目录）。
// 公司两个号：个人账号（GLM）、号池里同事的号（号 1，DS）。CodeAgent 用替身 = 真 Claude Code + Haiku。
// 号 1 的配置目录里放 standin-api-base.txt：替身把它的请求发到本测试起的假后端，假后端按真实样本格式回报
// 「token消耗过快， 已达到4亿上限」（2026-10-18 田哥转述的 CodeAgent 后台报错），真 Claude Code 把它写成一条 API 错误消息
// 落进原生记录、显示在屏幕上——和公司 CodeAgent 撞到额度时同一个样子。
// 流程：家里不指定号发问 → 公司挑号 1 → 撞额度 → 号 1 标避让 → 这一轮自动换到个人账号新开会话重做 → 家里拿到回执（写明换号）
// → 新问题不再派给号 1 → 家里模型表、「公司电脑状态」卡片显示号 1 避让中（errors 段带报错原文）→ 公司「账号与号池」页签显示避让中
// → 去掉假后端、家里在卡片上点「恢复派活」（二次确认）→ 新问题又派给号 1 并拿到回执。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261018-company-quota-route-claude1'));
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731';
const POOL_ID = 'qa0e2e01';
// 真实样本（转述）：精确原文待公司直查 errors 段取回后核对
const QUOTA_MESSAGE = 'token消耗过快， 已达到4亿上限';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function standinConfig(dir, { accountId, model }) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), j({ ...claudeAuth, ...(accountId ? { idaasOAuth: { xAuthToken: 'e2e', accountId, expiresAt: Date.now() + 72 * 3600000 } } : {}) }));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ model, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  return dir;
}
const probed = (file, models) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, j({ schema: 1, models, defaultModel: models[0], at: new Date().toISOString() })); };
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-quota-route-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const nonce = randomBytes(3).toString('hex');
  const result = { passed: false, root, out, checks: [], injected: null,
    scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务（本机临时）+ 号池（个人 GLM、号 1 DS）+ CodeAgent 替身（真 Claude Code + Haiku）；号 1 经本机假后端回报真实样本格式的额度错误' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc, fake;
  try {
    // ---- 假后端：号 1 的每个请求都回报额度错误（真实样本文字），记下请求数 ----
    const fakeHits = [];
    fake = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
        fakeHits.push({ at: Date.now(), method: req.method, url: req.url });
        if (req.method !== 'POST') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(j({ type: 'error', error: { type: 'invalid_request_error', message: QUOTA_MESSAGE } }));
      });
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const fakeBase = `http://127.0.0.1:${fake.address().port}`;
    result.injected = { base: fakeBase, status: 400, message: QUOTA_MESSAGE, note: '替身注入：真 Claude Code 把后端错误写成「API Error: 400 {…message…}」；公司 CodeAgent 的真实写法待直查 errors 段核对' };

    // ---- 公司版导出 ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    check(fs.existsSync(path.join(exportDir, 'core', 'codeagent-quota.js')) && fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'quota-watch.js')), '公司版导出完成（带额度感知模块）');

    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    const codeDir = path.join(root, 'company-code'); fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'README.md'), '# 端到端测试用的代码目录\n');
    const homeWork = path.join(root, 'home-work'); fs.mkdirSync(homeWork, { recursive: true });
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: GLM });
    probed(path.join(cdata, 'codeagent-pool', 'personal-models.json'), [GLM]);
    const poolDir = path.join(cdata, 'codeagent-pool', 'accounts', POOL_ID);
    standinConfig(poolDir, { accountId: 'z00222222', model: DS });
    probed(path.join(poolDir, 'hub-models.json'), [DS]);
    fs.writeFileSync(path.join(poolDir, 'standin-api-base.txt'), fakeBase);
    fs.writeFileSync(path.join(cdata, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
    const hcac = standinConfig(path.join(root, 'home-cac'), { model: 'haiku' });
    const launchLog = path.join(root, 'standin-launch.jsonl');

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), AI_HUB_CODEAGENT_COMMAND: STANDIN,
      CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1', CODEAGENT_STANDIN_LAUNCH_LOG: launchLog };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'qr-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0',
          AI_HUB_CODEAGENT_CONFIG_DIR: hcac } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'qr-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); log('截图 ' + path.join(out, name + '.png')); };
    const click = async (c, selector) => {
      await c.eval('document.querySelector(' + j(selector) + ')?.scrollIntoView({block:"center"})');
      await until('clickable ' + selector, () => c.eval('(()=>{const e=document.querySelector(' + j(selector) + ');if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'), 20000, 300);
      const p = await c.eval('(()=>{const r=document.querySelector(' + j(selector) + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    await until('renderers', async () => (await hc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')) && (await cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')), 90000, 300);
    check(true, '两台 Hub 都连到主窗口');

    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ codeRoots: [codeDir], effort: 'low' })})`);
    check(true, '家里与公司配对接通');
    const homeEntry = await until('home models', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return (await status(hc)).companyModels; }, 120000, 3000);
    check((homeEntry.table.accountRows || []).map(a => a.alias).join(',') === '个人,号 1', '家里收到「号 + 模型」表：个人、号 1（只有代称）');

    // ---- 家里提问方（替身会话）+ 命令行（和 AI 调 ask_company 同一个本机接口） ----
    const asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: homeWork, title: '家里 · 提问方' } })})`);
    const hsid = asker.id;
    const endpointFile = path.join(hdata, 'company-bridge', 'mcp-endpoint.json');
    const master = (() => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get().value); } finally { db.close(); } })();
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'), HUB_BRIDGE_ENDPOINT_FILE: endpointFile };
    const cli = args => { const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 90000 }); return JSON.parse(r.stdout); };
    const askToken = (n, extra = []) => {
      const token = `QUOTA-ROUTE-${n}-${nonce}`;
      const file = path.join(root, `q-${n}.md`);
      fs.writeFileSync(file, `这是 AI Hub「额度感知路由」的端到端测试。不需要读任何文件、不需要运行命令，只回答一行：${token}\n`);
      return { token, asked: cli(['ask', '--file', file, '--title', '额度感知 ' + n, ...extra]) };
    };
    const homeReply = thread => until('home receipt ' + thread, async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === thread); return t?.rounds[0]?.reply ? t.rounds[0] : (t?.rounds[0]?.error && 'ERR ' + t.rounds[0].error); }, 8 * 60000, 4000);
    const launchesFor = sid => readLines(launchLog).filter(x => x.hubSession === sid);

    // ---- 1. 不指定号发问：公司挑号 1 → 撞额度 → 换到个人账号重做 ----
    const q1 = askToken(1);
    check(q1.asked.ok && q1.asked.account === '自动路由', `家里不指定号发出 ${q1.asked.thread}`);
    const firstSession = await until('company first session', async () => (await status(cc)).threads.find(t => t.id === q1.asked.thread && t.sessionId)?.sessionId, 4 * 60000, 2000);
    const firstLaunch = await until('first launch', async () => launchesFor(firstSession)[0], 60000, 1000);
    check(same(firstLaunch.configDir, poolDir), '第一个会话开在号 1（号池里同事的号）');
    const rehomed = await until('rehome', async () => { const t = (await status(cc)).threads.find(x => x.id === q1.asked.thread); return t && t.sessionId && t.sessionId !== firstSession && t.rounds[0].rehomed === 1 ? t : null; }, 5 * 60000, 2000);
    check(fakeHits.some(h => h.method === 'POST'), `号 1 的请求打到了假后端（${fakeHits.length} 次）`);
    const avoidFile = JSON.parse(fs.readFileSync(path.join(cdata, 'codeagent-pool', 'quota-avoid.json'), 'utf8'));
    result.avoidEntry = avoidFile.accounts[POOL_ID];
    check(avoidFile.accounts[POOL_ID] && avoidFile.accounts[POOL_ID].source === 'error' && avoidFile.accounts[POOL_ID].ruleId === 'codeagent-token-cap-v1', '号 1 标「避让中」：来源是识别到的报错，命中真实样本规则');
    check(avoidFile.accounts[POOL_ID].until - avoidFile.accounts[POOL_ID].since >= 59 * 60000, '报错里没写重置时间：默认 1 小时后再试');
    const secondLaunch = await until('second launch', async () => launchesFor(rehomed.sessionId)[0], 60000, 1000);
    check(same(secondLaunch.configDir, personal), '这一轮自动换到个人账号新开会话重做');
    const r1 = await homeReply(q1.asked.thread);
    result.reply1 = { text: String(r1.reply).slice(0, 200), meta: r1.meta };
    check(new RegExp(q1.token).test(r1.reply) && r1.meta.rehomedFrom === '号 1' && r1.meta.accountAlias === '个人', '家里拿到回执，元数据写明从号 1 换到个人');

    // ---- 2. 新问题不再派给号 1 ----
    const q2 = askToken(2);
    const s2 = await until('company q2 session', async () => (await status(cc)).threads.find(t => t.id === q2.asked.thread && t.sessionId)?.sessionId, 4 * 60000, 2000);
    const l2 = await until('q2 launch', async () => launchesFor(s2)[0], 60000, 1000);
    check(same(l2.configDir, personal), '新问题派给个人账号，不再派给避让中的号 1');
    check(new RegExp(q2.token).test((await homeReply(q2.asked.thread)).reply), '家里拿到第二个问题的回执');

    // ---- 3. 家里看到号 1 避让：模型表、命令行、MCP 工具描述 ----
    const models = await until('home table avoid', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const m = cli(['models']); return m.accounts.find(a => a.alias === '号 1' && a.avoid) ? m : null; }, 3 * 60000, 5000);
    result.modelsText = models.text;
    check(/号 1：.*避让中：额度上限（报错），预计 .* 恢复：.*token消耗过快/.test(models.text), '家里「号 + 模型」表写明号 1 避让中、原因与预计恢复时间');
    const bad = cli(['ask', '--text', '指定一个避让中的号试试，应当直接报错不发出', '--account', '号1']);
    check(bad.ok === false && /号 1 在避让中.*现在可用：个人/.test(bad.error), '指定避让中的号：家里直接报错并给出可用的号，不发出');
    const mcp = spawnSync(process.execPath, [path.join(repo, 'scripts', 'company-bridge-mcp.js')], { input: j({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8', timeout: 15000, env: { ...process.env, HUB_BRIDGE_ENDPOINT_FILE: endpointFile } });
    const askTool = JSON.parse(mcp.stdout.trim().split('\n')[0]).result.tools.find(x => x.name === 'ask_company');
    check(askTool.inputSchema.properties.account && /各号（account 参数用这里的代称）/.test(askTool.description) && /号 1：.*避让中/.test(askTool.description), 'MCP ask_company 有 account 参数，描述里带各号状态和选择原则');

    // ---- 4. 家里「公司电脑状态」卡片：号池段显示避让、errors 段带报错原文 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click(hc, '#btn-toggle-navigation');
    await click(hc, '#btn-wireless');
    await until('diag button', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=diag]")'), 20000, 300);
    await click(hc, '.cl-section:not([hidden]) [data-cl=diag]');
    await until('card pool', () => hc.eval('!!document.querySelector("dialog.cl-diag[open] [data-diag-act=resume-account][data-account=\\"号 1\\"]")'), 150000, 1000);
    const cardText = await hc.eval('document.querySelector("dialog.cl-diag").innerText');
    result.cardExcerpt = cardText.slice(cardText.indexOf('号池'), cardText.indexOf('号池') + 600);
    check(/避让中/.test(cardText) && /codeagent-token-cap-v1/.test(cardText) && /token消耗过快/.test(cardText), '卡片：号 1 避让中，「API 报错」段列出命中规则的报错原文');
    check(!/qa0e2e01|z00222222|w00111111|同事/.test(cardText), '卡片里没有号池编号、工号、备注');
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag-act=resume-account]").scrollIntoView({block:"center"})');
    await shot(hc, '01-home-diag-card-avoid');

    // ---- 5. 公司「AI特战队专用功能 → 账号与号池」：号 1 避让中，可手动恢复 ----
    await click(cc, '#btn-options'); await click(cc, '#options-home-link');
    await click(cc, '#home-link-dialog [data-hl="tab:pool"]');
    await until('company pool tab', () => cc.eval(`!!document.querySelector('#home-link-dialog [data-hl-quota="${POOL_ID}"] [data-hl="pool-resume:${POOL_ID}"]')`), 30000, 500);
    const poolText = await cc.eval(`document.querySelector('#home-link-dialog [data-hl-quota="${POOL_ID}"]').innerText`);
    check(/避让中/.test(poolText) && /额度上限/.test(poolText), '公司页签：号 1 显示「避让中·额度上限·预计恢复」和「恢复派活」');
    const pageText = await cc.eval('document.getElementById("home-link-dialog").innerText');
    check(!/家里/.test(pageText.slice(pageText.indexOf('派活'))), '公司页签的派活说明里没有「家里」字样');
    await shot(cc, '02-company-pool-tab-avoid');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');

    // ---- 6. 号 1 额度恢复（去掉假后端），家里在卡片上点「恢复派活」（二次确认）→ 新问题派给号 1 ----
    fs.rmSync(path.join(poolDir, 'standin-api-base.txt'), { force: true });
    await hc.eval('window.__confirmText = ""; window.confirm = t => { window.__confirmText = t; return true; }');
    await click(hc, 'dialog.cl-diag [data-diag-act=resume-account]');
    check(/恢复公司派活给「号 1」/.test(await hc.eval('window.__confirmText')), '恢复前二次确认');
    const banner = await until('resume result', () => hc.eval('(()=>{const e=document.querySelector("dialog.cl-diag .cl-diag-act-result");return e&&/可用/.test(e.innerText)?e.innerText:null})()'), 120000, 1000);
    result.resumeBanner = banner;
    check(/号 1：.*→ 可用/.test(banner), '卡片显示远程恢复结果：号 1 → 可用');
    await shot(hc, '03-home-diag-card-resumed');
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag=close]")?.click()');
    const q3 = askToken(3);
    const s3 = await until('company q3 session', async () => (await status(cc)).threads.find(t => t.id === q3.asked.thread && t.sessionId)?.sessionId, 4 * 60000, 2000);
    const l3 = await until('q3 launch', async () => launchesFor(s3)[0], 60000, 1000);
    check(same(l3.configDir, poolDir), '恢复后新问题又派给号 1');
    const r3 = await homeReply(q3.asked.thread);
    check(new RegExp(q3.token).test(r3.reply) && r3.meta.accountAlias === '号 1', '家里拿到号 1 作答的回执');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    try { result.homeLog = home && home.log().slice(-30); } catch {}
    try { result.companyLog = company && company.log().slice(-40); } catch {}
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    if (company) await gracefulQuit(company, { allowAlreadyExited: true }).catch(() => {});
    try { relay && relay.kill(); } catch {}
    try { fake && fake.close(); } catch {}
    fs.writeFileSync(path.join(out, '20261018-quota-route-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
