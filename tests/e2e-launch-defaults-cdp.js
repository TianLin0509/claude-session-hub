'use strict';
// Real isolated Hub UI; account/model responses are local fixtures, no paid inference.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launch-defaults-'));
const dataDir = path.join(root, 'data');
const home = path.join(root, 'home');
const profiles = ['default', 'second'].map((id, i) => ({ id, label: i ? '副账号' : '主账号', home: path.join(home, id) }));
const output = path.resolve('output/playwright/20261014-launch-defaults-codex1');
for (const dir of [dataDir, output, ...profiles.map(p => p.home)]) fs.mkdirSync(dir, { recursive: true });
const configFile = path.join(dataDir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ custom: 'preserve-me', proxy: '', providers: { codex: {
  backend: 'subscription', subscription_profile: 'default', subscription_profiles: profiles,
} } }));
for (const p of profiles) fs.writeFileSync(path.join(p.home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  id_token: 'x.' + Buffer.from(JSON.stringify({ email: p.id + '@example.com' })).toString('base64url') + '.y',
  access_token: 'fixture-only', refresh_token: 'fixture-only',
} }));
const report = { passed: false, boundary: '真实隔离 Hub UI、配置落盘与重启；账号及模型目录使用本地夹具', checks: [], screenshots: [] };
let hub, cdp;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function until(expr, label, timeout = 30000) {
  for (const end = Date.now() + timeout; Date.now() < end;) { if (await cdp.eval(expr)) return; await sleep(100); }
  throw Error('timeout: ' + label);
}
async function click(selector) {
  await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getBoundingClientRect().height>0;})()`, selector);
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
  const box = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,top:e.contains(document.elementFromPoint(x,y))};})()`);
  assert(box.top, 'covered: ' + selector); delete box.top;
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
}
async function key(key, code, virtual) {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
}
async function select(selector, value) {
  const index = await cdp.eval(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).findIndex(o=>o.value===${JSON.stringify(value)})`);
  assert(index >= 0, 'option missing: ' + value);
  await click(selector);
  await key('Home', 'Home', 36);
  for (let i = 0; i < index; i++) await key('ArrowDown', 'ArrowDown', 40);
  await key('Enter', 'Enter', 13);
  await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, selector + '=' + value);
}
async function shot(name) {
  const file = path.join(output, `20261014-${name}-codex1.png`);
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
}
async function start() {
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'launch-defaults', extraEnv: {
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: profiles[0].home,
    CODEX_SQLITE_HOME: '', HUB_CODEX_PROFILE: '', HUB_CODEX_BACKEND: 'subscription',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_HUB_E2E: '1',
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
    CLAUDE_HUB_ACCOUNT_FIXTURE: path.resolve('tests/fixtures/account-center-cli.js'),
    CLAUDE_HUB_LAUNCH_DEFAULTS_FIXTURE: '1', CLAUDE_HUB_AGENT_RUNTIME: 'native',
    CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT: '1', CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR: path.join(root, 'threads'),
    CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR: path.join(root, 'writers'),
  } });
  cdp = await connectFirstPage(hub);
  await until('!!window.WorkspaceController && !!window.LaunchCenter', 'renderer');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.eval("document.documentElement.dataset.theme='codex'");
}
async function openCodex() {
  await click('#btn-new');
  await click('.new-session-option[data-kind="codex"]');
  await until('Array.from(document.querySelector("#new-session-model").options).some(o=>o.value==="gpt-6.1-sol") && !document.querySelector("#new-session-account").disabled', 'codex ready');
  await sleep(450);
}
(async () => {
  try {
    await start();
    await openCodex();
    await shot(process.argv.includes('--baseline') ? 'before' : 'after');
    await select('#new-session-codex-tier', 'fast');
    const disabled = await cdp.eval('document.querySelector("#new-session-model-default").disabled');
    if (process.argv.includes('--baseline')) {
      report.reproduced = disabled;
      assert(disabled, 'original bug: speed-only change leaves default button disabled');
      report.checks.push('已复现：只修改速度，默认按钮仍禁用');
      return;
    }
    assert.equal(disabled, false, 'speed-only change must enable whole-group save');
    report.checks.push('只改速度也能保存为默认');
    await select('#new-session-model', 'gpt-6.1-sol');
    await select('#new-session-effort', 'max');
    await select('#new-session-mcp', 'browser');
    await select('#new-session-account', 'second');
    await until('!document.querySelector("#new-session-account").disabled', 'account models loaded');
    const selection = async () => cdp.eval(`Object.fromEntries(['account','model','effort','codex-tier','mcp'].map(id=>[id,document.getElementById('new-session-'+id).value]))`);
    const expected = { account: 'second', model: 'gpt-6.1-sol', effort: 'max', 'codex-tier': 'fast', mcp: 'browser' };
    assert.deepEqual(await selection(), expected);
    await click('#new-session-model-default');
    await until('document.querySelector("#new-session-model-default").textContent==="整组默认 ✓"', 'saved');
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.models.defaults.codex, expected.model);
    assert.deepEqual(saved.launch.defaults.codex, { effort: 'max', mcpProfile: 'browser', codexSpeedTier: 'fast', codexProfile: 'second' });
    assert.equal(saved.providers.codex.subscription_profile, 'default');
    assert.equal(saved.custom, 'preserve-me');
    report.checks.push('五项一起保存到磁盘；全局账号与无关配置保留');
    await click('#new-session-close'); await openCodex();
    assert.deepEqual(await selection(), expected);
    await shot('saved-five-options');
    await select('#new-session-codex-tier', 'flex');
    await click('.new-session-option[data-kind="claude"]');
    await click('.new-session-option[data-kind="codex"]');
    assert.equal((await selection())['codex-tier'], 'flex');
    await click('#new-session-close'); await openCodex();
    assert.deepEqual(await selection(), expected, 'unsaved temporary changes must not replace saved defaults');
    report.checks.push('关闭重开恢复五项；同次切换 AI 保留临时选项，下次新建恢复已保存默认');

    await click('.new-session-option[data-kind="claude"]');
    await select('#new-session-model', 'claude-sonnet-5');
    await select('#new-session-effort', 'medium');
    await select('#new-session-mcp', 'lean');
    await click('#new-session-fast');
    await click('#new-session-model-default');
    await until('document.querySelector("#new-session-model-default").textContent==="整组默认 ✓"', 'Claude saved');
    await click('#new-session-close');
    await click('#btn-new'); await click('.new-session-option[data-kind="claude"]');
    assert.equal(await cdp.eval('document.querySelector("#new-session-fast").checked'), true);
    assert.equal(await cdp.eval('document.querySelector("#new-session-model").value'), 'claude-sonnet-5');
    await click('#new-session-fast'); await click('#new-session-model-default');
    await until('document.querySelector("#new-session-model-default").disabled', 'Fast false saved');
    await shot('claude');
    await click('.new-session-option[data-kind="codex"]');
    assert.deepEqual(await selection(), expected, 'different providers keep independent defaults');
    report.checks.push('Claude 模型、强度、MCP、Fast 开和关均可持久化，与 Codex 默认互不影响');

    // Failed writes keep the draft and expose a recoverable error.
    const goodConfig = fs.readFileSync(configFile, 'utf8');
    fs.writeFileSync(configFile, '{broken config');
    await select('#new-session-codex-tier', 'flex'); await click('#new-session-model-default');
    await until('!document.querySelector("#new-session-error").hidden', 'save failure visible');
    assert.equal((await selection())['codex-tier'], 'flex');
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{broken config');
    fs.writeFileSync(configFile, goodConfig);
    await select('#new-session-codex-tier', 'fast');
    report.checks.push('保存失败不覆盖原配置、不丢当前选择，错误直接可见');
    await click('#new-session-close'); await openCodex();

    // Model/config refresh arriving late must not replace a manual tuning edit.
    await click('#new-session-close');
    await cdp.eval(`window.__launchOriginalInvoke=ipcRenderer.invoke;ipcRenderer.invoke=function(channel,...args){const result=window.__launchOriginalInvoke.call(this,channel,...args);return channel==='get-hub-config'?result.then(value=>new Promise(resolve=>setTimeout(()=>resolve(value),2200))):result;}`);
    await click('#btn-new'); await click('.new-session-option[data-kind="codex"]');
    await select('#new-session-effort', 'low');
    await sleep(2400);
    assert.equal((await selection()).effort, 'low', 'late config load must not replace manual effort');
    await cdp.eval('ipcRenderer.invoke=window.__launchOriginalInvoke;delete window.__launchOriginalInvoke');
    await click('#new-session-close'); await openCodex();
    assert.deepEqual(await selection(), expected);
    report.checks.push('异步配置延迟返回时，保留用户刚手选的强度；下次打开仍恢复保存值');

    await click('.session-workspace-choice[data-workspace-mode="scratch"]');
    assert(await cdp.eval('document.querySelector(".session-workspace-choice[data-workspace-mode=scratch]").getAttribute("aria-checked")==="true"'));
    await click('.session-workspace-choice[data-workspace-mode="existing"]');
    assert(await cdp.eval('!document.querySelector("#new-session-existing-path").hidden'));
    await click('.session-workspace-choice[data-workspace-mode="default"]');
    await click('#new-session-tuning-details summary');
    assert(await cdp.eval('document.querySelector("#new-session-tuning-details").open'));
    await click('#new-session-tuning-details summary');
    report.checks.push('临时目录、已有路径、默认目录与配置说明的真实点击均可用');

    const geometry = await cdp.eval(`(()=>{const rect=id=>{const r=document.getElementById('new-session-'+id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};return Object.fromEntries(['account','model','effort','codex-tier','mcp'].map(id=>[id,rect(id)]));})()`);
    assert.equal(geometry.account.y, geometry.model.y);
    assert.equal(geometry.effort.y, geometry['codex-tier'].y);
    assert.equal(geometry.effort.y, geometry.mcp.y);
    assert(Object.values(geometry).every(r=>r.h===geometry.model.h));
    report.geometry = geometry;
    for (const [width, height, theme] of [[1440, 1000, 'codex'], [1280, 800, 'codex'], [1000, 760, 'codex'], [1440, 1000, 'dark']]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      assert(await cdp.eval(`(()=>{const e=document.querySelector('.session-create-body'),r=document.querySelector('#new-session-submit').getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.bottom<=innerHeight&&r.top>=0;})()`));
      await shot(`layout-${width}-${height}-${theme}`);
    }
    report.checks.push('五个控件同高、同行对齐；1440、1280、1000 桌面宽度无横向溢出，创建按钮可见');
    await cdp.eval("document.documentElement.dataset.theme='codex'");
    await click('#launch-intent-group'); await until('!!document.querySelector("#launch-center-group-host .mcm-slot")', 'group panel'); await shot('group');
    await click('#launch-intent-resume'); assert(await cdp.eval('!document.querySelector("#launch-center-resume-panel").hidden')); await shot('resume');
    await click('#launch-intent-session'); await click('.new-session-option[data-kind="powershell"]');
    assert.equal(await cdp.eval('document.querySelector("#new-session-config-section").hidden'), true);
    report.checks.push('群聊、恢复会话和 PowerShell 入口保留，PowerShell 隐藏无关配置');

    await cdp.close(); await gracefulQuit(hub); hub = null; await start();
    await until('window.WorkspaceController.resolveSessionTuning("codex","").effort==="max"', 'preloaded defaults');
    const beforeOpen = await cdp.eval('window.WorkspaceController.resolveSessionTuning("codex","")');
    assert.equal(beforeOpen.model, expected.model); assert.equal(beforeOpen.codexSpeedTier, 'fast');
    assert.equal(beforeOpen.codexProfile, 'second'); assert.equal(beforeOpen.mcpProfile, 'browser');
    await openCodex(); assert.deepEqual(await selection(), expected);
    report.checks.push('隔离 Hub 重启后，五项默认恢复；未打开面板的共享创建路径也能读到');
    const beforeIds = await cdp.eval('[...sessions.keys()]');
    await click('#new-session-submit');
    await until(`([...sessions.keys()].some(id=>!${JSON.stringify(beforeIds)}.includes(id)))`, 'session created');
    const id = await cdp.eval(`[...sessions.keys()].find(id=>!${JSON.stringify(beforeIds)}.includes(id))`);
    await until(`sessions.get(${JSON.stringify(id)})?.nativeRuntime?.connection==='connected'`, 'fixture connected');
    const actual = await cdp.eval(`(()=>{const s=sessions.get(${JSON.stringify(id)});return {model:s.model,effort:s.effort,mcp:s.mcpProfile,speed:s.codexSpeedTier,account:s.codexProfile};})()`);
    assert.deepEqual(actual, { model: expected.model, effort: 'max', mcp: 'browser', speed: 'fast', account: 'second' });
    await sleep(500);
    assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(id)}).codexProfile`), 'second', 'idle account sync must retain selected launch account');
    report.createdSession = actual;
    report.checks.push('点击创建后，新会话实际取得保存的模型、强度、MCP、速度和账号（本地 CLI 夹具）');
    report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(output, process.argv.includes('--baseline') ? '20261014-baseline-codex1.json' : '20261014-verification-codex1.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
