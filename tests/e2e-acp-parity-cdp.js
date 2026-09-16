'use strict';
// Actual isolated Hub/CDP. ACP engines and OS save destination are fixtures.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,seedUsageData}=require('./helpers/usage-refresh-fixture');
const j=JSON.stringify,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-complete-parity-')),dataDir=path.join(root,'data');
  const out=path.resolve('artifacts/acp-parity/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const usage=seedUsageData(dataDir,'ring'),config=JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8'));
  const entryPath=path.resolve('tests/fixtures/acp-agent.js'),bridgePath=path.join(root,'bridge');fs.mkdirSync(bridgePath);fs.writeFileSync(path.join(bridgePath,'package.json'),'{}');
  config.acp={nodePath:process.execPath,apiKey:'fixture-no-cloud',providers:{qwen:{entryPath,model:'qwen3.8-max'},
    'deepseek-acp':{entryPath,bridgePath,model:'deepseek-v4-pro'},glm:{entryPath,backendPath:entryPath,model:'glm-5.2'}}};
  fs.writeFileSync(path.join(dataDir,'config.json'),j(config));
  fs.writeFileSync(path.join(dataDir,'prepared-projects.json'),j({schemaVersion:1,projects:[],migrations:[]}));
  const exported=path.join(out,'original.txt'),entry=path.join(root,'entry.cjs');
  fs.writeFileSync(entry,`const e=require('electron');e.app.setAppPath(${j(path.resolve('.'))});process.chdir(${j(path.resolve('.'))});e.dialog.showSaveDialog=async()=>({canceled:false,filePath:${j(exported)}});e.shell.showItemInFolder=()=>{};require(${j(path.resolve('main-bootstrap.js'))});`);
  const report={fixture:true,modelRequests:0,out,checks:[],passed:false};let hub,c;
  try {
    hub=await launchIsolatedHub({entryPath:entry,dataDir,port:await getFreePort(),windowMode:'hidden',extraEnv:{APPDATA:usage.fakeAppData,HUB_ACP_UI_FIXTURE:'1'}});
    c=await connectFirstPage(hub);await c.send('Page.bringToFront');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const until=async(expr,label=expr)=>{const end=Date.now()+45000;while(!await c.eval(expr)){if(Date.now()>end)throw Error('timeout '+label);await sleep(50);}};
    async function click(selector) {
      const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e || e.disabled)throw Error('unavailable '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.height)throw Error('hidden '+${j(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
    }
    async function fill(selector,text){await click(selector);for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await c.send('Input.insertText',{text});}
    async function send(text){await fill('.floating-input-box',text);await click('.floating-input-send');}
    async function shot(name){const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));}
    await until('typeof sessions!=="undefined"');
    for(const kind of ['qwen','deepseek-acp','glm']) {
      const s=await c.eval(`ipcRenderer.invoke('create-session',${j({kind,opts:{cwd:root}})})`),sid=s.id,q=j(sid),r=`sessions.get(${q}).nativeRuntime`;
      await until(`sessions.get(${q})?.nativeRuntime?.state==='idle'`);await click(`.session-item[data-session-id="${sid}"]`);await until('!!document.querySelector(".floating-input-box")');
      await send('cancel');await until(`${r}.state==='running'`);
      const following='队列正文 '+kind+' 🧭 '+ '中文'.repeat(200);
      await send(following);await until(`${r}.queued?.length===1 && !!document.querySelector('.acp-queued-prompt')`);
      assert.equal(await c.eval(`${r}.queued[0].status`),'queued');
      await click('.acp-queued-prompt summary');await until(`document.querySelector('.acp-queued-prompt pre')?.textContent===${j(following)}`);
      await shot(kind+'-queued');await click('.floating-input-stop');await until(`${r}.state==='interrupted' && ${r}.queued[0].status==='held'`);
      const nativeId=await c.eval(`sessions.get(${q}).acpSid`);
      await c.eval(`document.querySelector('.btn-close-session[aria-label="关闭并休眠"]').click()`);
      await until(`sessions.get(${q})?.status==='dormant'`);
      // The real sidebar handler owns recovery (including the exclusive lease).
      await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await until(`activeSessionId===${q} && ${r}.connection==='connected' && !!document.querySelector('[data-queue-action=resume]')`);
      assert.equal(await c.eval(`sessions.get(${q}).acpSid`),nativeId);
      assert.equal(await c.eval(`${r}.queued[0].status`),'held');
      report.checks.push(kind+': close/sidebar reopen preserves native identity and held input without replay');
      await click('[data-queue-action=resume]');await until(`${r}.state==='completed' && ${r}.queued.length===0`);
      await until(`document.querySelector('#msg-overlay').textContent.includes(${j(following.slice(0,20))})`);
      report.checks.push(kind+': composer queue, full pending text, Stop retains prompt and explicit resume completes it');
      await send('HEAVY_HISTORY');await until(`${r}.state==='completed' && document.querySelector('#msg-overlay').textContent.includes('大工具记录已完成')`);
      await fill('.floating-input-box','后台切换后仍保留的草稿');
      await click('#btn-backstage');await until('document.querySelector(".codex-backstage")?.dataset.view==="readable" && document.querySelectorAll(".cb-list > *").length>0');
      const label=await c.eval('document.querySelector(".codex-backstage").getAttribute("aria-label")');assert(!label.startsWith('Codex'));report.checks.push(label);
      await shot(kind+'-backstage');await click('.cb-tabs button:nth-child(2)');await until('document.querySelectorAll(".cb-raw-list > *").length>0');await shot(kind+'-raw');
      if(fs.existsSync(exported))fs.renameSync(exported,path.join(out,'previous-'+kind+'.txt'));
      await click('.cb-export');await until(`require('fs').existsSync(${j(exported)})`);
      const text=fs.readFileSync(exported,'utf8');assert(text.includes('FULL-END-9'));assert(text.includes('end_turn'));assert(text.length>8000000);
      report.checks.push(kind+': original export retains all large results and native stopReason');
      fs.copyFileSync(exported,path.join(out,kind+'-original.txt'));
      await click('.cb-tabs button:nth-child(3)');await until('document.querySelector(".codex-backstage").dataset.view==="legacy"');
      await click('#btn-backstage');await until('currentView==="card"');assert.equal(await c.eval('document.querySelector(".floating-input-box").textContent'),'后台切换后仍保留的草稿');
      await c.eval(`document.querySelector('.btn-close-session[aria-label="关闭并休眠"]').click()`);
      await until(`sessions.get(${q})?.status==='dormant'`);await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await until(`activeSessionId===${q} && ${r}.connection==='connected' && !!document.querySelector('.floating-input-box')`);
      await click('#btn-backstage');await until('document.querySelector(".codex-backstage")?.dataset.view==="readable"');
      const recovered=await c.eval(`ipcRenderer.invoke('codex:backstage-read',{sessionId:${q},mode:'raw',limit:16})`);
      assert(recovered.ok && recovered.chunks.some(chunk=>chunk.text.includes('FULL-END-9')));
      await click('#btn-backstage');await until('currentView==="card"');
      assert.equal(await c.eval('document.querySelector(".floating-input-box").textContent'),'后台切换后仍保留的草稿');
      assert.equal(await c.eval('!![...document.querySelectorAll(".native-draft-error")].find(e=>!e.hidden && e.textContent)'),false);
      report.checks.push(kind+': original backstage records survive driver close and sidebar reopen');
      console.log('PASS complete parity and recovery: '+kind);
    }
    const group=await c.eval(`ipcRenderer.invoke('create-meeting',${j({title:'三家 ACP 对齐验证',scene:'general',workspace:root,slots:Object.entries(config.acp.providers).map(([kind,p])=>({kind,model:p.model}))})})`);
    await until(`${j(group.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.state==='idle')`);
    await c.eval(`window.MeetingRoom.openMeeting(${j(group.id)},${j(group)})`);await until('!!document.querySelector("#mr-input-box")');
    for(const marker of ['ACP_GROUP_PARITY_ONE','ACP_GROUP_PARITY_TWO']) {
      await fill('#mr-input-box',marker);await click('#mr-send-btn');
      await until(`(async()=>{const state=await ipcRenderer.invoke('groupchat:get-state',{meetingId:${j(group.id)}});return state?.messages?.filter(m=>m.role==='assistant' && m.content?.includes(${j(marker)})).length===3;})()`,'three member answers '+marker);
      await until(`${j(group.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.state==='completed')`);
    }
    await until(`[...document.querySelectorAll('#meeting-room img[src*="ai-logos/"], #mr-group-chat-panel img[src*="ai-logos/"]')].every(img=>img.complete && img.naturalWidth>0)`,'all group provider logos loaded');
    assert.equal(await c.eval('!!document.querySelector(\'img[src$="deepseek-acp.svg"]\')'),false);
    await shot('three-provider-group');report.checks.push('real group composer/dispatcher completes two rounds with all three ACP members; provider logos load');
    report.passed=true;
  }catch(error){report.error=error.stack;if(c)try{report.dom=await c.eval('document.body.innerText.slice(-5000)');const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(s.data,'base64'));}catch(diag){report.diagnosticError=diag.message;}process.exitCode=1;}
  finally {
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(c)await c.close();if(hub)report.exit=await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
