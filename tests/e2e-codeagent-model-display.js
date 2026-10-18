'use strict';
// CodeAgent 会话的模型显示（2026-10-18 田哥公司真机反馈 v2.1.11：DS 号的会话被标成 GLM、输入框下方只写「CodeAgent 当前模型」）真实端到端：
//   node tests/e2e-codeagent-model-display.js [--out <截图目录>]
// 隔离 Hub（当前工作区源码）+ CodeAgent 替身（真 Claude Code + Haiku）。公司的号：个人账号 settings.json 写的是分档名 GLM-5.2-WX
// （菜单里只有 GLM-5.2-WX-Auto），号池里一个只有 DeepSeek 的号。替身经本机转发访问 Anthropic，转发把回答里的模型名换成
// deepseek-v4-0731（公司 CodeAgent 原生记录里就是这类名字）；HUB_E2E_NO_MODEL_PROXY=1 时不转发，实际模型是 claude-haiku…。
// 按真实操作路径核对：
//   1. 新建个人账号会话、号池会话：第一轮回答前输入框下方就是具体模型（GLM-5.2 Auto / deepseek-v4-0731），不是「CodeAgent 当前模型」；
//   2. 号池会话答完一轮后休眠，重启隔离 Hub：侧栏图标和标签仍是实际模型（不被清单第一项顶成 GLM）；
//   3. 唤醒：恢复出来、新一轮回答前输入框下方仍是实际模型。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http'), https = require('node:https'), tls = require('node:tls');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261018-codeagent-model-display-claude1'));
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731', POOL_ID = 'ds0e2e02';
const useProxy = process.env.HUB_E2E_NO_MODEL_PROXY !== '1';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function standinConfig(dir, { accountId, model }) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), j({ ...claudeAuth, idaasOAuth: { xAuthToken: 'e2e', accountId, expiresAt: Date.now() + 72 * 3600000 } }));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ model, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  return dir;
}
const probed = (file, models) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, j({ schema: 1, models, defaultModel: models[0], at: new Date().toISOString() })); };

