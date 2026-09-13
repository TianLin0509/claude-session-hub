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
  const out = path.resolve('artifacts/multi-hub-audit/gui', String(Date.now()));
  fs.mkdirSync(dataDir, { recursive:true });
  fs.mkdirSync(codexHome, { recursive:true });
  fs.mkdirSync(workspace, { recursive:true });
  fs.mkdirSync(out, { recursive:true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const savedCount=Number(process.env.AUDIT_SAVED_SESSIONS ?? 1285);
  fs.writeFileSync(path.join(dataDir,'state.json'),JSON.stringify({version:1,cleanShutdown:true,meetings:[],sessions:
    Array.from({length:savedCount},(_,i)=>({hubId:'archive-'+i,kind:i%2?'claude':'codex',title:'归档样本 '+i,cwd:workspace,
      status:'dormant',createdAt:Date.now()-10*86400000,lastMessageTime:Date.now()-10*86400000,lastOutputPreview:'历史记录'.repeat(180)}))}));
  const result = { root, out, checks:[], passed:false, historyChars:Number(process.env.AUDIT_HISTORY_CHARS || 200000) }; console.log('audit-start '+out);
  let hubA, hubB, hubC, a, b, c;
  const extraEnv = {
    CODEX_HOME:codexHome,
    CLAUDE_CONFIG_DIR:path.join(root, 'claude'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname, 'fixtures', 'codex-app-server.js'),
    CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1',
    CLAUDE_HUB_CLAUDE_SHARED_RUNTIME:'1',
    CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.join(__dirname,'fixtures/claude-stream.js'),
    CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'approval',
    AI_HUB_CODEX_BROKER_TEST:'1',
    CLAUDE_HUB_NATIVE_FIXTURE_HISTORY_CHARS:process.env.AUDIT_HISTORY_CHARS || '200000',
  };
  const launch = async label => launchIsolatedHub({ entryPath:path.resolve('.'), dataDir, port:await freePort(), label, extraEnv, windowMode:'hidden' });
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
    await until(a, `sessions.get(${sid})?.codexSharedControl?.role === "controller" && ["idle","completed"].includes(sessions.get(${sid})?.nativeRuntime?.state)`, 'A shared idle'); console.log('audit A ready');
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
    await until(b, `sessions.get(${sid})?.codexSharedControl?.role === "viewer" && sessions.get(${sid})?.nativeRuntime?.state === "running"`, 'B live viewer'); console.log('audit B ready');
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


    result.performance = { scope:'Three isolated real Electron Hubs; controlled native Codex and Claude transports; synthetic saved catalogue; card view. Input latency is measured after completion, not peak concurrent streaming or real model latency.' };
    await a.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await b.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    for(const c of [a,b]) {
      await c.eval(`applyViewMode('card')`);
      await c.eval(`window.auditLongTasks=[];window.auditObserver=new PerformanceObserver(list=>auditLongTasks.push(...list.getEntries().map(e=>e.duration)));auditObserver.observe({type:'longtask'});`);
    }
    const beforeTurn=await b.eval(`sessions.get(${sid}).nativeRuntime.turnId`);
    await b.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='fixture:broker-burst';box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.floating-input-send').click();})()`);
    await until(b,`sessions.get(${sid})?.nativeRuntime?.turnId!==${JSON.stringify(beforeTurn)} && sessions.get(${sid})?.nativeRuntime?.state==='completed'`,'audit burst completion');
    await until(a,'document.querySelector("#msg-overlay")?.innerText.includes("FINAL_ONLY_")','viewer receives final answer');
    await until(b,'document.querySelector("#msg-overlay")?.innerText.includes("FINAL_ONLY_")','controller receives final answer');
    result.performance.windows=[];
    for(const [name,c] of [['viewer',a],['controller',b]]) {
      const latencies=[];
      for(let i=0;i<10;i++) latencies.push(await c.eval(`(async()=>{const t=performance.now();await ipcRenderer.invoke('get-sessions');return performance.now()-t;})()`));
      const probe=await c.eval(`(()=>{auditObserver.disconnect();return {longTasks:auditLongTasks,sessionCount:sessions.size,connection:sessions.get(${sid}).nativeRuntime.connection,state:sessions.get(${sid}).nativeRuntime.state};})()`);
      result.performance.windows.push({name,ipcRoundtripMs:latencies,...probe});
    }
    result.performance.slowReaderDisconnects=(fs.readFileSync(path.join(dataDir,'diagnostics/codex-runtime-broker.log'),'utf8').match(/peer closed/g)||[]).length;
    assert.equal(result.performance.slowReaderDisconnects,0);
    result.checks.push('audit: two real Hubs render the 500-delta final answer then respond to ten get-sessions requests each');
    // Same control policy, exercised through actual Claude UI and its native
    // approval messages. No direct backend submit bypasses the composer.
    const claudeOptions={cwd:workspace,model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean',fastMode:false,title:'共享 Claude 验证'};
    const ca=await a.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:${JSON.stringify(claudeOptions)}})`);
    const aid=JSON.stringify(ca.id);
    await a.eval(`selectSession(${aid})`);
    await until(a,`sessions.get(${aid})?.nativeRuntime?.connection==='connected'`,'Claude A connected');
    const claudeId=await a.eval(`sessions.get(${aid}).ccSessionId`);
    const cb=await b.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:${JSON.stringify({...claudeOptions,resumeCCSessionId:claudeId})}})`);
    const bid=JSON.stringify(cb.id);
    await b.eval(`selectSession(${bid})`);
    await until(b,`sessions.get(${bid})?.codexSharedControl?.role==='viewer'`,'Claude viewer');
    assert.equal(await a.eval(`sessions.get(${aid}).nativeRuntime.childPid`),await b.eval(`sessions.get(${bid}).nativeRuntime.childPid`));
    await a.eval(`document.querySelector('.floating-input-box').focus()`);
    await a.send('Input.insertText',{text:'Claude 保留完整输入\n共享审批测试'});
    await a.eval(`document.querySelector('.floating-input-send').click()`);
    for(const [page,id] of [[a,aid],[b,bid]])await until(page,`sessions.get(${id}).nativeRuntime.state==='waiting'`,'shared Claude approval');
    assert.equal(await b.eval(`document.querySelector('.claude-native-controls button[type=submit]').disabled`),true);
    await b.eval(`document.querySelector('.floating-input-box').focus()`);
    await b.send('Input.insertText',{text:'查看方草稿，不自动发送'});
    await a.eval(`document.querySelector('.claude-native-controls button[type=button]').click()`);
    for(const [page,id] of [[a,aid],[b,bid]])await until(page,`sessions.get(${id}).nativeRuntime.state==='completed'`,'shared Claude completion');
    await until(b,`!document.querySelector('#codex-shared-status button.primary').disabled`,'Claude transferable');
    await b.eval(`document.querySelector('#codex-shared-status button.primary').click()`);
    await until(b,`sessions.get(${bid}).codexSharedControl.role==='controller'`,'Claude transferred by UI');
    assert.equal(await b.eval(`readContenteditablePlainText(document.querySelector('.floating-input-box'))`),'查看方草稿，不自动发送');
    assert.equal(await b.eval(`sessions.get(${bid}).nativeRuntime.state`),'completed');
    await shot(b,'claude-shared-controller');
    result.checks.push('Claude: same writer, both see approval, viewer cannot answer, GUI transfers only after completion and keeps draft unsent');

    hubC=await launch('shared-c');c=await connectFirstPage(hubC);
    await until(c,"typeof sessions!=='undefined' && typeof ipcRenderer!=='undefined'",'third Hub renderer');
    const cc=await c.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:${JSON.stringify({...claudeOptions,resumeCCSessionId:claudeId})}})`);
    const cid=JSON.stringify(cc.id);await c.eval(`selectSession(${cid})`);
    await until(c,`sessions.get(${cid})?.codexSharedControl?.viewerCount>=3`,'three Claude views');
    assert.equal(await c.eval(`sessions.get(${cid}).nativeRuntime.childPid`),await b.eval(`sessions.get(${bid}).nativeRuntime.childPid`));
    result.performance.threeHubTyping=[];
    for(const [name,page] of [['first',a],['controller',b],['third',c]]) {
      await page.eval(`document.querySelector('.floating-input-box').focus()`);
      const started=Date.now();await page.send('Input.insertText',{text:' · 输入响应验证'});
      await until(page,`readContenteditablePlainText(document.querySelector('.floating-input-box')).includes('输入响应验证')`,'real keyboard edit',3000);
      const elapsedMs=Date.now()-started;assert(elapsedMs<1000,`${name} typing ${elapsedMs}ms`);
      result.performance.threeHubTyping.push({name,elapsedMs,savedSessions:await page.eval('sessions.size')});
    }
    result.checks.push('three real Hubs retain '+savedCount+' archived cards and edit local drafts within 1 second without a second Claude writer');
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
    if(c)await c.close();
    if (hubA) {
      fs.writeFileSync(path.join(out, 'hub-a.log'), hubA.log().join('\n'));
      try { result.hubAExit = await gracefulQuit(hubA); } catch (error) { result.hubAExitError = error.message; }
    }
    if (hubB) {
      fs.writeFileSync(path.join(out, 'hub-b.log'), hubB.log().join('\n'));
      try { result.hubBExit = await gracefulQuit(hubB); } catch (error) { result.hubBExitError = error.message; }
    }
    if(hubC){fs.writeFileSync(path.join(out,'hub-c.log'),hubC.log().join('\n'));result.hubCExit=await gracefulQuit(hubC);}
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
