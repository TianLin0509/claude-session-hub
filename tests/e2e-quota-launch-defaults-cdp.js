'use strict';
// Both selectors share one persisted account, ignoring legacy snapshots. Real Hub UI,
// isolated homes and explicit local provider fixtures; no paid model requests.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const baseline = process.argv.includes('--baseline');
const run = `20261016-hub-quota-routing-codex2-${baseline ? 'baseline' : 'fixed'}-${Date.now()}`;
const output = path.resolve('output/playwright', run);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-defaults-'));
const dataDir = path.join(root, 'data');
const home = path.join(root, 'home');
const profiles = [
  { id: 'default', label: '副账号 · DB', home: path.join(home, 'db') },
  { id: 'second', label: '主账号', home: path.join(home, 'main') },
];
for (const dir of [dataDir, output, ...profiles.map(p => p.home)]) fs.mkdirSync(dir, { recursive: true });
const configFile = path.join(dataDir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ custom: 'preserve-me', proxy: '', providers: { codex: {
  backend: 'subscription', subscription_profile: 'default', subscription_profiles: profiles,
} } }));
for (const p of profiles) fs.writeFileSync(path.join(p.home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  id_token: 'x.' + Buffer.from(JSON.stringify({ email: p.id + '@example.com' })).toString('base64url') + '.y',
  access_token: 'fixture-only', refresh_token: 'fixture-only',
} }));
const report = { run, root, passed: false, baseline, checks: [],
  boundary: '真实隔离 Hub 鼠标键盘、配置落盘、子进程账号路由；模型响应使用本地夹具，未发起真实扣费请求' };
