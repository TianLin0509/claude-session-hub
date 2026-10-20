'use strict';
// 家里按模型给公司派活（2026-10-18，GLM / DeepSeek 分流）真实端到端：
//   node tests/e2e-company-model-route.js [--out <截图目录>]
// 沿用 e2e-company-hub-restart-resume.js 的双 Electron 设施：家里 = 当前工作区源码（角色 home）；
// 公司 = 当前工作区按公司目标导出、以源码方式启动；中间是真实的任务通道服务（company-drop 的 relay_server.py，本机临时目录）。
// 公司的号：个人账号只有 GLM（默认 GLM），号池里一个同事的号只有 DeepSeek（默认 DeepSeek）——田哥说的「两个号各一个模型」。
// CodeAgent 用替身 = 真 Claude Code + Haiku：替身记下每次启动的配置目录和当时 settings.json 里的模型（真 CLI 就按它定模型），
// 公司模型名 Claude 不认识，替身改用 Haiku 跑。
// 流程全按真实路径：配对 → 公司推模型表 → 家里收下（MCP 工具描述里能看到）→ 家里「问公司」命令行 ask --model deepseek-v4-0731
// → 公司在 DS 号开会话、启动时 settings.json 的模型是 DS → 回执带 model 回到家里、送进提问的会话 →
// 再指定 GLM → 开在个人账号；写错模型名 → 家里直接报错列出可选项。两端界面上看到指定的模型。
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
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261018-company-model-route-claude1'));
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731';
const POOL_ID = 'ds0e2e01';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// 替身的配置目录：本机 Claude 凭据 + 一份号池能读的登录信息（工号、到期时间；替身只认 claudeAiOauth，不受影响）。
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

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-model-route-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const nonce = randomBytes(3).toString('hex');
  const result = { passed: false, root, out, checks: [],
    scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务（本机临时）+ 号池（个人 GLM、同事号 DS）+ CodeAgent 替身（真 Claude Code + Haiku，记录启动时号目录里的模型）' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc;
  try {
    // ---- 公司版导出（源码方式运行） ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    check(fs.existsSync(path.join(exportDir, 'core', 'codeagent-model-route.js')) && !fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'home.js')), '公司版导出完成（带按模型派活模块，不带家里一端）');

    // ---- 通道服务 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    // ---- 公司的号：个人账号 GLM；号池里同事的号 DS ----
    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    const codeDir = path.join(root, 'company-code'); fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'README.md'), '# 端到端测试用的代码目录\n');
    const homeWork = path.join(root, 'home-work'); fs.mkdirSync(homeWork, { recursive: true });
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    // 个人账号 settings.json 写的是分档名 GLM-5.2-WX（菜单里只有 GLM-5.2-WX-Auto）：2.1.11 因此把个人账号从模型表里整个去掉（田哥 2026-10-18 反馈）。
    const PERSONAL_TIER = 'GLM-5.2-WX';
    const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: PERSONAL_TIER });
    probed(path.join(cdata, 'codeagent-pool', 'personal-models.json'), [GLM]);
    const poolDir = path.join(cdata, 'codeagent-pool', 'accounts', POOL_ID);
    standinConfig(poolDir, { accountId: 'z00222222', model: DS });
    probed(path.join(poolDir, 'hub-models.json'), [DS]);
    fs.writeFileSync(path.join(cdata, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
    const hcac = standinConfig(path.join(root, 'home-cac'), { model: 'haiku' });
    const launchLog = path.join(root, 'standin-launch.jsonl');

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), AI_HUB_CODEAGENT_COMMAND: STANDIN,
      CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1', CODEAGENT_STANDIN_LAUNCH_LOG: launchLog };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'mr-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0',
          AI_HUB_CODEAGENT_CONFIG_DIR: hcac } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'mr-company', allowExternalState: true, entryPath: exportDir,
        // 2026-10-20：公司 CLI 交互模式不认 --model（替身 IGNORE_MODEL 复现），通道会话要像真人从启动中心新建那样在 /model 菜单里选中号的模型。
        // 菜单里是 Claude 的模型名：GLM → Sonnet（开局是 Haiku，回答换成 Sonnet 才说明菜单选上了），DeepSeek → Haiku。
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000',
          CODEAGENT_STANDIN_IGNORE_MODEL: '1', AI_HUB_CODEAGENT_PICKER_LABELS: j({ [GLM]: 'Sonnet', [DS]: 'Haiku' }) } }),
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
    const sessions = c => c.eval('require("electron").ipcRenderer.invoke("get-sessions")');
    await until('renderers', async () => (await hc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')) && (await cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')), 90000, 300);
    check(true, '两台 Hub 都连到主窗口');

    // ---- 配对（IPC，与界面按钮同一入口）+ 公司设置 ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ codeRoots: [codeDir], effort: 'low' })})`);
    check(true, '家里与公司配对接通');

    // ---- 1. 模型表：公司推，家里收下；MCP 工具描述里能看到 ----
    const companyTable = (await status(cc)).models;
    result.companyTable = companyTable;
    check(companyTable && companyTable.models.map(m => m.id).join(',') === `${GLM},${DS}` && companyTable.models[0].primary === true, '公司汇总出模型表：GLM（日常主力）、DeepSeek，各 1 个号（个人账号 settings.json 写的是分档名也算 GLM）');
    check(!JSON.stringify(companyTable).match(/w00111111|z00222222|同事|ds0e2e01/), '模型表不含工号、备注、号池编号');
    const homeEntry = await until('home models', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return (await status(hc)).companyModels; }, 120000, 3000);
    check(homeEntry.table.models.map(m => m.id).join(',') === `${GLM},${DS}`, '家里收到模型表并存下');
    const endpointFile = path.join(hdata, 'company-bridge', 'mcp-endpoint.json');
    const mcp = spawnSync(process.execPath, [path.join(repo, 'scripts', 'company-bridge-mcp.js')], { input: j({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HUB_BRIDGE_ENDPOINT_FILE: endpointFile } });
    const askTool = JSON.parse(mcp.stdout.trim().split('\n')[0]).result.tools.find(x => x.name === 'ask_company');
    result.askDescriptionTail = askTool.description.slice(-700);
    check(askTool.inputSchema.properties.model && askTool.description.includes(`- ${GLM}（日常主力）：1 个号能用`) && askTool.description.includes(`- ${DS}：1 个号能用`), 'MCP 列工具：ask_company 有 model 参数，描述里带模型表和日常主力标记');

    // ---- 家里提问方：一个 CodeAgent（替身）会话，用「问公司」命令行（和 AI 调 ask_company 同一个本机接口） ----
    const asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: homeWork, title: '家里 · 提问方' } })})`);
    const hsid = asker.id;
    assert.ok(hsid, 'home asker session: ' + j(asker));
    const master = (() => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get().value); } finally { db.close(); } })();
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'), HUB_BRIDGE_ENDPOINT_FILE: endpointFile };
    const cli = args => { const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 90000 }); return JSON.parse(r.stdout); };
    const models = cli(['models']);
    check(models.known && models.models.join(',') === `${GLM},${DS}` && /日常主力/.test(models.text), '命令行 models 看到同一份模型表');
    const bad = cli(['ask', '--text', '这是一个写错模型名的测试问题，请忽略', '--model', 'MiniMax-M2.7']);
    check(bad.ok === false && /公司模型表里没有「MiniMax-M2\.7」。可选：GLM-5\.2-WX-Auto、deepseek-v4-0731/.test(bad.error), '写错模型名：家里直接报错并列出可选项，不发出');

    // ---- 2. 指定 DeepSeek ----
    const tokenDs = 'MODEL-ROUTE-DS-' + nonce;
    const qDs = path.join(root, 'q-ds.md');
    fs.writeFileSync(qDs, `这是 AI Hub「按模型派活」的端到端测试。不需要读任何文件、不需要运行命令，只回答一行：${tokenDs}\n`);
    const askedDs = cli(['ask', '--file', qDs, '--title', '按模型派活 DS', '--model', 'DEEPSEEK-V4-0731']);
    check(askedDs.ok && askedDs.model === DS && /^Q-/.test(askedDs.thread), `家里经命令行指定 ${DS} 发出问题 ${askedDs.thread}（模型名按表里的写法）`);
    const ctDs = await until('company DS session', async () => (await status(cc)).threads.find(t => t.id === askedDs.thread && t.sessionId), 4 * 60000, 2000);
    check(ctDs.model === DS, '公司这条任务记下家里指定的模型');
    const metaDs = await until('company DS meta', async () => (await sessions(cc)).find(x => x.id === ctDs.sessionId), 60000, 1000);
    result.dsSession = { pool: metaDs.codeagentPoolAccount, route: metaDs.codeagentRouteModel, title: metaDs.title, model: metaDs.currentModel };
    check(metaDs.codeagentPoolAccount === POOL_ID && metaDs.codeagentRouteModel === DS, '公司在有 DeepSeek 权限的号（号池里同事的号）开会话');
    check(/^\d{4}-Q\d+-codeagent$/.test(metaDs.title), '特战会话名保持「MMDD-Qn-家里AI」：' + metaDs.title);
    const launchDs = await until('standin launch DS', async () => readLines(launchLog).find(x => x.hubSession === ctDs.sessionId), 60000, 1000);
    result.launchDs = launchDs;
    check(path.resolve(launchDs.configDir).toLowerCase() === path.resolve(poolDir).toLowerCase() && launchDs.settingsModel === DS && launchDs.args.includes('--setting-sources'),
      'CodeAgent 启动时：配置目录是 DS 号的目录，settings.json 的模型是 deepseek-v4-0731，只读账号自己的配置');
    // 菜单选模型的记录（main/ipc/session-handlers.js runCodeAgentPick 写 event=pick）
    const pickLine = sid => { try { return fs.readFileSync(path.join(cdata, 'logs', 'codeagent-model.log'), 'utf8').split('\n')
      .find(l => / event=pick /.test(l) && l.includes(` session=${String(sid).slice(0, 8)} `) && / reason=launch /.test(l)) || ''; } catch { return ''; } };
    const pickDs = await until('DS pick', async () => pickLine(ctDs.sessionId), 90000, 1000);
    result.pickDs = pickDs;
    check(/ ok=true/.test(pickDs) && pickDs.includes(` model=${DS}`), '通道会话开起来后在 /model 菜单里选中 DS 号自己的模型：' + pickDs.slice(25, 160));
    const replyDs = await until('home DS receipt', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === askedDs.thread); return t?.rounds[0]?.reply ? t.rounds[0] : (t?.rounds[0]?.error && 'ERR ' + t.rounds[0].error); }, 8 * 60000, 4000);
    result.replyDs = { text: String(replyDs.reply).slice(0, 300), meta: replyDs.meta };
    check(new RegExp(tokenDs).test(replyDs.reply), '家里收到 DS 这一轮的回执');
    check(replyDs.meta && replyDs.meta.requestedModel === DS && replyDs.meta.model, `回执元数据带模型：指定 ${replyDs.meta.requestedModel}，会话模型 ${replyDs.meta.model}，回答里实际 ${replyDs.meta.actualModel || '（未记录）'}`);
    // Hub 启动时会往个人账号 settings.json 补 hook 配置（原有行为），这里只核对模型没被改。
    check(JSON.parse(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8')).model === PERSONAL_TIER, '个人账号 settings.json 的模型没被改写（仍是分档名 GLM-5.2-WX）');

    // ---- 3. 指定 GLM：开在个人账号 ----
    const tokenGlm = 'MODEL-ROUTE-GLM-' + nonce;
    const qGlm = path.join(root, 'q-glm.md');
    fs.writeFileSync(qGlm, `这是 AI Hub「按模型派活」的端到端测试。不需要读任何文件、不需要运行命令，只回答一行：${tokenGlm}\n`);
    const askedGlm = cli(['ask', '--file', qGlm, '--title', '按模型派活 GLM', '--model', GLM]);
    const ctGlm = await until('company GLM session', async () => (await status(cc)).threads.find(t => t.id === askedGlm.thread && t.sessionId), 4 * 60000, 2000);
    const metaGlm = await until('company GLM meta', async () => (await sessions(cc)).find(x => x.id === ctGlm.sessionId), 60000, 1000);
    const launchGlm = await until('standin launch GLM', async () => readLines(launchLog).find(x => x.hubSession === ctGlm.sessionId), 60000, 1000);
    result.launchGlm = launchGlm;
    check(!metaGlm.codeagentPoolAccount && metaGlm.codeagentRouteModel === GLM && path.resolve(launchGlm.configDir).toLowerCase() === path.resolve(personal).toLowerCase() && launchGlm.settingsModel === PERSONAL_TIER,
      '指定 GLM：开在个人账号（配置目录是个人账号，settings.json 原样是分档名 GLM-5.2-WX）');
    const replyGlm = await until('home GLM receipt', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === askedGlm.thread); return t?.rounds[0]?.reply ? t.rounds[0] : (t?.rounds[0]?.error && 'ERR ' + t.rounds[0].error); }, 8 * 60000, 4000);
    check(new RegExp(tokenGlm).test(replyGlm.reply) && replyGlm.meta.requestedModel === GLM, '家里收到 GLM 这一轮的回执，元数据写明指定 GLM');
    const pickGlm = pickLine(ctGlm.sessionId);
    result.pickGlm = pickGlm; result.replyGlmMeta = replyGlm.meta;
    check(/ ok=true/.test(pickGlm) && pickGlm.includes(` model=${GLM}`), '个人账号的通道会话在菜单里选中 GLM：' + pickGlm.slice(25, 160));
    check(/sonnet/i.test(String(replyGlm.meta.actualModel || '')), `CLI 开局是 Haiku（不认 --model），回答实际用的是菜单选中的 ${replyGlm.meta.actualModel}（替身里 GLM = Sonnet）`);
    check(JSON.parse(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8')).model === PERSONAL_TIER, '菜单选完，个人账号 settings.json 的模型仍是原值');

    // ---- 3b. 不指定模型：个人账号和号池的号交替接活（2026-10-18 田哥反馈 v2.1.11：以前只开号池的号） ----
    // 此刻两个号上各有一个会话（上面的 DS、GLM）；号池号上次分配更早 → 先给号池号；之后号池号会话多一个 → 轮到个人账号。
    const plain = [];
    for (const n of [1, 2]) {
      const token = `MODEL-ROUTE-PLAIN${n}-${nonce}`;
      const file = path.join(root, `q-plain-${n}.md`);
      fs.writeFileSync(file, `这是 AI Hub「不指定模型轮转」的端到端测试。不需要读任何文件、不需要运行命令，只回答一行：${token}\n`);
      const asked = cli(['ask', '--file', file, '--title', `轮转 ${n}`]);
      result[`plainAsk${n}`] = asked;
      const sentPlain = asked.ok && asked.model === '公司默认' && /^Q-/.test(asked.thread || '');
      check(sentPlain, `家里不指定模型发出第 ${n} 个问题 ${asked.thread}（模型：公司默认）` + (sentPlain ? '' : ' ' + j(asked)));
      const ct = await until(`company plain ${n}`, async () => (await status(cc)).threads.find(t => t.id === asked.thread && t.sessionId), 4 * 60000, 2000);
      const launch = await until(`standin launch plain ${n}`, async () => readLines(launchLog).find(x => x.hubSession === ct.sessionId), 60000, 1000);
      plain.push({ thread: asked.thread, token, configDir: path.resolve(launch.configDir).toLowerCase() });
    }
    result.plain = plain;
    check(plain[0].configDir === path.resolve(poolDir).toLowerCase() && plain[1].configDir === path.resolve(personal).toLowerCase(),
      '不指定模型的两个问题交替落在两个号上：第一个号池里同事的号，第二个个人账号');
    for (const p of plain) {
      const reply = await until('home plain receipt', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); const t = (await status(hc)).threads.find(x => x.id === p.thread); return t?.rounds[0]?.reply ? t.rounds[0] : (t?.rounds[0]?.error && 'ERR ' + t.rounds[0].error); }, 8 * 60000, 4000);
      check(new RegExp(p.token).test(reply.reply), `家里收到不指定模型的问题 ${p.thread} 的回执`);
    }
    // ---- 4. 界面：家里「问公司」列表、公司「AI特战队专用功能」任务记录里看到指定的模型 ----
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click(hc, '#btn-toggle-navigation');
    await click(hc, '#btn-wireless');
    await until('home link list', () => hc.eval(`[...document.querySelectorAll('.cl-section .wp-item')].some(e => e.innerText.includes(${j(askedDs.thread)}) && e.innerText.includes('指定模型 ${DS}'))`), 30000, 500);
    await hc.eval(`[...document.querySelectorAll('.cl-section .wp-item')].find(e => e.innerText.includes(${j(askedDs.thread)}))?.scrollIntoView({block:'center'})`);
    await shot(hc, '01-home-company-link-models');
    check(true, '家里无线页「公司联动」列表里，DS 那条写着「指定模型 deepseek-v4-0731」');
    await click(cc, '#btn-options'); await click(cc, '#options-home-link');
    await until('company tasks', () => cc.eval(`[...document.querySelectorAll('#home-link-dialog .hl-item')].some(e => e.innerText.includes(${j(askedDs.thread)}) && e.innerText.includes('指定模型 ${DS}'))`), 30000, 500);
    await cc.eval(`[...document.querySelectorAll('#home-link-dialog .hl-item')].find(e => e.innerText.includes(${j(askedDs.thread)}))?.scrollIntoView({block:'center'})`);
    await shot(cc, '02-company-tasks-models');
    check(true, '公司「AI特战队专用功能」任务记录里，DS 那条写着「指定模型 deepseek-v4-0731」');
    await cc.eval('document.getElementById("home-link-dialog")?.close()');
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
    fs.writeFileSync(path.join(out, '20261018-model-route-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
