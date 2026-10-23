'use strict';
// 启动中心手动建的 CodeAgent 会话要按这个号的权限清单起（2026-10-22 田哥公司真机 v3.1.4：用个人账号从启动中心建 codeagent，
// 一开就报「API deepseek 错误」，手动 /model 切一下就好）。真实端到端：
//   node tests/e2e-codeagent-manual-model-permission.js [--out <截图目录>] [--entry <公司版导出目录>] [--probe]
// 隔离 Hub = 当前工作区按公司目标导出（或 --entry 指定的导出目录），以源码方式启动；CodeAgent 用替身（真 Claude Code + Haiku）。
// 现场：个人账号的权限清单只有 GLM-5.2-WX-Auto，而它自己的 settings.json 里写着 deepseek-v4-flash-0731（田哥机器上就是这样）。
// 走真实 UI 点击启动中心 → 用量账号「个人账号」→ 创建，核对四件事：
//   1. 摘要里写这个号会用的模型（GLM），不是只写思考强度、也不是「沿用 CodeAgent 当前模型」；
//   2. 会话卡片的模型就是这个号能用的模型；
//   3. 替身记下的启动参数里带 --model GLM-5.2-WX-Auto（Hub 真按 GLM 起了，不是让 CLI 按配置里的 DS 起）；
//   4. 模型日志留下这一行的缘由（written=DS → use=GLM，reason=off-permission）；
//   5. Hub 确实到 /model 菜单里去选了 GLM（pick 日志 reason=launch + 选失败时留下的屏幕附件写着目标 GLM）——
//      公司 CodeAgent 交互模式不认 --model，真正落地靠这一步。
// 另外核对号池号的手动会话没被这段改动静：启动参数里没有 --model（号池号启动前已按号同步好自己的模型）。
// 已知局限（如实写下）：替身跑的是真 Claude Code，它的 /model 菜单里没有公司模型，所以第 5 项只证到「去选了、目标是 GLM」，
// 「在公司菜单里选中」这一步在 e2e 里确认不了（替身会照常报「没能在 CodeAgent 里切到 GLM」）；菜单选择本身由
// tests/unit-codeagent-model-picker.test.js（真实抓下来的公司菜单）和 tests/unit-codeagent-model-fix-fallback.test.js 覆盖。
// --probe：检查不过也走完全程，把每项结果写进结果文件（用来对照不同版本的导出物）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const codeagentModels = require('../core/codeagent-models');

