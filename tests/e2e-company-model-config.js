'use strict';
// 模型配置有误的避让 + 经授权远程修正个人账号默认模型（2026-10-19）真实端到端：
//   node tests/e2e-company-model-config.js [--out <截图目录>]
// 沿用 e2e-company-quota-route.js 的双 Electron 设施：家里 = 当前工作区源码；公司 = 当前工作区按公司目标导出、以源码方式启动；
// 中间是真实的任务通道服务（company-drop 的 relay_server.py，本机临时目录）。CodeAgent 用替身 = 真 Claude Code + Haiku。
// 复现公司真机（2026-10-19 00:18 直查）：个人账号只有 GLM-5.2-WX-Auto 权限，个人配置目录 settings.json 的 model 却是 deepseek-v4-flash-0731。
// 替身按配置目录里的 standin-model-permissions.json 模拟后端按号校验模型：写的模型不在权限里，请求发到本机假后端，
// 假后端按真机原文回报「模型 "<模型>" 不存在或配置有误，请检查模型配置」，真 Claude Code 把它写成 API 错误消息落进原生记录。
// 流程：家里指定个人账号发问 → 个人账号报模型配置有误 → 个人账号对 DS 避让 → 这一轮自动换到号 1 重做 → 家里拿到回执（写明原因）
// → 家里号表与「公司电脑状态」卡片：个人一行「模型配置有误：请求了 X，该号只有 Y」「默认模型和权限不符」→ 公司「账号与号池」页签同样标出
// → 家里在卡片上点「改成 GLM-5.2-WX-Auto」（二次确认）→ 公司只改个人 settings.json 的 model、留备份、解除避让
// → 新问题用个人账号新开会话（这回请求 GLM，后端放行）并拿到回执。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const BRIDGE_TEST_MASTER = require('node:crypto').randomBytes(32).toString('hex'); // 家里隔离实例的本机密钥（只在测试里指定）

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261019-company-model-config-claude1'));
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731', DS_LABEL = 'DeepSeek-V4-Flash-0731';
const POOL_ID = 'mc0e2e01';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function standinConfig(dir, { accountId, model, extra = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), j({ ...claudeAuth, ...(accountId ? { idaasOAuth: { xAuthToken: 'e2e', accountId, expiresAt: Date.now() + 72 * 3600000 } } : {}) }));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true, ...extra }, null, 2));
  return dir;
}
const probed = (file, models) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, j({ schema: 1, models, defaultModel: models[0], at: new Date().toISOString() })); };
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-model-config-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const nonce = randomBytes(3).toString('hex');
  const result = { passed: false, root, out, checks: [],
    scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务（本机临时）+ 个人账号（权限只有 GLM、settings 写的是 DS）+ 号池号 1（DS）+ CodeAgent 替身（真 Claude Code + Haiku）；后端按号校验模型由替身 + 本机假后端模拟，报错文字是公司真机原文' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc, fake;
  try {
    // ---- 假后端：按真机原文回报模型配置有误（模型取自请求路径 /m/<模型>）----
    const fakeHits = [];
    fake = http.createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
        const m = /^\/m\/([^/]+)\//.exec(req.url || '');
        fakeHits.push({ at: Date.now(), method: req.method, url: req.url });
        if (req.method !== 'POST' || !m) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(j({ type: 'error', error: { type: 'invalid_request_error', message: `模型 "${decodeURIComponent(m[1])}" 不存在或配置有误，请检查模型配置` } }));
      });
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const fakeBase = `http://127.0.0.1:${fake.address().port}`;

    // ---- 公司版导出 ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    check(fs.existsSync(path.join(exportDir, 'core', 'codeagent-personal-model.js')), '公司版导出完成（带个人账号默认模型修正模块）');

    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    const codeDir = path.join(root, 'company-code'); fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'README.md'), '# 端到端测试用的代码目录\n');
    const homeWork = path.join(root, 'home-work'); fs.mkdirSync(homeWork, { recursive: true });
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    // 个人账号：权限只有 GLM，settings.json 却写着 DS（公司真机现状）
    const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: DS, extra: { env: { KEEP_ME: '1' } } });
    fs.writeFileSync(path.join(personal, 'standin-model-permissions.json'), j({ base: fakeBase, allow: [GLM] }));
    probed(path.join(cdata, 'codeagent-pool', 'personal-models.json'), [GLM]);
    const poolDir = path.join(cdata, 'codeagent-pool', 'accounts', POOL_ID);
    standinConfig(poolDir, { accountId: 'z00222222', model: DS });
    fs.writeFileSync(path.join(poolDir, 'standin-model-permissions.json'), j({ base: fakeBase, allow: [DS] }));
    probed(path.join(poolDir, 'hub-models.json'), [DS_LABEL]);
    fs.writeFileSync(path.join(cdata, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
    const hcac = standinConfig(path.join(root, 'home-cac'), { model: 'haiku' });
    const launchLog = path.join(root, 'standin-launch.jsonl');

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), AI_HUB_CODEAGENT_COMMAND: STANDIN,
      CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1', CODEAGENT_STANDIN_LAUNCH_LOG: launchLog };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'mc-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_E2E_BRIDGE_MASTER: BRIDGE_TEST_MASTER, CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0',
          AI_HUB_CODEAGENT_CONFIG_DIR: hcac } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'mc-company', allowExternalState: true, entryPath: exportDir,
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
    const row0 = (homeEntry.table.accountRows || []).find(a => a.alias === '个人');
    check(row0 && !row0.configNote, '还没报过错时，个人一行不标「默认模型和权限不符」（写的值可能是合法的内部别名）');

    // ---- 家里提问方（替身会话）+ 命令行（和 AI 调 ask_company 同一个本机接口） ----
    const asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: homeWork, title: '家里 · 提问方' } })})`);
    const hsid = asker.id;
    const endpointFile = path.join(hdata, 'company-bridge', 'mcp-endpoint.json');
    // 2026-10-20 起家里的本机密钥只在 Hub 内存里、不再落盘：测试经 CLAUDE_HUB_E2E_BRIDGE_MASTER 让隔离实例用同一把，并核对库里没有明文旧值。
    const master = BRIDGE_TEST_MASTER;
    { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { require('node:assert/strict').equal(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get(), undefined, '本机密钥不该明文存在 assistant.sqlite'); } finally { db.close(); } }
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'), HUB_BRIDGE_ENDPOINT_FILE: endpointFile };
    const cli = args => { const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 90000 }); return JSON.parse(r.stdout); };
    const askToken = (n, extra = []) => {
      const token = `MODEL-CONFIG-${n}-${nonce}`;
      const file = path.join(root, `q-${n}.md`);
      fs.writeFileSync(file, `这是 AI Hub「模型配置有误避让」的端到端测试。不需要读任何文件、不需要运行命令，只回答一行：${token}\n`);
      return { token, asked: cli(['ask', '--file', file, '--title', '模型配置 ' + n, ...extra]) };
    };
    const homeReply = thread => until('home receipt ' + thread, async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === thread); return t?.rounds[0]?.reply ? t.rounds[0] : (t?.rounds[0]?.error && 'ERR ' + t.rounds[0].error); }, 8 * 60000, 4000);
    const launchesFor = sid => readLines(launchLog).filter(x => x.hubSession === sid);

    // ---- 1. 指定个人账号发问：报模型配置有误 → 个人账号对 DS 避让 → 换到号 1 重做 ----
    const q1 = askToken(1, ['--account', '个人']);
    check(q1.asked.ok && q1.asked.account === '个人', `家里指定个人账号发出 ${q1.asked.thread}`);
    const firstSession = await until('company first session', async () => (await status(cc)).threads.find(t => t.id === q1.asked.thread && t.sessionId)?.sessionId, 4 * 60000, 2000);
    const firstLaunch = await until('first launch', async () => launchesFor(firstSession)[0], 60000, 1000);
    check(same(firstLaunch.configDir, personal) && firstLaunch.settingsModel === DS, `第一个会话开在个人账号，启动时 settings 里的模型是 ${DS}`);
    const rehomed = await until('rehome', async () => { const t = (await status(cc)).threads.find(x => x.id === q1.asked.thread); return t && t.sessionId && t.sessionId !== firstSession && t.rounds[0].rehomed === 1 ? t : null; }, 5 * 60000, 2000);
    check(fakeHits.some(h => h.method === 'POST' && h.url.includes(encodeURIComponent(DS))), `个人账号的请求按 ${DS} 打到了假后端（${fakeHits.length} 次）`);
    const avoidFile = JSON.parse(fs.readFileSync(path.join(cdata, 'codeagent-pool', 'quota-avoid.json'), 'utf8'));
    const entry = avoidFile.models && avoidFile.models.personal && avoidFile.models.personal[DS];
    result.avoidEntry = entry;
    check(entry && entry.kind === 'model-config' && entry.ruleId === 'codeagent-model-config-v1' && entry.model === DS && j(entry.have) === j([GLM]), '个人账号只对 DS 进入避让：命中真机原文规则，记下请求的模型和该号的权限');
    check(entry.until === null && entry.probeAt - entry.lastHitAt === 6 * 3600000, '不设自动到期，6 小时后允许试一次');
    check(!avoidFile.accounts.personal, '不是整号避让');
    const secondLaunch = await until('second launch', async () => launchesFor(rehomed.sessionId)[0], 60000, 1000);
    check(same(secondLaunch.configDir, poolDir), '这一轮自动换到号 1 新开会话重做');
    const r1 = await homeReply(q1.asked.thread);
    result.reply1 = { text: String(r1.reply).slice(0, 200), meta: r1.meta };
    check(new RegExp(q1.token).test(r1.reply) && r1.meta.rehomedFrom === '个人' && r1.meta.accountAlias === '号 1' && r1.meta.rehomeKind === 'model-config', '家里拿到回执，元数据写明因模型配置有误从个人换到号 1');

    // ---- 2. 家里号表：个人一行写明原因；指定个人账号直接报错不发出 ----
    const models = await until('home table avoid', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const m = cli(['models']); return m.accounts.find(a => a.alias === '个人' && a.avoid) ? m : null; }, 3 * 60000, 5000);
    result.modelsText = models.text;
    check(new RegExp(`个人：.*避让中：模型配置有误：请求了 ${DS}，该号只有 ${GLM}.*可用 set-personal-model 改成 ${GLM}`).test(models.text), '家里号表写明「模型配置有误：请求了 X，该号只有 Y」和修法');
    check(new RegExp(`默认模型和权限不符：settings.json 里写的是 ${DS}，权限只有 ${GLM}`).test(models.text), '报过错之后，家里号表个人一行标出「默认模型和权限不符」并带上 settings 里写的值');
    const bad = cli(['ask', '--text', '指定一个避让中的号试试，应当直接报错不发出', '--account', '个人']);
    check(bad.ok === false && /个人\s?在避让中.*模型配置有误/.test(bad.error), '指定避让中的个人账号：家里直接报错，不发出');

    // ---- 3. 公司「AI特战队专用功能 → 账号与号池」：个人一行标出避让与「默认模型和权限不符」 ----
    await click(cc, '#btn-options'); await click(cc, '#options-home-link');
    await click(cc, '#home-link-dialog [data-hl="tab:pool"]');
    await until('company pool tab', () => cc.eval('!!document.querySelector(\'#home-link-dialog [data-hl-account="personal"] [data-hl="pool-resume:personal"]\')'), 30000, 500);
    const personalRowText = await cc.eval('document.querySelector(\'#home-link-dialog [data-hl-account="personal"]\').innerText');
    result.companyPersonalRow = personalRowText;
    check(/默认模型和权限不符/.test(personalRowText) && new RegExp(`写的是 ${DS}`).test(personalRowText) && /模型配置有误/.test(personalRowText), '公司页签：个人一行显示「模型配置有误」避让和「默认模型和权限不符」');
    const pageText = await cc.eval('document.getElementById("home-link-dialog").innerText');
    check(!/家里/.test(pageText.slice(pageText.indexOf('派活'))), '公司页签的派活说明里没有「家里」字样');
    await cc.eval('document.querySelector(\'#home-link-dialog [data-hl-account="personal"]\').scrollIntoView({block:"center"})');
    await shot(cc, '01-company-pool-tab-model-config');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');

    // ---- 4. 家里「公司电脑状态」卡片：个人一行「改成 GLM」（二次确认）→ 公司只改 model、留备份、解除避让 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click(hc, '#btn-toggle-navigation');
    await click(hc, '#btn-wireless');
    await until('diag button', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=diag]")'), 20000, 300);
    await click(hc, '.cl-section:not([hidden]) [data-cl=diag]');
    const fixBtn = 'dialog.cl-diag[open] [data-diag-act=set-personal-model]';
    await until('fix button', () => hc.eval(`!!document.querySelector(${j(fixBtn)})`), 150000, 1000);
    const cardText = await hc.eval('document.querySelector("dialog.cl-diag").innerText');
    result.cardExcerpt = cardText.slice(cardText.indexOf('号池'), cardText.indexOf('号池') + 700);
    check(new RegExp(`请求了 ${DS}，该号只有 ${GLM}`).test(cardText) && /默认模型和权限不符/.test(cardText) && new RegExp(`改成 ${GLM}`).test(cardText), '卡片：个人一行写明模型配置有误、默认模型和权限不符，给出「改成 GLM-5.2-WX-Auto」');
    check(/codeagent-model-config-v1/.test(cardText) && /不存在或配置有误/.test(cardText), '卡片「API 报错」段列出命中规则的报错原文');
    check(!/mc0e2e01|z00222222|w00111111|同事/.test(cardText), '卡片里没有号池编号、工号、备注');
    await hc.eval(`document.querySelector(${j(fixBtn)}).scrollIntoView({block:"center"})`);
    await shot(hc, '02-home-diag-card-mismatch');
    await hc.eval('window.__confirmText = ""; window.confirm = t => { window.__confirmText = t; return true; }');
    await click(hc, fixBtn);
    const fixedAt = Date.now();
    check(new RegExp(`从「${DS}」改成「${GLM}」.*只影响之后新开的会话`, 's').test(await hc.eval('window.__confirmText')), '修改前二次确认，写明前后值和只影响之后新开的会话');
    const banner = await until('fix result', () => hc.eval('(()=>{const e=document.querySelector("dialog.cl-diag .cl-diag-act-result");return e&&!/执行中/.test(e.innerText)&&/个人账号默认模型 |没改成|没做成|两分钟还没回报/.test(e.innerText)?e.innerText:null})()'), 150000, 1000);
    result.fixBanner = banner;
    check(new RegExp(`个人账号默认模型 ${DS} → ${GLM}.*只影响之后新开的会话，已在跑的会话不动`, 's').test(banner) && !/可用内存/.test(banner),'卡片显示远程修改结果：前后值、只影响之后新开的会话');
    await shot(hc, '03-home-diag-card-fixed');
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag=close]")?.click()');
    const after = JSON.parse(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8'));
    check(after.model === GLM && after.env && after.env.KEEP_ME === '1' && after.permissions && after.permissions.defaultMode === 'bypassPermissions', '个人 settings.json 只改了 model，其余内容原样');
    const backups = fs.readdirSync(personal).filter(n => n.startsWith('settings.json.hub-backup-'));
    check(backups.length === 1 && JSON.parse(fs.readFileSync(path.join(personal, backups[0]), 'utf8')).model === DS, `改前留了备份 ${backups[0]}`);
    check(JSON.parse(fs.readFileSync(path.join(poolDir, 'settings.json'), 'utf8')).model === DS, '号池号 1 的配置没动');
    const avoidAfter = JSON.parse(fs.readFileSync(path.join(cdata, 'codeagent-pool', 'quota-avoid.json'), 'utf8'));
    check(!(avoidAfter.models && avoidAfter.models.personal), '写入成功后解除了个人账号的模型配置避让');
    const actLog = fs.readFileSync(path.join(cdata, 'logs', 'company-act.log'), 'utf8');
    check(/done HA-[\w-]+ set-personal-model/.test(actLog), '公司审计日志记下这次修改');

    // ---- 5. 新问题：用个人账号新开会话（这回请求 GLM，后端放行）并拿到回执 ----
    await until('home table cleared', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const m = cli(['models']); const p = m.accounts.find(a => a.alias === '个人'); return p && !p.avoid ? m : null; }, 3 * 60000, 5000);
    const q2 = askToken(2, ['--account', '个人']);
    check(q2.asked.ok, `家里指定个人账号发出第二个问题 ${q2.asked.thread}`);
    const s2 = await until('company q2 session', async () => (await status(cc)).threads.find(t => t.id === q2.asked.thread && t.sessionId)?.sessionId, 4 * 60000, 2000);
    const l2 = await until('q2 launch', async () => launchesFor(s2)[0], 60000, 1000);
    check(same(l2.configDir, personal) && l2.settingsModel === GLM, `新的通道会话开在个人账号，启动时 settings 里的模型是 ${GLM}`);
    const r2 = await homeReply(q2.asked.thread);
    result.reply2 = { text: String(r2.reply).slice(0, 200), meta: r2.meta };
    check(new RegExp(q2.token).test(r2.reply) && r2.meta.accountAlias === '个人' && !r2.meta.rehomedFrom, '家里拿到个人账号作答的回执（没有换号）');
    // ---- 6. 家里卡片上的「撤销上次修改」（二次确认）→ 改回修改前的值；撤销不清避让、也不越过限频 ----
    while (Date.now() - fixedAt < 62000) await _waitMs(2000); // 同一个动作 60 秒内只做一次
    await click(hc, '.cl-section:not([hidden]) [data-cl=diag]');
    const undoBtn = 'dialog.cl-diag[open] [data-diag-act=set-personal-model-restore]';
    await until('undo button', () => hc.eval(`!!document.querySelector(${j(undoBtn)})`), 150000, 1000);
    check(new RegExp(`撤销上次修改（改回 ${DS}）`).test(await hc.eval(`document.querySelector(${j(undoBtn)}).innerText`)), '卡片个人一行给出「撤销上次修改（改回 deepseek-v4-flash-0731）」');
    check(!(await hc.eval('document.querySelector("dialog.cl-diag").innerText')).includes('清单未经探测'), '探测过的清单不标「未经探测」');
    await hc.eval('window.__confirmText = ""; window.confirm = t => { window.__confirmText = t; return true; }');
    await click(hc, undoBtn);
    check(new RegExp(`撤销上一次.*改回「${DS}」`).test(await hc.eval('window.__confirmText')), '撤销前二次确认');
    const undoBanner = await until('undo result', () => hc.eval('(()=>{const e=document.querySelector("dialog.cl-diag .cl-diag-act-result");return e&&!/执行中/.test(e.innerText)&&/个人账号默认模型 |没改成|没做成|两分钟还没回报/.test(e.innerText)?e.innerText:null})()'), 150000, 1000);
    result.undoBanner = undoBanner;
    check(new RegExp(`个人账号默认模型 ${GLM} → ${DS}（撤销上一次修改`).test(undoBanner), '卡片显示撤销结果：改回修改前的值');
    check(JSON.parse(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8')).model === DS, '个人 settings.json 改回了修改前的值');
    await shot(hc, '04-home-diag-card-undone');
    await hc.eval('document.querySelector("dialog.cl-diag [data-diag=close]")?.click()');
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
    fs.writeFileSync(path.join(out, '20261019-model-config-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
