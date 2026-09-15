'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-backstage-status-')),out=path.resolve('artifacts/backstage-status/'+Date.now());
  fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'data','prepared-projects.json'),j({schemaVersion:1,projects:[],migrations:[]}));
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
  let hub,c;const report={out,checks:[],passed:false};
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,label:'backstage-status',extraEnv:{CODEX_HOME:path.join(root,'codex'),
      CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-backstage-status.js')}});
    c=await connectFirstPage(hub);await c.send('Page.bringToFront');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    report.systemReducedMotion=await c.eval('matchMedia("(prefers-reduced-motion:reduce)").matches');
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const until=async(expr)=>{const end=Date.now()+25000;while(!await c.eval(expr)){if(Date.now()>end)throw Error('timeout '+expr);await sleep(60);}};
    async function click(selector){await until(`!!document.querySelector(${j(selector)}) && !document.querySelector(${j(selector)}).disabled`);
      const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.height)throw Error('hidden control');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});}
    async function send(text){await click('.floating-input-box');await c.send('Input.insertText',{text});await click('.floating-input-send');}
    async function shot(name){const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));}
    const state=expected=>until(`document.querySelector('.cb-live')?.dataset.state===${j(expected)}`);
    await until('typeof sessions!=="undefined"');
    for(const provider of ['codex','claude']){
      const s=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:provider,opts:{cwd:root,mcpProfile:'none',...(provider==='codex'?{model:'gpt-6-astra'}:{model:'claude-opus-5[1m]'})}})})`),q=j(s.id);
      await until(`sessions.get(${q})?.nativeRuntime?.connection==='connected'`);
      await click(`.session-item[data-session-id="${s.id}"]`);await click('#btn-backstage');await state('idle');
      await send(provider==='codex'?'fixture:hold':'SILENT');await state(provider==='codex'?'running':'starting');
      assert.equal(await c.eval('document.querySelector(".cb-live").dataset.animated'),'true');
      assert.equal(await c.eval('document.querySelectorAll(".cb-entry[data-type=agentMessage]").length'),0);
      const transform=await c.eval('getComputedStyle(document.querySelector(".cb-live-indicator")).transform');
      await until(`getComputedStyle(document.querySelector('.cb-live-indicator')).transform!==${j(transform)}`);
      const elapsed=await c.eval('document.querySelector(".cb-live-elapsed").textContent');
      await until(`document.querySelector('.cb-live-elapsed').textContent!==${j(elapsed)}`);
      const reads=await c.eval(`terminalCache.get(${q})._codexBackstage.stats().readCount`);
      const elapsed2=await c.eval('document.querySelector(".cb-live-elapsed").textContent');
      await until(`document.querySelector('.cb-live-elapsed').textContent!==${j(elapsed2)}`);
      assert.equal(await c.eval(`terminalCache.get(${q})._codexBackstage.stats().readCount`),reads);
      await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await until('getComputedStyle(document.querySelector(".cb-live-indicator")).animationName==="none"');
      const reducedClock=await c.eval('document.querySelector(".cb-live-elapsed").textContent');
      await until(`document.querySelector('.cb-live-elapsed').textContent!==${j(reducedClock)}`);
      await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      report.checks.push(provider+': reduced-motion preference disables rotation while status and elapsed time remain live');
      await shot(provider+'-silent');report.checks.push(provider+': received silent turn has a rotating indicator and advancing clock without history polling');
      for(const tab of [2,3,1]){await click(`.cb-tabs button:nth-child(${tab})`);assert.equal(await c.eval('document.querySelector(".cb-live").getBoundingClientRect().height>0'),true);}
      await click('#btn-backstage');await until('currentView==="card" && document.querySelector(".cb-live").dataset.animated==="false"');
      await click('#btn-backstage');await until('currentView==="pty" && document.querySelector(".cb-live").dataset.animated==="true"');
      report.checks.push(provider+': status survives all three views and re-entry; hidden animation pauses');
      await click('.floating-input-stop');await state('interrupted');
      assert.equal(await c.eval('document.querySelector(".cb-live").dataset.animated'),'false');await shot(provider+'-stopped');
      if(provider==='claude'){
        await send('RUNNING');await state('running');
        await until('!!document.querySelector(".cb-entry[data-type=mcpToolCall][data-status=running]")');
        await shot('claude-running-without-text');await click('.floating-input-stop');await state('interrupted');
        await until('!!document.querySelector(".cb-entry[data-type=mcpToolCall][data-status=interrupted]")');
        assert.equal(await c.eval('document.querySelectorAll(".cb-entry[data-status=running]").length'),0);
        report.checks.push('claude: Stop settles unfinished tool rows as interrupted without inventing output');
      }
      await send(provider==='codex'?'fixture:approval':'WAIT');await state('waiting');
      assert.equal(await c.eval('document.querySelector(".cb-live").dataset.animated'),'false');await shot(provider+'-waiting');
      await click(provider==='codex'?'.codex-native-controls form button':'.claude-native-controls form button');await state('completed');
      assert.equal(await c.eval('document.querySelector(".cb-live").dataset.animated'),'false');
      report.checks.push(provider+': native interruption, approval waiting and completion stop the animation');
      await send(provider==='codex'?'fixture:crash':'CRASH');await state('unknown');
      assert.equal(await c.eval('document.querySelector(".cb-live").dataset.animated'),'false');await shot(provider+'-disconnected');
      report.checks.push(provider+': actual fixture child exit shows connection uncertainty, never a working spinner');
    }
    report.passed=true;
  }catch(e){report.error=e.stack;if(c){report.ui=await c.eval('({text:document.querySelector(".cb-live")?.outerHTML,animation:document.querySelector(".cb-live-indicator")&&getComputedStyle(document.querySelector(".cb-live-indicator")).animation,hidden:document.hidden})');}throw e;}finally{
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(c)await c.close();if(hub)report.exit=await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
