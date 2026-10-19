'use strict';
// 恢复个人号会话不改个人账号默认模型（2026-10-19 公司真机：Hub 重开、恢复个人号会话的同一秒，
// ~/.cac/settings.json 的 model 从 GLM-5.2-WX-Auto 变回 deepseek-v4-flash-0731）真实端到端：
//   node tests/e2e-codeagent-resume-keeps-default.js [--out <截图目录>]
// 隔离 Hub（当前工作区源码）+ CodeAgent 替身（真 Claude Code + Haiku，菜单回车会把选择写进配置目录 settings.json）。
// 按真实路径：
//   1. 个人账号（settings.json 写 GLM-5.2-WX-Auto，权限清单只有它）新建会话，答一轮；
//   2. 休眠、退出 Hub；把会话存档改成「当初跑的是 DS」：currentModel / codeagentRequestedModel / codeagentActualModel 都是 DS，
//      还带旧版本存下的 codeagentModelPick=true（10-17 晚到 10-19 中午那段时间开的会话就是这样）；
//   3. 重启 Hub、唤醒这个会话，再答一轮；
//   4. 核对：个人 settings.json 的 model 始终是 GLM-5.2-WX-Auto；codeagent-model.log 里这个会话没有 event=pick，
//      恢复那次启动是 requested=(inherit)，没有任何 default-model 变化。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261019-codeagent-resume-keeps-default-claude1'));
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-flash-0731';
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function standinConfig(dir, { accountId, model }) {
  fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), j({ ...claudeAuth, idaasOAuth: { xAuthToken: 'e2e', accountId, expiresAt: Date.now() + 72 * 3600000 } }));
  fs.writeFileSync(path.join(dir, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(dir, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {}, enterpriseModelOptionsCache: [{ value: GLM, label: GLM }] }));
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ model, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  return dir;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resume-default-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const result = { passed: false, root, out, checks: [],
    scope: '真实 Electron（隔离数据目录，重启一次）+ 个人账号只有 GLM + CodeAgent 替身（真 Claude Code + Haiku）；会话存档改成当初跑的是 DS' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let hub, c;
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const personal = standinConfig(path.join(root, 'company-cac'), { accountId: 'w00111111', model: GLM });
  const settingsModel = () => { try { return JSON.parse(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8')).model; } catch { return null; } };
  const modelLog = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8'); } catch { return ''; } };
  const until = async (expr, label, ms = 60000) => { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { last = await c.eval(expr); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await sleep(400); } throw Error('timeout: ' + label + ' last=' + j(last)); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); log('截图 ' + path.join(out, name + '.png')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const ask = async (q, text) => {
    await c.eval(`selectSession(${q})`); await c.eval(`applyViewMode('card')`);
    await click('.floating-input-box');
    await c.send('Input.insertText', { text });
    await click('.floating-input-send');
  };
  const launch = async label => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label, extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'none'),
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: personal, CODEAGENT_STANDIN_MODEL: 'haiku', CODEAGENT_STANDIN_MAP_SETTINGS_MODEL: '1' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && location.href.includes("index.html")', 'renderer', 90000);
  };
  try {
    await launch('resume-default-1');
    check(settingsModel() === GLM, `个人账号 settings.json 起始是 ${GLM}`);
    const mine = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none', title: '恢复-个人账号' } })})`);
    const sid = mine.id, q = j(sid), short = sid.slice(0, 8);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await ask(q, '这是 AI Hub 恢复会话的端到端测试。不需要读文件、不需要运行命令，只回答：好的');
    await until(`(()=>{const s=sessions.get(${q});return s&&s.codeagentActualModel&&getSessionRuntimeTruth(s).state==='completed'?s.codeagentActualModel:''})()`, 'first answer', 300000);
    check(true, '个人账号会话答完第一轮');
    const suspended = await c.eval(`ipcRenderer.invoke('suspend-session', ${q})`);
    check(suspended && suspended.ok, '会话手动休眠');
    await until(`sessions.get(${q})?.status === 'dormant'`, 'dormant', 60000);
    await sleep(4000);
    await c.eval('typeof persistWorkscene === "function" && persistWorkscene(true)');
    await sleep(1500);
    try { c.close(); } catch {}
    await gracefulQuit(hub); hub = null;

    // 存档改成「当初跑的是 DS」，并带旧版本存下的选型标记
    const file = path.join(dataDir, 'sessions', `${sid}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(saved, { currentModel: { id: DS, displayName: DS }, codeagentRequestedModel: DS, codeagentActualModel: DS, codeagentModelPick: true });
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    check(true, '会话存档改成：当前模型、请求模型、实际模型都是 DS，选型标记为 true');
    const logBefore = modelLog().length;

    await launch('resume-default-2');
    await until(`sessions.get(${q})?.status === 'dormant'`, 'dormant after restart', 30000);
    await c.eval(`resumeDormantSession(${q})`);
    await until(`sessions.get(${q}) && sessions.get(${q}).status !== 'dormant' && !sessions.get(${q})._resumePending`, 'resumed', 60000);
    await ask(q, '再回答一次：好的');
    await until(`(()=>{const s=sessions.get(${q});return s&&getSessionRuntimeTruth(s).state==='completed'?'1':''})()`, 'second answer', 300000);
    await sleep(4000); // 菜单回车后 CodeAgent 写配置、Hub 看护轮询都留出时间
    await shot('01-after-resume');
    const tail = modelLog().slice(logBefore);
    result.modelLogTail = tail.split('\n').filter(Boolean).slice(-20);
    check(settingsModel() === GLM, `恢复并答完后个人账号 settings.json 仍是 ${GLM}（实际 ${settingsModel()}）`);
    check(!new RegExp(`event=pick session=${short}`).test(tail), '恢复后这个会话没有驱动 /model 菜单（日志里没有 event=pick）');
    check(new RegExp(`event=launch session=${short} account=个人 kind=codeagent requested=\\(inherit\\)`).test(tail), '恢复那次启动沿用配置目录的默认模型（requested=(inherit)，不带 --model）');
    check(!/event=default-model/.test(tail), '没有任何默认模型变化');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
    if (c) { try { await shot('fail'); } catch {} }
    try { result.hubLog = hub && hub.log().slice(-40); } catch {}
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(path.join(personal, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, '20261019-resume-keeps-default-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
