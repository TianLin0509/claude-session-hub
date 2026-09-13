'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-claude-parity-')),out=path.resolve('artifacts/claude-codex-parity/gui-'+Date.now());
  fs.mkdirSync(out,{recursive:true});const report={root,out,fixture:true,checks:[],passed:false};let hub,c;
  fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'data','prepared-projects.json'),JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',label:'Claude Codex parity',extraEnv:{
      CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-parity.js'),AI_HUB_CODEX_BROKER_TEST:'1'}});
    c=await connectFirstPage(hub);await c.send('Page.bringToFront');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const until=async(expr,label=expr)=>{const end=Date.now()+45000;while(!await c.eval(expr)){if(Date.now()>end)throw Error('timeout '+label);await sleep(40);}};
    async function click(selector) {
      const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e || e.disabled)throw Error('unavailable '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.height)throw Error('hidden '+${j(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
    }
    async function fill(selector,text) {await click(selector);for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await c.send('Input.insertText',{text});}
    async function shot(name) {const img=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(img.data,'base64'));}
    await until('typeof sessions!=="undefined"');
    const s=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'claude',opts:{cwd:root,model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean'}})})`),sid=s.id,q=j(sid);
    report.sid=sid;await until(`sessions.get(${q})?.nativeRuntime?.connection==='connected'`);
    await click(`.session-item[data-session-id="${sid}"]`);await until('!!document.querySelector(".floating-input-box")');
    assert.equal(await c.eval('currentView'),'card');
    await c.eval(`window.__parity={payloads:[],details:0};const real=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=async(channel,...args)=>{if(channel==='claude-native:tool-result')__parity.details++;const result=await real(channel,...args);if(channel==='parse-session-transcript')__parity.payloads.push(JSON.stringify(result).length);return result;};`);
    async function send(text) {const old=await c.eval(`sessions.get(${q}).nativeRuntime.userMessageId`);await fill('.floating-input-box',text);await click('.floating-input-send');await until(`sessions.get(${q}).nativeRuntime.userMessageId!==${j(old)}`);}
    await send('HEAVY');await until('document.querySelectorAll(".tc-row-with-result").length>=10');
    assert.equal(await c.eval('document.activeElement===document.querySelector(".floating-input-box")'),true);
    await c.send('Input.insertText',{text:'草稿保留，不要发送'});
    const samples=[];
    for(let i=0;i<15;i++){samples.push(await c.eval(`(async()=>{const t=performance.now();await ipcRenderer.invoke('get-sessions');return performance.now()-t;})()`));await sleep(40);}
    report.maxIpcMs=Math.max(...samples);assert(report.maxIpcMs<500);
    await click('#btn-backstage');await until('currentView==="pty"');
    assert.equal(await c.eval(`getOrCreateTerminal(${q}).terminal.options.lineHeight`),1.3);
    await until(`getOrCreateTerminal(${q}).terminal.buffer.active.baseY>20`);
    const wheel=await c.eval(`(()=>{const e=getOrCreateTerminal(${q}).container.querySelector('.xterm-viewport'),r=e.getBoundingClientRect();return{x:r.x+Math.min(180,r.width/2),y:r.y+Math.min(220,r.height/2)};})()`);
    report.wheelBefore=await c.eval(`(()=>{const cached=getOrCreateTerminal(${q}),e=cached.container.querySelector('.xterm-viewport');window.__wheelEvents=[];cached.container.addEventListener('wheel',e=>__wheelEvents.push({deltaY:e.deltaY}));return{target:document.elementFromPoint(${wheel.x},${wheel.y})?.outerHTML.slice(0,400),rect:e.getBoundingClientRect().toJSON(),top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,follow:cached._codexFollowBottom};})()`);
    await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel,deltaX:0,deltaY:-550});
    await sleep(350);
    report.wheelAfter=await c.eval(`(()=>{const cached=getOrCreateTerminal(${q}),e=cached.container.querySelector('.xterm-viewport');return{events:__wheelEvents,top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,follow:cached._codexFollowBottom,intent:cached._codexUserScrollIntentUntil};})()`);
    await shot('wheel-diagnostic');assert.equal(report.wheelAfter.follow,false);
    assert(report.wheelAfter.height-report.wheelAfter.client-report.wheelAfter.top>100,'actual viewport remains above latest output');
    await sleep(350);assert.equal(await c.eval(`getOrCreateTerminal(${q})._codexFollowBottom`),false);
    await shot('backstage-reading');
    await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel,deltaX:0,deltaY:10000});
    await until(`getOrCreateTerminal(${q})._codexFollowBottom && isTerminalViewportAtBottom(getOrCreateTerminal(${q}))`,'scrolling down reattaches to latest output');
    await click('#btn-backstage');await until('currentView==="card"');
    await until(`sessions.get(${q}).nativeRuntime.state==='completed'`);
    assert.equal(await c.eval('document.querySelector(".floating-input-box").textContent'),'草稿保留，不要发送');
    assert.equal(await c.eval('__parity.details'),0);
    report.maxTranscriptChars=await c.eval('Math.max(...__parity.payloads)');assert(report.maxTranscriptChars<100000);
    await click('.conversation-header-activity > summary');await click('.tc-cluster > summary');await click('.tc-row-with-result > summary');await click('[data-action=tc-open-full-result]');
    await until('!!document.querySelector(".card-detail-dialog[open]")');let pages=0;
    while(!await c.eval('document.querySelector(".card-detail-dialog-tools button:nth-of-type(2)").disabled')){assert(++pages<25);await click('.card-detail-dialog-tools button:nth-of-type(2)');}
    assert(pages>10);assert.match(await c.eval('document.querySelector(".card-detail-dialog pre").textContent'),/FULL-END-\d/);
    await shot('full-tool-result');await click('.card-detail-dialog [aria-label="关闭详情"]');await click('.conversation-header-activity > summary');
    report.checks.push('8 MB tool history: bounded card payload, responsive IPC, retained draft, backend reading position and exact full result via real paging');
    await send('QUESTIONS');await until('!!document.querySelector(".claude-native-controls form[data-request-id=first] textarea")');
    const first='.claude-native-controls form[data-request-id=first] textarea',second='.claude-native-controls form[data-request-id=second] textarea';
    await fill(first,'第一份回答还在编辑');await c.eval(`window.__firstAnswer=document.querySelector(${j(first)})`);
    await until(`!!document.querySelector(${j(second)})`);
    assert.equal(await c.eval(`document.querySelector(${j(first)})===__firstAnswer && __firstAnswer.value==='第一份回答还在编辑'`),true);
    await click('.claude-native-controls form[data-request-id=second] > button');
    assert.equal(await c.eval(`document.querySelector(${j(second)}).value`),'保留全部记录');
    await c.eval(`window.__secondAnswer=document.querySelector(${j(second)})`);await shot('questions');
    await click('.claude-native-controls form[data-request-id=first] button[type=submit]');await until(`!document.querySelector(${j(first)})`);
    assert.equal(await c.eval(`document.querySelector(${j(second)})===__secondAnswer && __secondAnswer.value==='保留全部记录'`),true);
    await click('.claude-native-controls form[data-request-id=second] button[type=submit]');await until(`sessions.get(${q}).nativeRuntime.state==='completed'`);
    await until('document.querySelector("#msg-overlay").textContent.includes("第一份回答还在编辑")');
    report.checks.push('two real native questions retain typed answers and focus while another arrives/resolves; options and submission use Codex styling');
    await send('HOLD');await click('.floating-input-stop');await until(`sessions.get(${q}).nativeRuntime.cancellation?.status==='pending'`);
    assert.equal(await c.eval('document.querySelector(".floating-input-stop").disabled'),true);await shot('stopping');
    await until(`sessions.get(${q}).nativeRuntime.state==='interrupted' && !sessions.get(${q}).nativeRuntime.cancellation`);
    await shot('completed');report.checks.push('Stop immediately locks actions and only the provider terminal receipt confirms interruption');
    report.passed=true;
  } catch(error) {report.error=error.stack;if(c)try{report.ui=await c.eval('document.body.innerText.slice(-4000)');}catch(e){report.captureError=e.message;}throw error;}
  finally {if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));if(c)await c.close();if(hub)report.exit=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
})().catch(error=>{console.error(error);process.exitCode=1;});