// 本机转发：原样转给 api.anthropic.com（本机有 HTTPS_PROXY 时经它的 CONNECT 隧道），回答里 "model":"claude-…" 换成公司模型名。
function modelProxy(model) {
  const swap = s => s.replace(/"model"\s*:\s*"claude-[^"]*"/g, `"model":"${model}"`);
  const upstreamProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const stats = { requests: 0, swapped: 0 };
  const server = http.createServer((req, res) => {
    stats.requests += 1;
    const headers = { ...req.headers, host: 'api.anthropic.com', 'accept-encoding': 'identity' };
    const opts = { host: 'api.anthropic.com', port: 443, path: req.url, method: req.method, headers, agent: false };
    if (upstreamProxy) {
      const u = new URL(upstreamProxy);
      opts.createConnection = (_o, done) => {
        const c = http.request({ host: u.hostname, port: Number(u.port) || 80, method: 'CONNECT', path: 'api.anthropic.com:443' });
        c.on('connect', (r, socket) => r.statusCode === 200 ? done(null, tls.connect({ socket, servername: 'api.anthropic.com' })) : done(new Error('upstream proxy ' + r.statusCode)));
        c.on('error', done); c.end();
      };
    }
    const up = https.request(opts, upRes => {
      const h = { ...upRes.headers }; delete h['content-length']; delete h['content-encoding'];
      res.writeHead(upRes.statusCode, h);
      let buf = '';
      upRes.setEncoding('utf8');
      const flush = text => { const next = swap(text); if (next !== text) stats.swapped += 1; res.write(next); };
      upRes.on('data', d => { buf += d; const i = buf.lastIndexOf('\n'); if (i >= 0) { flush(buf.slice(0, i + 1)); buf = buf.slice(i + 1); } });
      upRes.on('end', () => { if (buf) flush(buf); res.end(); });
    });
    up.on('error', e => { try { res.writeHead(502); res.end(String(e.message)); } catch {} });
    req.pipe(up);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, stats, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-display-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, checks: [], proxy: useProxy,
    scope: '真实 Electron（隔离数据目录，重启一次）+ 号池（个人账号写分档名 GLM-5.2-WX、同事号 DS）+ CodeAgent 替身（真 Claude Code + Haiku' + (useProxy ? '，经本机转发把回答模型名换成 deepseek-v4-0731）' : '）') };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let hub, c, proxy;
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: 'GLM-5.2-WX' });
  probed(path.join(dataDir, 'codeagent-pool', 'personal-models.json'), [GLM]);
  const poolDir = path.join(dataDir, 'codeagent-pool', 'accounts', POOL_ID);
  standinConfig(poolDir, { accountId: 'z00222222', model: DS });
  probed(path.join(poolDir, 'hub-models.json'), [DS]);
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), j({ schema: 1, accounts: [{ id: POOL_ID, note: '同事', createdAt: new Date().toISOString(), lastAssignedAt: 0 }] }));
  const until = async (expr, label, ms = 60000) => { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { last = await c.eval(expr); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await sleep(400); } throw Error('timeout: ' + label + ' last=' + j(last)); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); log('截图 ' + path.join(out, name + '.png')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const chipLabel = `([...document.querySelectorAll('.composer-model')].find(e=>!e.hidden&&e.offsetParent)?.querySelector('.composer-chip-label')?.textContent || '')`;
  const row = sid => `(()=>{const e=document.querySelector('.session-item[data-session-id="${sid}"]');const k=e&&e.querySelector('.sl-kind');return e&&k?JSON.stringify({cls:k.className,title:k.title,aria:e.getAttribute('aria-label')||'',bg:getComputedStyle(k).backgroundImage}):''})()`;
  const launch = async label => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label, extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'none'),
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: personal, CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1',
      ...(proxy ? { CODEAGENT_STANDIN_BASE_URL: proxy.url } : {}) } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && location.href.includes("index.html")', 'renderer', 90000);
  };
  try {
    if (useProxy) proxy = await modelProxy(DS);
    await launch('model-display-1');
    check(true, '隔离 Hub 启动');

    // ---- 1. 第一轮回答前就显示具体模型 ----
    const mine = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none', title: '显示-个人账号' } })})`);
    await until(`!!document.querySelector('.session-item[data-session-id="${mine.id}"]')`, 'personal row', 20000);
    await c.eval(`selectSession(${j(mine.id)})`); await c.eval(`applyViewMode('card')`);
    const mineLabel = await until(`${chipLabel}`, 'personal chip', 20000);
    check(mineLabel === 'GLM-5.2 Auto' && (await c.eval(`sessions.get(${j(mine.id)}).currentModel.id`)) === '',
      `个人账号新会话（settings.json 写分档名 GLM-5.2-WX）第一轮回答前输入框下方显示「${mineLabel}」，内部模型仍为空`);
    const pooled = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none', title: '显示-号池', codeagentAccount: 'pool' } })})`);
    const sid = pooled.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'pool row', 20000);
    await c.eval(`selectSession(${q})`); await c.eval(`applyViewMode('card')`);
    const poolLabel = await until(`${chipLabel}`, 'pool chip', 20000);
    check(poolLabel === DS && (await c.eval(`sessions.get(${q}).codeagentPoolAccount`)) === POOL_ID, `号池会话第一轮回答前输入框下方显示「${poolLabel}」`);
    await shot('01-before-first-answer');

    // ---- 2. 答一轮 → 休眠 → 重启隔离 Hub ----
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: '这是 AI Hub 模型显示的端到端测试。不需要读文件、不需要运行命令，只回答：好的' });
    await click('.floating-input-send');
    const actual = await until(`(()=>{const s=sessions.get(${q});return s&&s.codeagentActualModel&&getSessionRuntimeTruth(s).state==='completed'?s.codeagentActualModel:''})()`, 'first answer', 300000);
    result.actualModel = actual; result.proxyStats = proxy && proxy.stats;
    check(useProxy ? actual === DS : /^claude-/.test(actual), `第一轮回答的实际模型：${actual}`);
    await until(`${chipLabel} === ${j(actual)}`, 'chip actual', 20000);
    await shot('02-after-first-answer');
    const suspended = await c.eval(`ipcRenderer.invoke('suspend-session', ${q})`);
    check(suspended && suspended.ok, '号池会话手动休眠');
    await until(`sessions.get(${q})?.status === 'dormant'`, 'dormant', 60000);
    await sleep(4000); // 等持久化落盘（渲染层 2 秒一批）
    await c.eval('typeof persistWorkscene === "function" && persistWorkscene(true)');
    await sleep(1500);
    try { c.close(); } catch {}
    await gracefulQuit(hub); hub = null;
    log('隔离 Hub 已退出，重新启动');
    await launch('model-display-2');
    await until(`sessions.get(${q})?.status === 'dormant'`, 'dormant after restart', 30000);
    const after = await c.eval(`JSON.stringify((s=>({model:s.currentModel,actual:s.codeagentActualModel}))(sessions.get(${q})))`);
    result.afterRestart = JSON.parse(after);
    check(result.afterRestart.model && result.afterRestart.model.displayName === actual && result.afterRestart.actual === actual,
      `重启后休眠会话的显示模型仍是实际模型（${result.afterRestart.model && result.afterRestart.model.displayName}），不是 GLM 也不是占位`);
    const r = JSON.parse(await until(row(sid), 'row after restart', 20000));
    result.rowAfterRestart = r;
    const logo = useProxy ? 'deepseek' : 'codeagent';
    check(r.cls.includes(`logo-${logo}`) && r.bg.includes(`${logo}.svg`) && r.title.includes(actual) && r.aria.includes(actual),
      `侧栏图标 logo-${logo}、悬停与无障碍标签写 ${actual}`);
    const mineAfter = await c.eval(`sessions.get(${j(mine.id)})?.currentModel?.displayName || ''`);
    check(mineAfter === 'GLM-5.2 Auto', `没答过的个人账号会话重启后仍显示预计模型「${mineAfter}」`);
    await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]')?.scrollIntoView({block:'center'})`);
    await shot('03-after-restart-sidebar');

    // ---- 3. 唤醒：新一轮回答前仍是实际模型 ----
    await c.eval(`resumeDormantSession(${q})`);
    await until(`sessions.get(${q}) && sessions.get(${q}).status !== 'dormant' && !sessions.get(${q})._resumePending`, 'resumed', 60000);
    await c.eval(`selectSession(${q})`); await c.eval(`applyViewMode('card')`);
    const wokeLabel = await until(`${chipLabel}`, 'woke chip', 20000);
    check(wokeLabel === actual, `唤醒后（新一轮回答前）输入框下方仍是「${wokeLabel}」`);
    const woke = JSON.parse(await until(row(sid), 'row after wake', 20000));
    check(woke.cls.includes(`logo-${logo}`), `唤醒后侧栏图标仍是 logo-${logo}`);
    await shot('04-after-wake');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    if (c) { try { await shot('fail'); } catch {} }
    try { result.hubLog = hub && hub.log().slice(-40); } catch {}
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { proxy && proxy.server.close(); } catch {}
    for (const dir of [personal, poolDir]) { try { fs.rmSync(path.join(dir, '.credentials.json'), { force: true }); } catch {} }
    fs.writeFileSync(path.join(out, '20261018-model-display-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, actualModel: result.actualModel, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
