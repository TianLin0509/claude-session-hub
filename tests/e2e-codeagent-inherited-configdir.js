'use strict';
// 公司 Hub 继承了指向号池号 1 的 CODEAGENT3_CONFIG_DIR（2026-10-19 公司真机事故）真实端到端：
//   node tests/e2e-codeagent-inherited-configdir.js [--out <截图目录>]
// 两台隔离 Hub：家里 = 当前工作区源码；公司 = 当前工作区按公司目标导出、以源码方式启动；中间是真实的通道服务（relay_server.py，绑 localhost）。
// 公司 Hub 启动时环境里带着 CODEAGENT3_CONFIG_DIR=<号池号 1 的目录>，没有显式指定个人目录；USERPROFILE 指到测试目录，
// 所以「默认 ~/.cac」是测试目录里的个人目录（权限 GLM，settings.json 写 GLM），号 1 的目录 settings.json 写 DS。
// CodeAgent 用假程序（tests/fixtures/codeagent-pool-fake，不调用任何模型），它把每次启动拿到的配置目录记到日志。
// 验证：个人会话注入的是真正的个人目录、启动时 settings 里的模型是 GLM；号池会话落在号 1 的目录、个人 settings.json 不被改写；
// 家里「公司电脑状态」卡片标出「Hub 进程继承了一个指向别处的 CodeAgent 配置目录，已忽略」「它指向号 1 的目录」，回报里不带路径和号编号。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const FAKE = path.join(__dirname, 'fixtures', 'codeagent-pool-fake', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261019-personal-configdir-claude1'));
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
const POOL_ID = 'inh0e2e1';
const NOTE = 'Hub 进程继承了一个指向别处的 CodeAgent 配置目录，已忽略';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const settingsModel = dir => { try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).model || ''); } catch { return ''; } };

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-inherited-configdir-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, checks: [],
    scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务（localhost）；公司 Hub 启动环境带 CODEAGENT3_CONFIG_DIR=号 1 目录；CodeAgent 用不调模型的假程序' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc;
  try {
    // ---- 公司版导出 ----
    const exportDir = path.join(root, 'export');
    execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    check(fs.existsSync(path.join(exportDir, 'core', 'codeagent-config.js')) && /inheritedConfigDirInfo/.test(fs.readFileSync(path.join(exportDir, 'core', 'codeagent-config.js'), 'utf8')), '公司版导出完成（带新的个人目录判定）');

    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    // ---- 公司数据：个人目录 = 测试用户目录下的 .cac（GLM）；号池号 1（DS）----
    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    const fakeHome = path.join(root, 'company-userprofile');
    const personal = path.join(fakeHome, '.cac');
    const future = Date.now() + 7 * 86400000;
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e' }); s.db.close(); }
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, '.credentials.json'), j({ idaasOAuth: { accountId: 'w00111111', xAuthExpires: future } }));
    fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: GLM, env: { KEEP_ME: '1' } }, null, 2));
    const poolDir = path.join(cdata, 'codeagent-pool', 'accounts', POOL_ID);
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(cdata, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事的号', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
    fs.writeFileSync(path.join(poolDir, '.credentials.json'), j({ idaasOAuth: { accountId: 'z00222222', xAuthExpires: future } }));
    fs.writeFileSync(path.join(poolDir, 'settings.json'), JSON.stringify({ model: DS }, null, 2));
    fs.writeFileSync(path.join(poolDir, 'hub-models.json'), j({ schema: 1, models: [DS], defaultModel: DS, at: new Date().toISOString() }));
    const work = path.join(root, 'company-work'); fs.mkdirSync(work, { recursive: true });
    const fakeLog = path.join(root, 'codeagent-fake.jsonl');
    const personalMtime0 = fs.statSync(path.join(personal, 'settings.json')).mtimeMs;

    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') };
    const companyEnv = { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), USERPROFILE: fakeHome, HOME: fakeHome,
      // 事故现场：Hub 进程继承了号 1 的目录；没有显式指定个人目录
      CODEAGENT3_CONFIG_DIR: poolDir, AI_HUB_CODEAGENT_CONFIG_DIR: '',
      AI_HUB_CODEAGENT_COMMAND: FAKE, CODEAGENT_POOL_FAKE_LOG: fakeLog, AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
      AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]), AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'inh-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0' } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'inh-company', allowExternalState: true, entryPath: exportDir, extraEnv: companyEnv }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); log('截图 ' + f); return f; };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    await until('renderers', async () => (await hc.eval('typeof window.__wirelessHide==="function"')) && (await cc.eval('typeof sessions!=="undefined" && location.href.includes("index.html")')), 90000, 300);
    check(true, '两台 Hub 都连到主窗口');
    check((await cc.eval('process.env.CODEAGENT3_CONFIG_DIR')) && same(await cc.eval('process.env.CODEAGENT3_CONFIG_DIR'), poolDir), '公司 Hub 的进程环境里确实带着指向号 1 目录的 CODEAGENT3_CONFIG_DIR（事故现场）');

    // ---- 1. 公司 Hub 开个人账号会话：注入的是真正的个人目录，模型 GLM ----
    const ps = await cc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, title: '个人会话' } })})`);
    check(ps && ps.id, '公司 Hub 开了一个个人账号的 CodeAgent 会话 ' + (ps && ps.id));
    const pLaunch = await until('personal launch', async () => readLines(fakeLog).find(x => x.hubSession === ps.id && !x.probe), 60000, 500);
    result.personalLaunch = pLaunch;
    check(same(pLaunch.configDir, personal), '个人会话启动时注入的 CODEAGENT3_CONFIG_DIR 是真正的个人目录（~/.cac），不是继承来的号 1 目录');
    check(settingsModel(pLaunch.configDir) === GLM && !(pLaunch.args || []).some(a => /deepseek/i.test(a)), `个人会话启动时配置目录里的模型是 ${GLM}`);

    // ---- 2. 号池会话：落在号 1 的目录；个人 settings.json 不被改写 ----
    const pool = await cc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, title: '号池会话', codeagentAccount: 'pool' } })})`);
    check(pool && pool.id, '公司 Hub 开了一个号池会话 ' + (pool && pool.id));
    const qLaunch = await until('pool launch', async () => readLines(fakeLog).find(x => x.hubSession === pool.id && !x.probe), 60000, 500);
    check(same(qLaunch.configDir, poolDir) && settingsModel(poolDir) === DS, '号池会话落在号 1 的目录，号 1 的模型仍是 DS');
    await _waitMs(1500);
    check(settingsModel(personal) === GLM && fs.statSync(path.join(personal, 'settings.json')).mtimeMs === personalMtime0, '号 1 开会话后，个人 settings.json 没被改写（模型仍是 GLM、修改时间不变）');
    const synced = JSON.parse(fs.readFileSync(path.join(poolDir, 'settings.json'), 'utf8'));
    check(synced.env && synced.env.KEEP_ME === '1', '号池同步照常：个人的其他设置同步进了号 1 的目录');

    // ---- 3. 配对，家里打开「公司电脑状态」卡片 ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    await until('company version announced', async () => { await hc.eval('require("electron").ipcRenderer.invoke("bridge:check-now")'); return !!(await status(hc)).companyHub.version; }, 120000, 3000);
    check(true, '家里与公司配对接通');
    if (await hc.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await hc.eval('document.getElementById("btn-toggle-navigation").click()');
    await hc.eval('document.getElementById("btn-wireless").click()');
    await until('diag button', () => hc.eval('!!document.querySelector(".cl-section:not([hidden]) [data-cl=diag]")'), 20000, 300);
    await hc.eval('document.querySelector("[data-cl=diag]").scrollIntoView({block:"center"})');
    const p = await hc.eval('(()=>{const r=document.querySelector("[data-cl=diag]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    for (const type of ['mousePressed', 'mouseReleased']) await hc.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await until('card result', () => hc.eval(`(document.querySelector("dialog.cl-diag[open] .cl-diag-body")?.innerText||"").includes(${j('个人配置目录')})`), 150000, 500);
    const view = await hc.eval('require("electron").ipcRenderer.invoke("bridge:diag-result", {})');
    fs.writeFileSync(path.join(out, 'diag-view.json'), JSON.stringify(view, null, 1));
    const pers = view.diag.codeagent.personal;
    result.personalDiag = pers;
    check(pers.configSource === 'ignored-inherited-env' && pers.configModel === GLM && pers.inPool === false,
      `直查：个人目录来源 ignored-inherited-env、settings.json 的 model 是 ${GLM}、个人目录不在号池目录里`);
    check(pers.inheritedConfigDir && pers.inheritedConfigDir.note === NOTE && pers.inheritedConfigDir.inPool === true && pers.inheritedConfigDir.inPoolAlias === '号 1'
      && ['process-only', 'user-env', 'system-env', 'unknown'].includes(pers.inheritedConfigDir.origin),
      `直查标出「${NOTE}」，它指向号 1 的目录；来源层级：${pers.inheritedConfigDir && pers.inheritedConfigDir.origin}`);
    check(pers.inheritedConfigDir.origin === 'process-only', '这台测试机的用户级 / 系统级环境变量里没有它，直查判为「启动 Hub 的进程带进来的」');
    const text = JSON.stringify(view);
    const leaks = [POOL_ID, 'w00111111', 'z00222222', '同事的号', root.replace(/\\/g, '\\\\'), 'codeagent-pool'].filter(s => text.includes(s));
    check(!leaks.length, '回报里没有路径、号编号、工号、备注' + (leaks.length ? '（漏了：' + leaks.join('、') + '）' : ''));
    check(new RegExp(NOTE).test(view.summary), '一句话摘要里也写了已忽略继承的配置目录');
    const cardText = await hc.eval('document.querySelector("dialog.cl-diag").innerText');
    result.cardLine = (cardText.split('\n').find(l => l.includes('个人配置目录')) || '') + ' / ' + (cardText.split('\n').find(l => l.includes('已忽略')) || '');
    check(cardText.includes(NOTE) && /它指向号 1的目录/.test(cardText) && new RegExp(`settings\\.json 的 model：${GLM}`).test(cardText) && /不在号池目录里/.test(cardText) && !cardText.includes('家里'),
      '卡片「CodeAgent」段显示个人配置目录：默认 ~/.cac、settings.json 的 model、不在号池目录里、继承的配置目录已忽略并指向号 1');
    await hc.eval('(()=>{const rows=[...document.querySelectorAll("dialog.cl-diag .wp-row")];const r=rows.find(x=>x.innerText.includes("个人配置目录"));r&&r.scrollIntoView({block:"center"})})()');
    result.shots = [await shot(hc, '01-home-card-personal-configdir')];
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    if (company) await gracefulQuit(company).catch(() => {});
    try { relay && relay.kill(); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