let hub, cdp;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function until(expr, label) {
  for (const end = Date.now() + 40000; Date.now() < end;) { if (await cdp.eval(`Boolean(${expr})`)) return; await sleep(100); }
  throw Error('timeout: ' + label);
}
async function click(selector) {
  await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getBoundingClientRect().height>0;})()`, selector);
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
  await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const box = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,top:e.contains(document.elementFromPoint(x,y))};})()`);
  assert(box.top, 'covered: ' + selector); delete box.top;
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
}
async function key(key, code, virtual) {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
}
async function select(selector, value, waitForValue = true) {
  const index = await cdp.eval(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).findIndex(o=>o.value===${JSON.stringify(value)})`);
  assert(index >= 0, 'option missing: ' + value);
  await click(selector); await key('Home', 'Home', 36);
  for (let i = 0; i < index; i++) await key('ArrowDown', 'ArrowDown', 40);
  await key('Enter', 'Enter', 13);
  if (waitForValue) await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, selector + '=' + value);
}
async function shot(name) {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, `${run}-${name}.png`), Buffer.from(image.data, 'base64'));
}
async function start() {
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'quota-launch-defaults', extraEnv: {
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: profiles[0].home,
    CODEX_SQLITE_HOME: '', HUB_CODEX_PROFILE: '', HUB_CODEX_BACKEND: 'subscription',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_HUB_E2E: '1',
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
    CLAUDE_HUB_ACCOUNT_FIXTURE: path.resolve('tests/fixtures/account-center-cli.js'),
    CLAUDE_HUB_LAUNCH_DEFAULTS_FIXTURE: '1', CLAUDE_HUB_AGENT_RUNTIME: 'native',
    CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT: '1', CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR: path.join(root, 'threads'),
    CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR: path.join(root, 'writers'),
    CLAUDE_HUB_NATIVE_FIXTURE_TRACE: path.join(root, 'trace.jsonl'),
  } });
  cdp = await connectFirstPage(hub);
  await until('!!window.WorkspaceController && typeof accountCenterPanel!=="undefined"', 'renderer');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
}
async function stop() {
  if (cdp) { await cdp.close(); cdp = null; }
  if (hub) { fs.appendFileSync(path.join(output, `${run}-hub.log`), hub.log().join('\n') + '\n'); await gracefulQuit(hub); hub = null; }
}
async function openCodex() {
  await click('#btn-new'); await click('.new-session-option[data-kind="codex"]');
  await until('Array.from(document.querySelector("#new-session-model").options).some(o=>o.value==="gpt-6.1-sol") && !document.querySelector("#new-session-account").disabled', 'codex ready');
  await sleep(350);
}
const selection = () => cdp.eval(`Object.fromEntries(['account','model','effort','codex-tier','mcp'].map(id=>[id,document.getElementById('new-session-'+id).value]))`);
async function launchCurrentSelection() {
  const beforeIds = await cdp.eval('[...sessions.keys()]');
  await click('#new-session-submit');
  const idExpr = `[...sessions.values()].find(s=>!${JSON.stringify(beforeIds)}.includes(s.id)&&s.nativeRuntime?.connection==='connected')?.id`;
  await until(idExpr, 'created session connected');
  const id = await cdp.eval(idExpr);
  return cdp.eval(`(()=>{const s=sessions.get(${JSON.stringify(id)});return {id:s.id,profile:s.codexProfile,sessionsRoot:s.codexSessionsRoot,sid:s.codexSid};})()`);
}
(async () => {
  try {
    await start(); await openCodex();
    await select('#new-session-model', 'gpt-6.1-sol');
    await select('#new-session-effort', 'max');
    await select('#new-session-codex-tier', 'fast');
    await select('#new-session-mcp', 'none');
    await click('#new-session-model-default');
    await until('document.querySelector("#new-session-model-default").textContent==="整组默认 ✓"', 'save defaults');
    const before = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(before.launch.defaults.codex.codexProfile, baseline ? 'default' : undefined);
    report.checks.push('启动中心保存模型等默认配置，账号只保留全局一份');
    const oldSession = await launchCurrentSelection();
    assert.equal(oldSession.profile, 'default');
    assert.equal((await cdp.eval(`ipcRenderer.invoke('session:send-prompt',{sessionId:${JSON.stringify(oldSession.id)},text:'preserve history across quota selection',clientSubmissionId:'quota-history-once'})`)).ok, true);
    await until(`sessions.get(${JSON.stringify(oldSession.id)})?.nativeRuntime?.state==='completed'`, 'old account history saved');
    await click('#btn-rail-accounts');
    await click('[data-ac="codex-quota"][data-profile="second"]');
    await until('document.querySelector("[data-ac=codex-quota][data-profile=second]").textContent==="当前用量账号"', 'select main quota');
    await shot('account-tab');
    const after = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    report.saved = { accountTab: after.providers.codex.subscription_profile, launchAccount: after.launch.defaults.codex.codexProfile };
    assert.equal(report.saved.accountTab, 'second');
    assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(oldSession.id)}).codexProfile`), 'default');
    assert.equal(after.custom, 'preserve-me');
    const { codexProfile: beforeProfile, ...beforeTuning } = before.launch.defaults.codex;
    const { codexProfile: afterProfile, ...afterTuning } = after.launch.defaults.codex;
    assert.deepEqual(afterTuning, beforeTuning); assert.deepEqual(after.models, before.models);
    await click('#account-page [data-ac="close"]'); await openCodex();
    report.newSessionSelection = await selection();
    await shot('new-session');
    report.launched = await launchCurrentSelection();
    const expected = baseline ? 'default' : 'second';
    assert.equal(report.newSessionSelection.account, expected);
    assert.equal(report.launched.profile, expected);
    assert.equal(report.launched.sessionsRoot, path.join(profiles.find(p => p.id === expected).home, 'sessions'));
    const trace = fs.readFileSync(path.join(root, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    report.providerFixtureHome = trace.filter(row => row.method === 'thread/start').at(-1)?.fixtureHome;
    assert.equal(report.providerFixtureHome, profiles.find(p => p.id === expected).home);
    if (baseline) {
      assert.notEqual(report.saved.accountTab, report.launched.profile);
      report.checks.push('已复现：账号页选主账号，启动中心仍预选副账号，实际子进程仍从副账号 home 启动');
    } else {
      assert.equal(afterProfile, undefined);
      report.checks.push('账号页选主账号后，启动中心与实际子进程账号一致；其他四项配置保留');
      await openCodex(); await select('#new-session-account', 'default');
      await until('!document.querySelector("#new-session-account").disabled', 'shared account saved');
      const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      assert.equal(persisted.providers.codex.subscription_profile, 'default');
      assert.equal(persisted.launch.defaults.codex.codexProfile, undefined);
      assert.deepEqual(persisted.launch.defaults.codex, afterTuning);
      await click('#new-session-close'); await click('#btn-rail-accounts');
      await until('document.querySelector("[data-ac=codex-quota][data-profile=default]").textContent==="当前用量账号"', 'launch selection reflected in account tab');
      await shot('reverse-account-tab'); await click('#account-page [data-ac="close"]');
      await openCodex(); assert.equal((await selection()).account, 'default');
      const reversed = await launchCurrentSelection();
      assert.equal(reversed.profile, 'default');
      report.reversed = reversed;
      report.checks.push('启动中心选副账号立即落盘，不必保存整组或创建会话；账号页、下次打开及实际新进程同步为副账号');

      // Simulate a second window's account-tab write while this dialog contains
      // edited tuning. The IPC and notification are real, not a renderer stub.
      await openCodex(); await select('#new-session-effort', 'low');
      const switched = await cdp.eval('ipcRenderer.invoke("codex:set-global-account",{profileId:"second",scope:"launch"})');
      assert.equal(switched.ok, true);
      await until('document.querySelector("#new-session-account").value==="second"', 'open dialog receives account broadcast');
      assert.equal((await selection()).effort, 'low');
      await click('.new-session-option[data-kind="claude"]'); await click('.new-session-option[data-kind="codex"]');
      assert.equal((await selection()).account, 'second'); assert.equal((await selection()).effort, 'low');
      await click('#new-session-model-default');
      await until('document.querySelector("#new-session-model-default").textContent==="整组默认 ✓"', 'tuning save after account change');
      assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).providers.codex.subscription_profile, 'second');
      report.checks.push('打开中的启动中心收到账号变更后立即同步，保留手改强度；切换 AI 与保存整组均不恢复旧账号');

      await cdp.eval(`window.__quotaInvoke=ipcRenderer.invoke;window.__quotaDelay=true;ipcRenderer.invoke=function(channel,...args){const result=window.__quotaInvoke.call(this,channel,...args);if(channel==='codex:tuning-catalog'&&window.__quotaDelay){window.__quotaDelay=false;return result.then(value=>new Promise(resolve=>{window.__quotaRelease=()=>resolve(value);}));}return result;}`);
      await select('#new-session-account', 'default');
      await until('typeof window.__quotaRelease==="function"', 'model refresh held');
      assert.equal((await cdp.eval('ipcRenderer.invoke("codex:set-global-account",{profileId:"second",scope:"launch"})')).ok, true);
      await until('window.WorkspaceController.resolveSessionTuning("codex","").codexProfile==="second"', 'newer account event during save');
      await cdp.eval('ipcRenderer.invoke=window.__quotaInvoke;window.__quotaRelease();delete window.__quotaInvoke;delete window.__quotaRelease;delete window.__quotaDelay');
      await until('!document.querySelector("#new-session-account").disabled && document.querySelector("#new-session-account").value==="second"', 'latest account survives delayed refresh');
      report.checks.push('切换账号的模型加载尚未结束时，另一个入口的更新仍同步，旧异步结果不会覆盖新账号');

      const goodConfig = fs.readFileSync(configFile, 'utf8');
      fs.writeFileSync(configFile, '{broken config');
      await select('#new-session-account', 'default', false);
      await until('!document.querySelector("#new-session-error").hidden && document.querySelector("#new-session-account").value==="second"', 'failed switch rolls back');
      assert.equal(fs.readFileSync(configFile, 'utf8'), '{broken config');
      assert.equal(await cdp.eval('document.querySelector("#new-session-submit").disabled'), true);
      assert(!await cdp.eval('document.querySelector("#new-session-account-note").textContent.includes("已与账号页同步")'));
      fs.writeFileSync(configFile, goodConfig);
      await click('#new-session-close'); await openCodex();
      assert.equal((await selection()).account, 'second');
      await shot('unified-account'); await click('#new-session-close');
      report.checks.push('切换失败时回到原账号并显示错误，阻止不确定账号启动，不出现假成功；修复后可继续');
      const restarted = await cdp.eval(`ipcRenderer.invoke('restart-session',${JSON.stringify(oldSession.id)})`);
      assert.equal(restarted.codexProfile, 'second'); assert.equal(restarted.codexSid, oldSession.sid);
      await until(`sessions.get(${JSON.stringify(oldSession.id)})?.nativeRuntime?.connection==='connected'`, 'restart current quota');
      assert.equal((await cdp.eval(`ipcRenderer.invoke('close-session',${JSON.stringify(oldSession.id)})`)).ok, true);
      await until(`!sessions.has(${JSON.stringify(oldSession.id)}) || sessions.get(${JSON.stringify(oldSession.id)}).status==='dormant'`, 'old writer closed');
      const resumed = await cdp.eval(`ipcRenderer.invoke('resume-session',{hubId:${JSON.stringify(oldSession.id)},kind:'codex'})`);
      assert.equal(resumed.codexProfile, 'second'); assert.equal(resumed.codexSid, oldSession.sid);
      await until(`sessions.get(${JSON.stringify(oldSession.id)})?.nativeRuntime?.connection==='connected'`, 'resume current quota');
      report.checks.push('显式重启和恢复使用当前主账号，并保留副账号创建的原线程与历史');
      await stop();
      const legacy = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      legacy.launch.defaults.codex.codexProfile = 'default';
      fs.writeFileSync(configFile, JSON.stringify(legacy));
      await start(); await openCodex();
      assert.equal((await selection()).account, 'second'); await click('#new-session-close');
      report.checks.push('完整重启隔离 Hub 后仍使用主账号，旧版本遗留的冲突账号副本不会覆盖它');
    }
    report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; if (cdp) try { await shot('failure'); } catch {} }
  finally { await stop(); fs.writeFileSync(path.join(output, `${run}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
})();
