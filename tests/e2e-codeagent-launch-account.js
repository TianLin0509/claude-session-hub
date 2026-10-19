'use strict';
// 启动中心按账号建 CodeAgent 会话 + 后台终端（2026-10-19 田哥公司真机 v2.1.15：选个人账号建会话后，
// 新会话和原来号池会话的「后台」都打不开；账号下拉的选项框跑到窗口中间；按账号分别建 GLM / DeepSeek 会话的能力倒退）真实端到端：
//   node tests/e2e-codeagent-launch-account.js [--out <截图目录>] [--entry <公司版导出目录>] [--probe]
//     排查用：[--personal-mode login|flood]（个人账号替身停在登录提示 / 持续刷屏，凭证写成读不懂）
//             [--env KEY=VAL]（给隔离 Hub 加一个环境变量，如 AI_HUB_DISABLE_GPU=1）[--electron-arg <开关>] [--dsf <缩放比例>]
// 隔离 Hub = 当前工作区按公司目标导出（或 --entry 指定的导出目录），以源码方式启动；CodeAgent 用替身（真 Claude Code + Haiku）。
// 公司的号：个人账号只有 GLM-5.2-WX-Auto，号池号 1 只有 DeepSeek。走真实 UI 点击：
//   1. 启动中心选 CodeAgent → 用量账号「个人账号」→ 模型下拉只列 GLM、默认选中 GLM → 创建 → 点「后台」→ 终端可见、有输出；
//   2. 启动中心选「号池 · 手动选择」→ 号 1 → 模型下拉只列 DS、默认选中 DS → 创建 → 点「后台」→ 终端可见、有输出；
//   3. 两个会话来回切、各自再开后台（reopen），输出仍在、不重复；
//   4. 启动中心的下拉（账号、号池账号、模型）：点开后页面内的选项列表在控件正下方（误差 ≤3 px），真实点击选项；
//   5. 从规则、助理、论坛等整页切回会话再点「后台」，终端都能打开（整页面板切换不把终端层留在隐藏状态）。
// --probe：检查不过也走完全程，把每项结果写进结果文件（用来对照不同版本的导出物）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const arg = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(arg('--out') || path.join(repo, 'artifacts', '20261019-codeagent-launch-account-claude1'));
const PROBE = argv.includes('--probe');
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731', POOL_ID = 'la0e2e01';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function standinConfig(dir, { accountId, model }) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'));
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
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-launch-account-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, entry: null, checks: [], failures: [],
    scope: '真实 Electron（公司版导出物，隔离数据目录）+ 个人账号（GLM）+ 号池号 1（DS）+ CodeAgent 替身（真 Claude Code + Haiku，不发提问）；真实鼠标点击启动中心与「后台」' };
  const check = (ok, label, detail) => {
    if (ok) { result.checks.push(label); log('✔ ' + label); return true; }
    result.failures.push({ label, detail: detail === undefined ? null : detail }); log('✘ ' + label + (detail === undefined ? '' : ' ' + j(detail)));
    if (!PROBE) assert.fail(label + (detail === undefined ? '' : ' ' + j(detail)));
    return false;
  };
  let hub, c;
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: GLM });
  probed(path.join(dataDir, 'codeagent-pool', 'personal-models.json'), [GLM]);
  const poolDir = path.join(dataDir, 'codeagent-pool', 'accounts', POOL_ID);
  standinConfig(poolDir, { accountId: 'z00222222', model: DS });
  probed(path.join(poolDir, 'hub-models.json'), [DS]);
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
  const launchLog = path.join(root, 'standin-launch.jsonl');
  // 排查用：--personal-mode login|flood 让个人账号的替身停在登录提示上 / 持续刷屏，并把个人凭证写成 Hub 读不懂的样子（公司 2.1.15 直查：个人「凭证读不到」）
  const personalMode = arg('--personal-mode');
  if (personalMode) {
    fs.writeFileSync(path.join(personal, 'standin-mode.txt'), personalMode);
    fs.writeFileSync(path.join(personal, '.credentials.json'), j({ note: 'expired' }));
    result.personalMode = personalMode;
  }
  const DSF = Number(arg('--dsf') || 1);
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

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'launch-account', allowExternalState: true, entryPath: entry,
      extraArgs: arg('--electron-arg') ? [arg('--electron-arg')] : [], extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'none'),
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: personal, CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1',
      CODEAGENT_STANDIN_LAUNCH_LOG: launchLog, AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000', CLAUDE_HUB_BRIDGE_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      ...(arg('--env') ? Object.fromEntries([arg('--env').split('=')]) : {}) } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: DSF, mobile: false });
    const until = async (expr, label, ms = 60000) => { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { last = await c.eval(expr); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await sleep(400); } throw Error('timeout: ' + label + ' last=' + j(last)); };
    const soft = async (expr, label, ms) => { try { return await until(expr, label, ms); } catch (e) { return null; } };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); log('截图 ' + f); return f; };
    const click = async selector => {
      await until(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()`, 'clickable ' + selector, 20000);
      const p = await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      await sleep(250);
    };
    // 启动中心的下拉：真实点击控件 → 页面内的选项列表出现在控件正下方（量位置、截图）→ 真实点击目标项。
    // 列表的位置：上边贴控件下边（间隔 4 px，误差 ≤3 px）、左边和控件对齐（≤3 px）、宽度不小于控件；下方放不下时翻到上方。
    const popoverGeometry = sel => `JSON.stringify((()=>{const e=document.querySelector(${j(sel)});const p=document.querySelector('.launch-select-popover');if(!e||!p)return null;const r=e.getBoundingClientRect(),q=p.getBoundingClientRect();
      return{select:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),bottom:Math.round(r.bottom)},popover:{x:Math.round(q.x),y:Math.round(q.y),w:Math.round(q.width),h:Math.round(q.height)},placement:p.dataset.placement,
        options:[...p.querySelectorAll('.launch-select-option')].map(o=>({value:o.dataset.value,text:o.textContent,selected:o.getAttribute('aria-selected')==='true'}))}})())`;
    const popoverOk = g => !!g && Math.abs(g.popover.x - g.select.x) <= 3 && g.popover.w >= g.select.w - 1
      && (g.placement === 'above' ? Math.abs(g.popover.y + g.popover.h - (g.select.y - 4)) <= 3 : Math.abs(g.popover.y - (g.select.bottom + 4)) <= 3);
    const popovers = [];
    const choose = async (selector, value, shotName) => {
      await click(selector);
      const g = JSON.parse(await until(`(()=>{const g=${popoverGeometry(selector)};return g&&JSON.parse(g).options.length?g:''})()`, 'popover ' + selector, 10000));
      popovers.push({ selector, ...g });
      check(popoverOk(g), `「${selector}」点开后选项列表在控件正下方（控件下边 ${g.select.bottom}，列表上边 ${g.popover.y}；左边 ${g.select.x} / ${g.popover.x}）`, g);
      if (shotName) await shot(shotName);
      const index = g.options.findIndex(o => o.value === value);
      if (index < 0) throw Error(`下拉 ${selector} 里没有 ${value}：${j(g.options)}`);
      await click(`.launch-select-popover .launch-select-option:nth-child(${index + 1})`);
      await until(`!document.querySelector('.launch-select-popover') && document.querySelector(${j(selector)}).value === ${j(value)}`, 'chosen ' + selector, 10000);
      await sleep(300);
      return g;
    };
    await until('typeof sessions !== "undefined" && location.href.includes("index.html")', 'renderer', 90000);
    await c.eval(`(()=>{window.__e2eErrors=[];const push=(t,m)=>window.__e2eErrors.push({t,m:String(m).slice(0,400),at:Date.now()});const oe=console.error.bind(console);console.error=(...a)=>{push('console.error',a.map(x=>x&&x.stack||x).join(' '));oe(...a)};window.addEventListener('error',e=>push('error',e.error&&e.error.stack||e.message));window.addEventListener('unhandledrejection',e=>push('rejection',e.reason&&e.reason.stack||e.reason));return true})()`);
    check(true, '隔离 Hub（公司版）启动');

    // ---- 启动中心 ----
    const openLauncher = async () => {
      await click('#btn-new-more');
      await until(`getComputedStyle(document.getElementById('new-session-menu')).display !== 'none'`, 'launch center open', 10000);
      await click('.new-session-option[data-kind="codeagent"]');
      await until(`!document.getElementById('new-session-codeagent-account-field').hidden`, 'codeagent account field', 20000);
    };
    const modelState = `JSON.stringify((()=>{const s=document.getElementById('new-session-model');return{value:s.value,text:s.selectedOptions[0]?.textContent||'',options:[...s.options].map(o=>o.value)}})())`;
    // 下拉控件的位置：在启动中心里、可见、不被别的层盖住；同一行的标签在它正上方。
    const geometry = sel => `JSON.stringify((()=>{const e=document.querySelector(${j(sel)});const m=document.getElementById('new-session-menu').getBoundingClientRect();if(!e)return null;const r=e.getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      const lab=e.closest('label')?.querySelector('span')?.getBoundingClientRect();
      return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),bottom:Math.round(r.bottom),menu:{x:Math.round(m.x),y:Math.round(m.y),w:Math.round(m.width),h:Math.round(m.height)},
        inMenu:r.x>=m.x-1&&r.right<=m.right+1&&r.y>=m.y-1&&r.bottom<=m.bottom+1,hit:h===e||e.contains(h),labelAbove:lab?Math.round(r.y-lab.bottom):null,
        transformAncestors:(()=>{const out=[];for(let n=e.parentElement;n;n=n.parentElement){const cs=getComputedStyle(n);if(cs.transform!=='none'||cs.zoom!=='1'||cs.filter!=='none'||cs.contain!=='none'&&cs.contain!=='')out.push((n.id||n.className||n.tagName)+':'+[cs.transform,cs.zoom,cs.filter,cs.contain].join('|'));}return out})()}})())`;
    // 「后台」打开后：当前是终端视图、终端层在屏幕上、正中那个点落在终端里，终端里有 CLI 的输出。
    const terminalState = sid => `JSON.stringify((()=>{const t=terminalCache.get(${j(sid)});const el=t&&t.container;const r=el?el.getBoundingClientRect():null;
      const hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;let text='';try{const b=t.terminal.buffer.active;for(let i=0;i<b.length;i++){const l=b.getLine(i);if(l)text+=l.translateToString(true)+'\\n';}}catch(e){text='ERR '+e.message}
      return{view:currentView,active:activeSessionId,hasCache:!!t,display:el?getComputedStyle(el).display:null,vis:el?getComputedStyle(el).visibility:null,w:r?Math.round(r.width):0,h:r?Math.round(r.height):0,
        hitInTerm:!!(hit&&el&&el.contains(hit)),hitWhat:hit?(hit.id||hit.className||hit.tagName):null,cols:t&&t.terminal?t.terminal.cols:0,rows:t&&t.terminal?t.terminal.rows:0,
        textLen:text.replace(/\\s+/g,'').length,tui:/[╭╰│❯]|Claude Code|CodeAgent v|登录方式|刷新登录凭证/.test(text.split('\\n').filter(x=>!/^PS |--/.test(x)).join('\\n')),tail:text.split('\\n').filter(x=>x.trim()).slice(-6),pressed:document.getElementById('btn-backstage')?.getAttribute('aria-pressed'),btnHidden:document.getElementById('btn-backstage')?.hidden}})())`;
    const openBackstage = async (sid, name) => {
      const row = `.session-item[data-session-id="${sid}"]`;
      await until(`!!document.querySelector(${j(row)})`, 'sidebar row ' + name, 20000);
      await click(row);
      await soft(`activeSessionId===${j(sid)}`, 'selected ' + name, 5000);
      if ((await c.eval('currentView')) === 'pty') { await click('#btn-backstage'); await soft(`currentView==='card'`, 'card', 5000); }
      const t1 = Date.now();
      await click('#btn-backstage');
      const ok = await soft(`(()=>{const s=JSON.parse(${terminalState(sid)});return s.view==='pty'&&s.hasCache&&s.display!=='none'&&s.w>200&&s.h>100&&s.hitInTerm&&s.tui?JSON.stringify(s):''})()`, 'backstage ' + name, 45000);
      const state = JSON.parse(ok || await c.eval(terminalState(sid)));
      state.ms = Date.now() - t1;
      return state;
    };

    // 1. 个人账号
    await openLauncher();
    const accountOpts = await c.eval(`[...document.getElementById('new-session-codeagent-account').options].map(o=>o.value).join(',')`);
    check(accountOpts.includes('personal') && accountOpts.includes('pool-manual'), `用量账号下拉有个人账号与号池（${accountOpts}）`);
    const personalText = await c.eval(`document.querySelector('#new-session-codeagent-account option[value="personal"]').textContent`);
    if (personalMode) check(/登录凭证读不懂/.test(personalText), `个人账号凭证读不懂时，账号下拉写明（${personalText}）`, personalText);
    else check(/w001\*+11/.test(personalText) && !/（/.test(personalText), `个人账号一项带工号掩码、没有登录问题提示（${personalText}）`, personalText);
    await choose('#new-session-codeagent-account', 'personal');
    const g1 = JSON.parse(await c.eval(geometry('#new-session-codeagent-account')));
    result.accountSelectGeometry = g1;
    check(g1 && g1.inMenu && g1.hit && g1.labelAbove != null && g1.labelAbove >= 0 && g1.labelAbove <= 12, '「用量账号」下拉在启动中心里、可点、标签在正上方', g1);
    const personalModels = JSON.parse(await until(`(()=>{const s=JSON.parse(${modelState});return s.text.includes('默认')?JSON.stringify(s):''})()`, 'personal models', 20000));
    result.personalModels = personalModels;
    check(personalModels.options.length === 1 && personalModels.value === '' && personalModels.text === 'GLM-5.2 Auto（默认）',
      `个人账号：模型下拉只有「${personalModels.text}」一项（这个号的默认模型，选中、启动后不切换）`, personalModels);
    const gm = JSON.parse(await c.eval(geometry('#new-session-model')));
    result.modelSelectGeometry = gm;
    check(gm && gm.inMenu && gm.hit, '「模型」下拉在启动中心里、可点', gm);
    await choose('#new-session-model', '', '01b-model-popover-personal');
    await shot('01-launcher-personal');
    const before = await c.eval('[...sessions.keys()].join(",")');
    await click('#new-session-submit');
    const mineId = await until(`(()=>{const b=${j(before)}.split(',');return [...sessions.keys()].find(k=>!b.includes(k))||''})()`, 'personal session', 30000);
    result.personalSession = mineId;
    const mine = await c.eval(`JSON.stringify((s=>({kind:s.kind,model:s.currentModel,pool:s.codeagentPoolAccount||null}))(sessions.get(${j(mineId)})))`);
    result.personalMeta = JSON.parse(mine);
    check(!result.personalMeta.pool && /GLM/i.test(JSON.stringify(result.personalMeta.model)), `个人账号会话建好，没落到号池、显示模型是 GLM（${mine}）`, result.personalMeta);
    await soft(`(()=>{const l=require('fs').existsSync(${j(launchLog)})?require('fs').readFileSync(${j(launchLog)},'utf8'):'';return l.trim().split('\\n').length>=1&&l.length>0})()`, 'launch log 1', 30000);
    const b1 = await openBackstage(mineId, 'personal');
    result.personalBackstage = b1;
    check(b1.view === 'pty' && b1.hitInTerm && b1.tui, `个人账号会话点「后台」能打开、显示 CLI 输出（${b1.ms} ms）`, b1);
    await shot('02-personal-backstage');

    // 2. 号池号 1（手动选择）
    await openLauncher();
    await choose('#new-session-codeagent-account', 'pool-manual', '03a-account-popover');
    await until(`!document.getElementById('new-session-codeagent-pool-field').hidden`, 'pool pick field', 10000);
    await choose('#new-session-codeagent-pool', POOL_ID, '03b-pool-popover');
    const g2 = JSON.parse(await c.eval(geometry('#new-session-codeagent-pool')));
    result.poolSelectGeometry = g2;
    check(g2 && g2.inMenu && g2.hit, '「号池账号」下拉在启动中心里、可点', g2);
    const poolModels = JSON.parse(await until(`(()=>{const s=JSON.parse(${modelState});return s.text===${j(DS + '（默认）')}?JSON.stringify(s):''})()`, 'pool models', 20000));
    result.poolModels = poolModels;
    check(poolModels.options.length === 1 && poolModels.value === '' && poolModels.text === DS + '（默认）', `号 1：模型下拉只有「${poolModels.text}」一项（号 1 的默认模型）`, poolModels);
    await shot('03-launcher-pool');
    // 键盘：Alt+↓ 打开列表，Esc 只关列表、不关启动中心
    const key = async (k, code, vk, modifiers = 0) => { for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(200); };
    await c.eval(`document.getElementById('new-session-codeagent-account').focus()`);
    await key('ArrowDown', 'ArrowDown', 40, 1);
    const kbOpen = await soft(`document.querySelector('.launch-select-popover')?.dataset.for || ''`, 'keyboard popover', 5000);
    await key('Escape', 'Escape', 27);
    const kbClosed = await c.eval(`!document.querySelector('.launch-select-popover') && getComputedStyle(document.getElementById('new-session-menu')).display !== 'none' && document.getElementById('new-session-codeagent-account').value === 'pool-manual'`);
    check(kbOpen === 'new-session-codeagent-account' && kbClosed, 'Alt+↓ 打开「用量账号」列表；Esc 只关列表，启动中心和所选值不变', { kbOpen, kbClosed });
    const before2 = await c.eval('[...sessions.keys()].join(",")');
    await click('#new-session-submit');
    const poolId = await until(`(()=>{const b=${j(before2)}.split(',');return [...sessions.keys()].find(k=>!b.includes(k))||''})()`, 'pool session', 30000);
    result.poolSession = poolId;
    result.poolMeta = JSON.parse(await c.eval(`JSON.stringify((s=>({kind:s.kind,model:s.currentModel,pool:s.codeagentPoolAccount||null}))(sessions.get(${j(poolId)})))`));
    check(result.poolMeta.pool === POOL_ID && /deepseek/i.test(JSON.stringify(result.poolMeta.model)), '号池会话落在号 1、显示模型是 DeepSeek', result.poolMeta);
    const b2 = await openBackstage(poolId, 'pool');
    result.poolBackstage = b2;
    check(b2.view === 'pty' && b2.hitInTerm && b2.tui, `号池会话点「后台」能打开、显示 CLI 输出（${b2.ms} ms）`, b2);
    await shot('04-pool-backstage');

    // 3. 来回切、reopen
    const b3 = await openBackstage(mineId, 'personal-reopen');
    result.personalReopen = b3;
    check(b3.view === 'pty' && b3.hitInTerm && b3.tui, '切回个人账号会话再开后台：仍能打开、有输出', b3);
    const b4 = await openBackstage(poolId, 'pool-reopen');
    result.poolReopen = b4;
    check(b4.view === 'pty' && b4.hitInTerm && b4.tui, '切回号池会话再开后台：仍能打开、有输出', b4);
    await shot('05-reopen');

    // 3b. 后台开出来的号池会话（同 AI特战队通道替人开的：purpose=company-bridge，不抢当前画面），从「特战」筛选里点开再开后台
    const bridge = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, title: '1019-Q13-claude', purpose: 'company-bridge', autonomous: true, codeagentAccount: 'pool', codeagentPoolPick: POOL_ID, effort: 'low' } })})`);
    result.bridgeSession = bridge && bridge.id;
    check(!!(bridge && bridge.id) && (await c.eval('activeSessionId')) !== bridge.id, '后台开出的号池通道会话没有抢当前画面');
    await sleep(1500);
    if ((await c.eval(`document.getElementById('btn-sidebar-wireless')?.getAttribute('aria-pressed')`)) !== 'true') await click('#btn-sidebar-wireless');
    const b5 = await openBackstage(bridge.id, 'bridge');
    result.bridgeBackstage = b5;
    check(b5.view === 'pty' && b5.hitInTerm && b5.tui, `从「特战」里点开号池通道会话，「后台」能打开、有输出（${b5.ms} ms）`, b5);
    await shot('05b-bridge-backstage');
    await click('#btn-sidebar-wireless');
    const b6 = await openBackstage(mineId, 'personal-after-bridge');
    check(b6.view === 'pty' && b6.hitInTerm && b6.tui, '再回到个人账号会话，「后台」仍能打开', b6);

    // 4. 从左侧各个整页（规则、助理、论坛……）回到会话，再点「后台」：整页面板之间切换不能把终端层留在隐藏状态
    const clickable = sel => c.eval(`(()=>{const e=document.querySelector(${j(sel)});if(!e||e.disabled)return false;const r=e.getBoundingClientRect();if(!r.width)return false;const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)})()`);
    const backToSession = async sid => {
      const row = `.session-item[data-session-id="${sid}"]`;
      if (!(await clickable(row))) await click('#btn-home');
      await click(row);
      await soft(`activeSessionId===${j(sid)}`, 'selected', 5000);
      if ((await c.eval('currentView')) === 'pty') { await click('#btn-backstage'); await soft(`currentView==='card'`, 'card', 5000); }
      const t1 = Date.now();
      await click('#btn-backstage');
      const ok = await soft(`(()=>{const s=JSON.parse(${terminalState(sid)});return s.view==='pty'&&s.display!=='none'&&s.w>200&&s.h>100&&s.hitInTerm&&s.tui?JSON.stringify(s):''})()`, 'backstage after nav', 20000);
      const st = JSON.parse(ok || await c.eval(terminalState(sid))); st.ms = Date.now() - t1;
      return st;
    };
    result.navRoutes = [];
    for (const route of [['btn-rules'], ['btn-company-assistant'], ['btn-rules', 'btn-company-assistant'], ['btn-company-forum'], ['btn-rules', 'btn-company-forum'], ['btn-ran'], ['btn-rail-memo'], ['btn-rail-accounts']]) {
      const done = [];
      for (const id of route) { if (await clickable('#' + id)) { await click('#' + id); await sleep(600); done.push(id); } }
      if (!done.length) continue;
      const sid = result.navRoutes.length % 2 ? poolId : mineId;
      const st = await backToSession(sid);
      const ok = st.view === 'pty' && st.hitInTerm && st.tui;
      result.navRoutes.push({ route: done.join('→'), ok, state: ok ? { ms: st.ms } : st });
      check(ok, `从「${done.join(' → ')}」回到会话再点「后台」：终端能打开`, ok ? undefined : st);
      if (!ok) await shot('fail-nav-' + done.join('-'));
    }

    // 实际启动用的号与模型（替身记下的配置目录与 settings.json 的 model）
    const launches = (() => { try { return fs.readFileSync(launchLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
    result.launches = launches.map(l => ({ configDir: l.configDir, settingsModel: l.settingsModel, args: l.args }));
    const same = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    check(launches.some(l => same(l.configDir, personal) && l.settingsModel === GLM), '个人账号会话实际在个人配置目录启动、settings.json 是 GLM', result.launches);
    check(launches.some(l => same(l.configDir, poolDir) && l.settingsModel === DS), '号池会话实际在号 1 的配置目录启动、settings.json 是 DS', result.launches);

    result.rendererErrors = await c.eval('JSON.stringify(window.__e2eErrors||[])').then(JSON.parse);
    check(!result.rendererErrors.some(e => /TypeError|ReferenceError|is not a function|Cannot read/.test(e.m)), `渲染进程没有脚本错误（共 ${result.rendererErrors.length} 条 console.error）`, result.rendererErrors.slice(0, 8));
    result.popovers = popovers;
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
    fs.writeFileSync(path.join(out, '20261019-launch-account-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, failures: result.failures.map(f => f.label), error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