const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const arg = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(arg('--out') || path.join(repo, 'artifacts', '20261022-codeagent-manual-model-permission-claude1'));
const PROBE = argv.includes('--probe');
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731', POOL_ID = 'mm0e2e01';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// 号的配置目录：个人号写 DS（根因现场），号池号写它自己的 DS。
// 替身要拿一份真 Claude Code 的登录凭证抄进号的目录：凭证固定取用户目录下的那份，不看本进程的 CLAUDE_CONFIG_DIR
// （本仓库的会话自己可能就带着 CLAUDE_CONFIG_DIR，比如 .claude-deepseek，那里面没有凭证文件）。
function standinConfig(dir, { accountId, model }) {
  fs.mkdirSync(dir, { recursive: true });
  const credsFile = process.env.HUB_E2E_CLAUDE_CREDS || path.join(os.homedir(), '.claude', '.credentials.json');
  const claudeAuth = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), j({ ...claudeAuth, idaasOAuth: { xAuthToken: 'e2e', accountId, expiresAt: Date.now() + 72 * 3600000 } }));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }, null, 2));
  return dir;
}
const probed = (file, models) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, j({ schema: 1, models, defaultModel: models[0], at: new Date().toISOString() })); };

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-manual-model-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, entry: null, checks: [], failures: [],
    scope: '真实 Electron（公司版导出物，隔离数据目录）+ 个人账号（权限只有 GLM、配置写着 DS）+ 号池号 1（DS）+ CodeAgent 替身（真 Claude Code + Haiku）；真实鼠标点击启动中心' };
  const check = (ok, label, detail) => {
    if (ok) { result.checks.push(label); log('✔ ' + label); return true; }
    result.failures.push({ label, detail: detail === undefined ? null : detail }); log('✘ ' + label + (detail === undefined ? '' : ' ' + j(detail)));
    if (!PROBE) assert.fail(label + (detail === undefined ? '' : ' ' + j(detail)));
    return false;
  };
  let hub, c;
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: DS });
  probed(path.join(dataDir, 'codeagent-pool', 'personal-models.json'), [GLM]);
  const poolDir = path.join(dataDir, 'codeagent-pool', 'accounts', POOL_ID);
  standinConfig(poolDir, { accountId: 'z00222222', model: DS });
  probed(path.join(poolDir, 'hub-models.json'), [DS]);
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
  const launchLog = path.join(root, 'standin-launch.jsonl');
  const modelLog = path.join(dataDir, 'logs', 'codeagent-model.log');
  const readLaunches = () => { try { return fs.readFileSync(launchLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const readModelLog = () => { try { return fs.readFileSync(modelLog, 'utf8'); } catch { return ''; } };
  const same = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const argsOf = l => (l.args || []).join(' ');
  try {
    // ---- 公司版导出 ----
    let entry = arg('--entry');
    if (entry) entry = path.resolve(entry);
    else {
      entry = path.join(root, 'export');
      execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', entry], { cwd: repo, stdio: 'ignore' });
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(entry, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    }
    result.entry = entry;
    check(fs.existsSync(path.join(entry, 'core', 'codeagent-pool.js')), `公司版导出物就绪：${entry}`);

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'manual-model', allowExternalState: true, entryPath: entry, extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), CLAUDE_CONFIG_DIR: path.join(root, 'hub-claude'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'none'),
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: personal, CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1',
      CODEAGENT_STANDIN_LAUNCH_LOG: launchLog, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000', CLAUDE_HUB_BRIDGE_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, label, ms = 60000) => { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { last = await c.eval(expr); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await sleep(400); } throw Error('timeout: ' + label + ' last=' + j(last)); };
    const soft = async (expr, label, ms) => { try { return await until(expr, label, ms); } catch { return null; } };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); log('截图 ' + f); return f; };
    const click = async selector => {
      await until(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()`, 'clickable ' + selector, 20000);
      const p = await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      await sleep(250);
    };
    // 启动中心的下拉：真实点击控件，再真实点击页面里那一项（列表位置由 e2e-codeagent-launch-account.js 负责核对）
    const choose = async (selector, value) => {
      await click(selector);
      const g = JSON.parse(await until(`(()=>{const p=document.querySelector('.launch-select-popover');if(!p)return '';return JSON.stringify([...p.querySelectorAll('.launch-select-option')].map(o=>o.dataset.value))})()`, 'popover ' + selector, 10000));
      const index = g.indexOf(value);
      if (index < 0) throw Error(`下拉 ${selector} 里没有 ${value}：${j(g)}`);
      await click(`.launch-select-popover .launch-select-option:nth-child(${index + 1})`);
      await until(`!document.querySelector('.launch-select-popover') && document.querySelector(${j(selector)}).value === ${j(value)}`, 'chosen ' + selector, 10000);
      await sleep(300);
    };
    const openLauncher = async () => {
      await click('#btn-new-more');
      await until(`getComputedStyle(document.getElementById('new-session-menu')).display !== 'none'`, 'launch center open', 10000);
      await click('.new-session-option[data-kind="codeagent"]');
      await until(`!document.getElementById('new-session-codeagent-account-field').hidden`, 'codeagent account field', 20000);
    };
    const createSession = async label => {
      const before = await c.eval('[...sessions.keys()].join(",")');
      await click('#new-session-submit');
      const id = await until(`(()=>{const b=${j(before)}.split(',');return [...sessions.keys()].find(k=>!b.includes(k))||''})()`, label + ' session', 30000);
      const meta = JSON.parse(await c.eval(`JSON.stringify((s=>({kind:s.kind,model:s.currentModel,pool:s.codeagentPoolAccount||null}))(sessions.get(${j(id)})))`));
      return { id, meta };
    };
    const openBackstage = async (sid, name) => {
      const row = `.session-item[data-session-id="${sid}"]`;
      await until(`!!document.querySelector(${j(row)})`, 'sidebar row ' + name, 20000);
      await click(row);
      await soft(`activeSessionId===${j(sid)}`, 'selected ' + name, 5000);
      if ((await c.eval('currentView')) === 'pty') { await click('#btn-backstage'); await soft(`currentView==='card'`, 'card', 5000); }
      const t1 = Date.now();
      await click('#btn-backstage');
      const ok = await soft(`(()=>{const t=terminalCache.get(${j(sid)});const el=t&&t.container;const r=el?el.getBoundingClientRect():null;
        let text='';try{const b=t.terminal.buffer.active;for(let i=0;i<b.length;i++){const l=b.getLine(i);if(l)text+=l.translateToString(true)+'\\n';}}catch(e){text=''}
        const hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;
        return currentView==='pty'&&t&&el&&getComputedStyle(el).display!=='none'&&r.width>200&&r.height>100&&(hit&&el.contains(hit))&&text.replace(/\\s+/g,'').length>0?JSON.stringify({ms:0,textLen:text.replace(/\\s+/g,'').length}):''})()`, 'backstage ' + name, 45000);
      const state = JSON.parse(ok || '{"ms":0,"textLen":0,"failed":true}');
      state.ms = Date.now() - t1;
      return state;
    };
    await until('typeof sessions !== "undefined" && location.href.includes("index.html")', 'renderer', 90000);
    await c.eval(`(()=>{window.__e2eErrors=[];const push=(t,m)=>window.__e2eErrors.push({t,m:String(m).slice(0,400),at:Date.now()});const oe=console.error.bind(console);console.error=(...a)=>{push('console.error',a.map(x=>x&&x.stack||x).join(' '));oe(...a)};window.addEventListener('error',e=>push('error',e.error&&e.error.stack||e.message));window.addEventListener('unhandledrejection',e=>push('rejection',e.reason&&e.reason.stack||e.reason));return true})()`);
    check(true, '隔离 Hub（公司版）启动');

    // ---- 1. 个人账号：权限只有 GLM，配置里写着 DS ----
    await openLauncher();
    await choose('#new-session-codeagent-account', 'personal');
    check(await c.eval(`document.getElementById('new-session-model-field').hidden===true`), 'CodeAgent 启动中心没有「模型」下拉（一个账号固定一个模型，回归）');
    // 摘要就是启动会用的模型（改动前这里是空的，只写思考强度）
    const sumText = async want => (await soft(`(()=>{const t=document.getElementById('new-session-summary').textContent;return t.includes(${j(want)})?t:''})()`, 'summary ' + want, 20000))
      || await c.eval(`document.getElementById('new-session-summary').textContent`);
    const sum = await sumText(codeagentModels.modelLabel(GLM));
    result.personalSummary = sum;
    check(sum.includes(codeagentModels.modelLabel(GLM)) && !/沿用 CodeAgent 当前模型/.test(sum),
      `个人账号：摘要写这个号会用的模型（${sum}）`, sum);
    await shot('01-launcher-personal');
    const mine = await createSession('personal');
    result.personalSession = { id: mine.id, meta: mine.meta };
    check(!mine.meta.pool && codeagentModels.normalizeModel((mine.meta.model || {}).id) === GLM,
      `个人账号会话建好、模型是这个号能用的 GLM（${j(mine.meta)}）`, mine.meta);
    // 替身记下的启动参数：Hub 真按 GLM 起，而不是让 CLI 按配置里写的 DS 起
    const launched = await soft(`(()=>{try{const fs=require('fs');return fs.existsSync(${j(launchLog)})?fs.readFileSync(${j(launchLog)},'utf8'):''}catch(e){return ''}})()`, 'launch log', 30000);
    const personalLaunch = readLaunches().find(l => same(l.configDir, personal));
    result.personalLaunch = personalLaunch && { configDir: personalLaunch.configDir, settingsModel: personalLaunch.settingsModel, args: personalLaunch.args };
    check(!!personalLaunch && personalLaunch.settingsModel === DS, '个人账号的替身确实按这个号的配置目录启动（settings.json 里写的是 DS）', result.personalLaunch);
    check(!!personalLaunch && argsOf(personalLaunch).includes(`--model ${GLM}`),
      `个人账号会话启动参数带 --model ${GLM}（${argsOf(personalLaunch || {})}）`, result.personalLaunch);
    check(!!launched, '替身启动日志拿得到');
    // 模型日志里写清楚为什么换模型（排查时看这一行）
    const pickLog = await until(`(()=>{try{const fs=require('fs');const f=${j(modelLog)};return fs.existsSync(f)&&/event=launch-model/.test(fs.readFileSync(f,'utf8'))?fs.readFileSync(f,'utf8'):''}catch(e){return ''}})()`, 'model log', 30000);
    result.modelLog = pickLog.trim().split('\n').slice(-6);
    const line = (pickLog.split('\n').find(l => /event=launch-model/.test(l)) || '');
    check(new RegExp(`written=${DS}`).test(line) && new RegExp(`use=${GLM}`).test(line) && /reason=off-permission/.test(line),
      '模型日志写明了配置里是 DS、启动改用清单里的 GLM（reason=off-permission）', line.trim());
    // 光带 --model 还不够：公司 CodeAgent 交互模式不认这个参数，真正让会话落到 GLM 的是 Hub 在 /model 菜单里选中它
    // （2026-10-13 真机结论）。替身跑的是真 Claude Code，它的菜单里没有公司模型，所以这里能证到两件、证不到第三件：
    //   ① Hub 在新建时确实走了一次菜单选型（pick 日志 reason=launch）；
    //   ② 这次选型的目标就是 GLM（选失败时留下的屏幕附件写着「launch GLM-5.2-WX-Auto：…」，attachment 只在失败时落盘）；
    //   ③ 在公司菜单里真的选中 GLM —— 替身的菜单里没有，证不了，由 tests/unit-codeagent-model-picker.test.js 覆盖。
    const pickLines = await soft(`(()=>{try{const fs=require('fs');const f=${j(modelLog)};const t=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';return /event=pick[^\\n]*reason=launch/.test(t)?t:''}catch(e){return ''}})()`, 'pick attempt', 75000);
    const pickLaunch = pickLines.split('\n').find(l => /event=pick\b/.test(l) && /reason=launch/.test(l)) || '';
    result.pickAttempt = pickLaunch.trim();
    check(/ok=(true|false)/.test(pickLaunch), '新建时 Hub 走了一次启动选型（pick 日志 reason=launch）', pickLaunch.trim());
    const lastScreen = await soft(`(()=>{try{const fs=require('fs');const f=${j(path.join(dataDir, 'logs', 'codeagent-model-picker-last.txt'))};return fs.existsSync(f)?fs.readFileSync(f,'utf8'):''}catch(e){return ''}})()`, 'picker screen', 20000);
    const aimed = (lastScreen.split('\n')[0] || '').trim();
    result.pickTarget = aimed;
    check(new RegExp(`launch ${GLM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}：`).test(aimed),
      `这次选型的目标是 ${GLM}（菜单选失败的屏幕附件第一行）`, aimed);
    const b1 = await openBackstage(mine.id, 'personal');
    result.personalBackstage = b1;
    check(!b1.failed, `个人账号会话点「后台」能打开、看到 CLI 输出（${b1.ms} ms，${b1.textLen} 字）`, b1);
    await shot('02-personal-backstage');

    // ---- 2. 号池号 1（手动选择）：这段不碰它，启动参数里没有 --model ----
    await openLauncher();
    await choose('#new-session-codeagent-account', 'pool-manual');
    await until(`!document.getElementById('new-session-codeagent-pool-field').hidden`, 'pool pick field', 10000);
    await choose('#new-session-codeagent-pool', POOL_ID);
    const sum2 = await sumText(codeagentModels.modelLabel(DS));
    result.poolSummary = sum2;
    check(sum2.includes(codeagentModels.modelLabel(DS)), `号 1：摘要写号 1 的模型（${sum2}）`, sum2);
    const poolSession = await createSession('pool');
    result.poolSession = { id: poolSession.id, meta: poolSession.meta };
    check(poolSession.meta.pool === POOL_ID, `号池会话落在号 1（${j(poolSession.meta)}）`, poolSession.meta);
    await soft(`(()=>{try{const fs=require('fs');const t=fs.readFileSync(${j(launchLog)},'utf8');return (t.match(/\\n/g)||[]).length>=2?t:''}catch(e){return ''}})()`, 'launch log 2', 30000);
    const poolLaunch = readLaunches().find(l => same(l.configDir, poolDir));
    result.poolLaunch = poolLaunch && { configDir: poolLaunch.configDir, settingsModel: poolLaunch.settingsModel, args: poolLaunch.args };
    check(!!poolLaunch && !argsOf(poolLaunch).includes('--model'), '号池号的手动会话照旧不带 --model（启动前已按号同步好自己的模型）', result.poolLaunch);
    const b2 = await openBackstage(poolSession.id, 'pool');
    result.poolBackstage = b2;
    check(!b2.failed, `号池会话点「后台」能打开、看到 CLI 输出（${b2.ms} ms，${b2.textLen} 字）`, b2);
    await shot('03-pool-backstage');

    result.rendererErrors = await c.eval('JSON.stringify(window.__e2eErrors||[])').then(JSON.parse);
    check(!result.rendererErrors.some(e => /TypeError|ReferenceError|is not a function|Cannot read/.test(e.m)), `渲染进程没有脚本错误（共 ${result.rendererErrors.length} 条 console.error）`, result.rendererErrors.slice(0, 8));
    result.passed = result.failures.length === 0;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    if (c) { try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'fail.png'), Buffer.from(s.data, 'base64')); } catch {} }
    try { result.rendererErrors = result.rendererErrors || JSON.parse(await c.eval('JSON.stringify(window.__e2eErrors||[])')); } catch {}
  } finally {
    try { result.hubLog = hub && hub.log().slice(-60); } catch {}
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    for (const dir of [personal, poolDir]) { try { fs.rmSync(path.join(dir, '.credentials.json'), { force: true }); } catch {} }
    fs.writeFileSync(path.join(out, '20261022-manual-model-permission-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, failures: result.failures.map(f => f.label), error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });