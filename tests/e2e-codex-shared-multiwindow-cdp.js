'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { connectBroker, readMetadata } = require('../main/codex-runtime-broker-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-shared-e2e-'));
  const dataDir = path.join(root, 'data');
  const codexHome = path.join(root, 'codex');
  const workspace = path.join(root, 'workspace');
  const out = path.resolve('artifacts/codex-shared-multiwindow', String(Date.now()));
  fs.mkdirSync(dataDir, { recursive:true });
  fs.mkdirSync(codexHome, { recursive:true });
  fs.mkdirSync(workspace, { recursive:true });
  fs.mkdirSync(out, { recursive:true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const result = { root, out, checks:[], passed:false };
  let hubA, hubB, a, b;
  const extraEnv = {
    CODEX_HOME:codexHome,
    CLAUDE_CONFIG_DIR:path.join(root, 'claude'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname, 'fixtures', 'codex-app-server.js'),
    CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1',
    AI_HUB_CODEX_BROKER_TEST:'1',
  };
  const launch = async label => launchIsolatedHub({ entryPath:path.resolve('.'), dataDir, port:await freePort(), label, extraEnv });
  async function until(client, expression, label, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try { last = await client.eval(expression); if (last) return last; } catch (error) { last = error.message; }
      await sleep(100);
    }
    throw new Error(`timeout ${label}: ${JSON.stringify(last)}`);
  }
  async function shot(client, name) {
    const image = await client.send('Page.captureScreenshot', { format:'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  }
  try {
    hubA = await launch('shared-a');
    a = await connectFirstPage(hubA);
    await until(a, "typeof sessions !== 'undefined' && typeof ipcRenderer !== 'undefined'", 'A renderer');
    const created = await a.eval('ipcRenderer.invoke("create-session",' + JSON.stringify({
      kind:'codex', opts:{ cwd:workspace, model:'gpt-6-astra', effort:'xhigh', title:'共享窗口验证',
        userRenamed:true, mcpProfile:'none', codexSpeedTier:'standard' },
    }) + ')');
    result.sessionId = created.id;
    const sid = JSON.stringify(created.id);
    await until(a, `sessions.get(${sid})?.codexSharedControl?.role === "controller" && sessions.get(${sid})?.nativeRuntime?.state === "idle"`, 'A shared idle');
    result.threadId = await a.eval(`sessions.get(${sid}).codexSid`);
    result.serverPid = await a.eval(`sessions.get(${sid}).codexSharedControl.serverPid`);
    assert(result.threadId && result.serverPid);
    await a.eval(`selectSession(${sid})`);
    await until(a, 'document.getElementById("codex-shared-status").hidden && !document.getElementById("terminal-panel").classList.contains("shared-control-visible")', 'A has no informational owner banner');

    await a.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='fixture:hold';box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.floating-input-send').click();})()`);
    await until(a, `sessions.get(${sid})?.nativeRuntime?.state === "running"`, 'A running');
    // Persist the newly bound native thread before the second Hub loads the
    // same card. The production store is intentionally debounced.
    await sleep(1200);

    hubB = await launch('shared-b');
    b = await connectFirstPage(hubB);
    await until(b, `typeof sessions !== 'undefined' && sessions.has(${sid})`, 'B persisted card');
    await b.eval(`selectSession(${sid})`);
    await until(b, `sessions.get(${sid})?.codexSharedControl?.role === "viewer" && sessions.get(${sid})?.nativeRuntime?.state === "running"`, 'B live viewer');
    assert.equal(await b.eval(`sessions.get(${sid}).codexSid`), result.threadId);
    assert.equal(await b.eval(`sessions.get(${sid}).codexSharedControl.serverPid`), result.serverPid);
    assert.equal(await b.eval('document.querySelector(".floating-input-send").disabled'), true);
    assert.equal(await b.eval('document.querySelector("#codex-shared-status button.primary").disabled'), true);
    result.checks.push('two Electron Hubs share one thread and one app-server pid while B opens live as viewer');

    const busyTransfer = await b.eval(`ipcRenderer.invoke('codex:native-action',{sessionId:${sid},action:'request-control'})`);
    assert.equal(busyTransfer.ok, false);
    assert.match(busyTransfer.message, /工作中/);
    await a.eval('activeSessionId = null');
    await b.eval(`document.querySelector('#codex-shared-status button:not(.primary)').click()`);
    await until(a, `activeSessionId === ${sid}`, 'locate original controller window');
    await b.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='B 的未发送草稿';box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await shot(b, 'viewer-running');
    result.checks.push('running state disables takeover and send, can locate the controller, and preserves a local viewer draft');

    await a.eval(`document.querySelector('.floating-input-stop').click()`);
    await until(a, `sessions.get(${sid})?.nativeRuntime?.state === "interrupted"`, 'A interrupted');
    await until(b, `sessions.get(${sid})?.nativeRuntime?.state === "interrupted" && sessions.get(${sid})?.codexSharedControl?.canTransfer === true`, 'B transferable');
    assert.equal(await b.eval('document.querySelector("#codex-shared-status button.primary").disabled'), false);
    await b.eval('document.querySelector("#codex-shared-status button.primary").click()');
    await until(b, `sessions.get(${sid})?.codexSharedControl?.role === "controller"`, 'B controller');
    await until(a, `sessions.get(${sid})?.codexSharedControl?.role === "viewer"`, 'A viewer');
    assert.equal(await b.eval('document.querySelector(".floating-input-box").innerText'), 'B 的未发送草稿');
    assert.equal(await a.eval('document.querySelector(".floating-input-send").disabled'), true);
    result.checks.push('confirmed stop enables explicit transfer; draft remains unsent and old controller becomes read-only');

    await b.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='fixture:wait';box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.floating-input-send').click();})()`);
    await until(b, `sessions.get(${sid})?.nativeRuntime?.state === "waiting" && document.querySelector('.codex-native-request textarea')`, 'B waiting approval');
    await until(a, `sessions.get(${sid})?.nativeRuntime?.state === "waiting" && document.querySelector('.codex-native-request textarea')`, 'A sees approval');
    assert.equal(await a.eval('document.querySelector(".codex-native-request button[type=submit]").disabled'), true);
    assert.equal(await b.eval('document.querySelector(".codex-native-request button[type=submit]").disabled'), false);
    const waitingTransfer = await a.eval(`ipcRenderer.invoke('codex:native-action',{sessionId:${sid},action:'request-control'})`);
    assert.equal(waitingTransfer.ok, false);
    assert.match(waitingTransfer.message, /等待|工作中/);
    await b.eval(`(()=>{document.querySelector('.codex-native-request textarea').value='A';document.querySelector('.codex-native-request button[type=submit]').click();})()`);
    await until(b, `sessions.get(${sid})?.nativeRuntime?.state === "completed"`, 'B approval completed');
    await until(a, `sessions.get(${sid})?.nativeRuntime?.state === "completed"`, 'A sees approval completion');
    result.checks.push('waiting approval remains visible in both Hubs but only the controller can answer or stop it');

    await b.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='共享完成验证';box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.floating-input-send').click();})()`);
    await until(b, `sessions.get(${sid})?.nativeRuntime?.state === "completed"`, 'B completed');
    await until(a, `sessions.get(${sid})?.nativeRuntime?.state === "completed"`, 'A sees completion');
    const ids = await Promise.all([a.eval(`sessions.get(${sid}).codexSid`), b.eval(`sessions.get(${sid}).codexSid`)]);
    assert.deepEqual(ids, [result.threadId, result.threadId]);
    await b.eval(`applyViewMode('card')`);
    await until(b, 'document.querySelector("#msg-overlay")?.innerText.includes("原生回答")', 'B shared history');
    await shot(b, 'controller-completed');
    result.checks.push('new controller sends one turn; both Hubs receive completion and retain the exact thread identity');

    await b.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:false });
    await sleep(250);
    const mobile = await b.eval(`(()=>{const el=document.getElementById('codex-shared-status');const r=el.getBoundingClientRect();return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,width:r.width,height:r.height,visible:!el.hidden};})()`);
    assert.equal(mobile.viewport, 390);
    assert.equal(mobile.pageWidth, 390);
    assert(!mobile.visible && mobile.height === 0, JSON.stringify(mobile));
    await shot(b, 'controller-mobile');
    result.mobile = mobile;
    result.checks.push('controller banner remains absent without reserved height at 390px');
    await a.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:false });
    await until(a, '(()=>{const el=document.getElementById("codex-shared-status"),r=el.getBoundingClientRect();return !el.hidden&&r.left>=0&&r.right<=390&&r.width>300})()', 'viewer handoff controls remain reachable at 390px');

    const broker = readMetadata(dataDir);
    assert(broker && broker.pid > 0);
    result.brokerPid = broker.pid;
    result.passed = true;
  } finally {
    if (a) { try { result.aState = await a.eval(`sessions.get(${JSON.stringify(result.sessionId)}) || null`); } catch {} }
    if (b) { try { result.bState = await b.eval(`sessions.get(${JSON.stringify(result.sessionId)}) || null`); } catch {} }
    result.broker = readMetadata(dataDir);
    if (a) await a.close();
    if (b) await b.close();
    if (hubA) {
      fs.writeFileSync(path.join(out, 'hub-a.log'), hubA.log().join('\n'));
      try { result.hubAExit = await gracefulQuit(hubA); } catch (error) { result.hubAExitError = error.message; }
    }
    if (hubB) {
      fs.writeFileSync(path.join(out, 'hub-b.log'), hubB.log().join('\n'));
      try { result.hubBExit = await gracefulQuit(hubB); } catch (error) { result.hubBExitError = error.message; }
    }
    try {
      if (readMetadata(dataDir)) {
        const broker = await connectBroker({ dataDir, timeoutMs:3000 });
        await broker.request('shutdown-test', {}, 3000);
        broker.close();
      }
    } catch (error) { result.brokerCleanup = error.message; }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ out, passed:result.passed, checks:result.checks, hubAExit:result.hubAExit,
      hubBExit:result.hubBExit, hubAExitError:result.hubAExitError, hubBExitError:result.hubBExitError,
      brokerCleanup:result.brokerCleanup }));
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
