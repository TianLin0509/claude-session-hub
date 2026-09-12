'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {connectBroker,readMetadata}=require('../main/codex-runtime-broker-client');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});

async function main() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-broker-stability-'));
  const out=path.resolve('artifacts/codex-broker-stability',String(Date.now()));
  const dataDir=path.join(root,'data'),codexHome=path.join(root,'codex'),cwd=path.join(root,'workspace'),trace=path.join(root,'trace.jsonl');
  for(const dir of [out,dataDir,codexHome,cwd])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(codexHome,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="xhigh"\n');
  const result={out,checks:[],passed:false};let hub,cdp,sid;
  const until=async(expression,label)=>{const deadline=Date.now()+45000;while(Date.now()<deadline){if(await cdp.eval(expression))return;await sleep(100);}throw Error('timeout: '+label);};
  const commands=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(m=>m.method);
  const snapshot=()=>cdp.eval(`(()=>{const s=sessions.get(${sid});return {threadId:s.codexSid,runtime:s.nativeRuntime,control:s.codexSharedControl,error:s.nativeActionError};})()`);
  async function send(text) {
    await until('document.querySelector(".floating-input-send")?.disabled===false','send enabled');
    await cdp.eval(`(()=>{const b=document.querySelector('.floating-input-box');b.textContent=${JSON.stringify(text)};b.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.floating-input-send').click();})()`);
  }
  try {
    hub=await launchIsolatedHub({entryPath:path.resolve('.'),dataDir,port:await freePort(),label:'broker-stability',extraEnv:{
      CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_HISTORY_CHARS:'1000000',CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace,AI_HUB_CODEX_BROKER_TEST:'1',
    }});
    cdp=await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"','renderer');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const session=await cdp.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard',title:'长历史共享连接回归'}})})`);
    sid=JSON.stringify(session.id);result.sessionId=session.id;
    await until(`sessions.get(${sid})?.nativeRuntime?.connection==='connected'`,'history attached');
    await cdp.eval(`selectSession(${sid});applyViewMode('pty')`);
    await until('document.querySelector(".floating-input-box")','composer');
    const initial=await snapshot();result.serverPid=initial.control.serverPid;result.threadId=initial.threadId;
    assert.equal(await cdp.eval('document.getElementById("codex-shared-status").hidden'),true);
    await cdp.eval(`window.brokerStateTrace=[];ipcRenderer.on('session-updated',(_e,{session:s})=>{if(s.id===${sid})brokerStateTrace.push({state:s.nativeRuntime?.state,connection:s.nativeRuntime?.connection,error:s.nativeActionError});});`);
    await send('fixture:broker-burst');
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='completed' && sessions.get(${sid})?.nativeRuntime?.submission?.status==='accepted'`,'burst completed');
    const history=await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid},opts:{limit:10000}}).then(r=>({error:r.error,oldChars:r.turns.find(t=>t.providerTurnId==='history-turn')?.text.length,final:r.turns.at(-1)?.text,outcome:r.turns.at(-1)?.nativeOutcome}))`);
    assert.equal(history.error,null);assert.equal(history.oldChars,1000000);
    assert.equal(history.final,'流'.repeat(500)+' FINAL_ONLY_完整结束');assert.equal(history.outcome,'completed');
    const samples=await cdp.eval('brokerStateTrace');
    assert(samples.every(s=>s.connection==='connected'&&s.state!=='failed'&&!s.error),JSON.stringify(samples));
    assert.equal((await snapshot()).control.serverPid,result.serverPid);
    assert.equal(commands().filter(m=>m.method==='turn/start').length,1);
    result.checks.push('3 MB native history plus 500 streamed deltas preserves full history/final-only content and never disconnects');

    await send('fixture:hold');await until(`sessions.get(${sid})?.nativeRuntime?.state==='running'`,'running');
    const before=await snapshot(),beforeCommands=commands().length;
    for(let i=0;i<3;i++) {
      const response=await cdp.eval(`ipcRenderer.invoke('codex:native-action',{sessionId:${sid},action:'reconnect'})`);
      assert.equal(response.ok,true);
    }
    const after=await snapshot();
    assert.equal(after.runtime.turnId,before.runtime.turnId);assert.equal(after.threadId,result.threadId);
    assert.equal(after.control.serverPid,result.serverPid);assert.equal(after.runtime.state,'running');
    assert.equal(commands().length,beforeCommands,'Hub connection checks must send zero engine requests');
    result.checks.push('three UI connection checks during a running turn issue zero Codex commands and preserve PID/thread/turn');
    await cdp.eval('document.querySelector(".floating-input-stop").click()');
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='interrupted'`,'explicit stop');
    assert.equal(commands().filter(m=>m.method==='turn/interrupt').length,1);
    await send('fixture:broker-burst');await until(`sessions.get(${sid})?.nativeRuntime?.state==='completed'`,'second completion');
    assert.equal(commands().filter(m=>m.method==='thread/start').length,1);
    assert.equal(commands().filter(m=>m.method==='thread/resume'||m.method==='thread/unsubscribe').length,0);
    assert.equal(commands().filter(m=>m.method==='turn/start').length,3);
    await cdp.eval('applyViewMode("card")');
    await until('document.querySelector("#msg-overlay")?.innerText.includes("FINAL_ONLY_完整结束")','final answer displayed');
    result.capture=await require('./helpers/capture-isolated-window').captureIsolatedWindow(cdp,hub,path.join(out,'single-window-completed.png'));
    const brokerLog=path.join(dataDir,'diagnostics','codex-runtime-broker.log');
    assert(!fs.readFileSync(brokerLog,'utf8').includes('peer closed'));
    result.checks.push('only explicit stop interrupts; next turn works in the same engine and UI has no shared-status warning');
    result.passed=true;
  } finally {
    if(cdp){try{result.final=await snapshot();}catch{}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}
    if(readMetadata(dataDir)){const broker=await connectBroker({dataDir});await broker.request('shutdown-test',{},3000);broker.close();}
    if(fs.existsSync(trace))fs.copyFileSync(trace,path.join(out,'native-trace.jsonl'));
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
