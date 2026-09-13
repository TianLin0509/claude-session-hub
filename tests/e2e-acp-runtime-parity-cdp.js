'use strict';
// Real isolated Electron / Main / stdio / CDP input. Provider replies are
// explicit fixtures; this does not make real model or subscription claims.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {seedUsageData}=require('./helpers/usage-refresh-fixture');
const j=JSON.stringify,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-parity-')),dataDir=path.join(root,'data');
  const out=path.resolve('artifacts/acp-runtime-parity/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const usage=seedUsageData(dataDir,'ring'),config=JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8'));
  const entryPath=path.resolve('tests/fixtures/acp-agent.js'),bridgePath=path.join(root,'bridge');
  fs.mkdirSync(bridgePath);fs.writeFileSync(path.join(bridgePath,'package.json'),'{}');
  config.acp={nodePath:process.execPath,apiKey:'fixture-no-cloud',providers:{qwen:{entryPath,model:'qwen3.8-max'},
    'deepseek-acp':{entryPath,bridgePath,model:'deepseek-v4-pro'},glm:{entryPath,backendPath:entryPath,model:'glm-5.2'}}};
  fs.writeFileSync(path.join(dataDir,'config.json'),j(config));
  fs.writeFileSync(path.join(dataDir,'prepared-projects.json'),j({schemaVersion:1,projects:[],migrations:[]}));
  const result={fixture:true,scope:'three providers, real Hub GUI, 24 MB synthetic tool history per provider',checks:[],runs:[],passed:false,out};
  const ids=[];
  let hub,c;
  try {
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    hub=await launchIsolatedHub({dataDir,port,windowMode:'hidden',extraEnv:{APPDATA:usage.fakeAppData,HUB_ACP_UI_FIXTURE:'1'}});
    c=await connectFirstPage(hub);await c.send('Page.bringToFront');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    async function until(expr,label=expr) {const end=Date.now()+40000;while(!await c.eval(expr)){if(Date.now()>end)throw Error('timeout '+label);await sleep(50);}}
    async function click(selector) {
      const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e || e.disabled)throw Error('unavailable '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.height)throw Error('hidden '+${j(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
    }
    async function draft(text) {await click('.floating-input-box');await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await c.send('Input.insertText',{text});}
    async function send(text,sid) {await draft(text);const old=await c.eval(`sessions.get(${j(sid)}).nativeRuntime.turnId`);await click('.floating-input-send');await until(`sessions.get(${j(sid)}).nativeRuntime.turnId!==${j(old)}`);}
    async function shot(name){const value=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(value.data,'base64'));}
    await until('typeof sessions!=="undefined"');
    // Observe actual IPC without replacing its results or state transitions.
    await c.eval(`window.__acpProbe={payloads:[],details:0};const real=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=async(channel,...args)=>{if(channel==='acp:tool-result')__acpProbe.details++;const value=await real(channel,...args);if(channel==='parse-session-transcript')__acpProbe.payloads.push(JSON.stringify(value).length);return value;};`);
    for(const kind of ['qwen','deepseek-acp','glm']) {
      const created=await c.eval(`ipcRenderer.invoke('create-session',${j({kind,opts:{cwd:root}})})`),sid=created.id;
      ids.push(sid);
      assert(sid);await until(`sessions.get(${j(sid)})?.nativeRuntime?.state==='idle'`);
      await click(`.session-item[data-session-id="${sid}"]`);await until('!!document.querySelector(".floating-input-box")');
      assert.equal(await c.eval('currentView'),'card');
      await send('HEAVY_HISTORY',sid);await until(`sessions.get(${j(sid)}).nativeRuntime.state==='completed'`);
      await until('!!document.querySelector("[data-action=tc-open-full-result]")');
      assert.equal(await c.eval('__acpProbe.details'),result.runs.length,'details must never load in the background');
      await click('.conversation-header-activity > summary');
      await click('.tc-cluster > summary');
      await click('.tc-row-with-result > summary');
      await click('[data-action=tc-open-full-result]');
      await until('!!document.querySelector(".card-detail-dialog[open]")');
      const text=await c.eval('document.querySelector(".card-detail-dialog pre").textContent');assert(text.includes('xxxxx'));
      let pages=0;
      while(!await c.eval('document.querySelector(".card-detail-dialog-tools button:nth-of-type(2)").disabled')) {
        assert(++pages<40,'unbounded full result paging');
        await click('.card-detail-dialog-tools button:nth-of-type(2)');
      }
      assert(pages>10 && /FULL-END-\d/.test(await c.eval('document.querySelector(".card-detail-dialog pre").textContent')));
      await click('.card-detail-dialog [aria-label="关闭详情"]');
      await until('!document.querySelector(".card-detail-dialog")');
      await click('.conversation-header-activity > summary');
      await send('HEAVY_STREAM',sid);
      assert.equal(await c.eval('document.activeElement===document.querySelector(".floating-input-box")'),true);
      const probes=[];
      for(let i=0;i<12;i++) {
        probes.push(await c.eval(`(async()=>{const t=performance.now();await ipcRenderer.invoke('get-sessions');return performance.now()-t;})()`));
        if(i===0)await c.send('Input.insertText',{text:'这条草稿不要发送'});
        await sleep(50);
      }
      await until(`sessions.get(${j(sid)}).nativeRuntime.state==='completed' && document.querySelector('#msg-overlay').textContent.includes('STREAM-79;')`);
      assert.equal(await c.eval('document.querySelector(".floating-input-box").textContent'),'这条草稿不要发送');
      const maxPayload=await c.eval('Math.max(0,...__acpProbe.payloads)');assert(maxPayload<500000,'full hidden tool output leaked into ordinary IPC: '+maxPayload);
      probes.sort((a,b)=>a-b);assert(probes.at(-1)<1000,'Hub IPC was blocked for a second');
      const logo=kind==='deepseek-acp'?'deepseek':kind;
      assert(await c.eval(`!!document.querySelector('.turn-card.assistant img[src$="${logo}.svg"]')`),'assistant logo for '+kind);
      await shot(kind+'-completed');
      await send('HEAVY_STREAM',sid);await until(`sessions.get(${j(sid)}).nativeRuntime.state==='running'`);
      await click('.floating-input-stop');await until(`sessions.get(${j(sid)}).nativeRuntime.state==='interrupted'`);
      result.runs.push({kind,maxTranscriptChars:maxPayload,ipcP95Ms:probes[Math.floor(probes.length*.95)],ipcMaxMs:probes.at(-1)});
      result.checks.push(kind+': card-first, full tool result on demand, streaming draft focus, completion, logo and confirmed Stop');
      console.log('PASS '+kind);
    }
    for(const sid of ids) {
      await click(`.session-item[data-session-id="${sid}"]`);
      await until(`activeSessionId===${j(sid)} && !!document.querySelector('.floating-input-box')`);
      await send('HEAVY_STREAM',sid);
    }
    const concurrent=[];
    for(let i=0;i<12;i++) {
      concurrent.push(await c.eval(`(async()=>{const t=performance.now();await ipcRenderer.invoke('get-sessions');return performance.now()-t;})()`));
      if(!i)await c.send('Input.insertText',{text:'三家同时运行也能写草稿'});
      await sleep(50);
    }
    await until(`${j(ids)}.every(id=>sessions.get(id).nativeRuntime.state==='completed')`);
    assert.equal(await c.eval('document.querySelector(".floating-input-box").textContent'),'三家同时运行也能写草稿');
    assert(Math.max(...concurrent)<500,'concurrent providers blocked Hub IPC');
    result.concurrentIpcMs=concurrent;
    result.checks.push('all three providers stream concurrently while the composer remains editable');
    result.passed=true;
  } catch(error) {
    result.error=error.stack;
    if(c)try{result.debug=await c.eval('({text:document.body.innerText.slice(-2000),probe:window.__acpProbe})');}catch(diagnostic){result.diagnosticError=diagnostic.message;}
    throw error;
  } finally {
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(c)await c.close();if(hub)result.exit=await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'result.json'),j(result));console.log(j({passed:result.passed,runs:result.runs,out,error:result.error,exit:result.exit}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
