'use strict';
// Real isolated Electron UI/IPC. External Codex protocol uses the repository
// fixture; alert dedup is a component probe, not a real writer-conflict claim.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ui-polish-'));
  const out=path.resolve(__dirname,'../artifacts/ui-polish/gui');fs.mkdirSync(out,{recursive:true});
  const cwd=path.join(root,'workspace'),home=path.join(root,'codex');fs.mkdirSync(cwd);fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  const result={root,out,checks:[],passed:false,boundary:'Real isolated Hub/UI/IPC; external Codex App Server fixture; notices tested as components'};
  let hub,cdp;
  const ok=(label,condition=true)=>{assert(condition,label);result.checks.push(label);console.log('PASS '+label);};
  const until=async(expr,label)=>{const deadline=Date.now()+30000;let last;while(Date.now()<deadline){last=await cdp.eval(expr);if(last===true || typeof last==='string' && last)return last;await sleep(100);}throw Error('timeout: '+label+' '+JSON.stringify(last));};
  const click=async(selector,button='left')=>{
    const p=await cdp.eval(`(()=>{const es=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=es.find(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(el).visibility!=='hidden'});if(!e)throw Error('Missing visible '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return {x,y};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button,clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button,clickCount:1});
  };
  const snap=async(name)=>{
    await cdp.send('Page.bringToFront');
    // Flush the compositor through CDP. Renderer rAF can be suspended by
    // Chromium occlusion even when visibilityState reports visible.
    await cdp.send('Page.captureScreenshot',{format:'png'});
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
  };
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freePort(),windowMode:'visible',label:'ui-polish',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js')}});
    result.pid=hub.pid;result.port=hub.port;
    cdp=await connectFirstPage(hub,t=>/index\.html/.test(t.url));
    await until('typeof sessions !== "undefined" && !!window.MeetingRoom','renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
    ok('fresh install defaults to Graphite',await cdp.eval('document.documentElement.dataset.theme === "dark"'));
    const opts={cwd,title:'Hub 界面精修 · 双主题验证',userRenamed:true,model:'gpt-6-astra',effort:'high',mcpProfile:'none',codexSpeedTier:'standard'};
    const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts})+')');
    result.sessionId=s.id;const sid=JSON.stringify(s.id),row='.session-item[data-session-id="'+s.id+'"]';
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "idle"','native ready');
    await click(row);
    await until('!!document.querySelector(".floating-input-box")','composer ready');
    if (await cdp.eval('currentView === "pty"')) await click('#btn-backstage');
    await cdp.eval('(()=>{const e=document.querySelector(".floating-input-box");e.textContent="请检查界面一致性，保留 English、48 kHz 与否定词。";e.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await click('.floating-input-send');
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "completed"','native reply');
    await until('!!document.querySelector(".turn-card.assistant")','real reply card');
    ok('original composer sends through Hub and receives native fixture reply');
    ok('secondary actions remain separate from model/send controls',await cdp.eval('!!document.querySelector(".composer-secondary-actions .fi-bridge-toolbar") && !document.querySelector(".composer-rail .fi-bridge-toolbar")'));
    for(const theme of ['dark','codex']){
      await click('#btn-theme');await click('#theme-menu [data-theme-id="'+theme+'"]');
      await until('document.documentElement.dataset.theme === '+JSON.stringify(theme),'theme switch');
      await snap(theme+'-themes');
      ok(theme+' theme menu paints above the composer',await cdp.eval('(()=>{const e=document.getElementById("theme-menu"),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.right-5,r.bottom-12));})()'));
      await click('#btn-theme');
      const probe=await cdp.eval(`(()=>{const c=document.querySelector('.composer'),r=c.getBoundingClientRect(),send=c.querySelector('.floating-input-send'),sr=send.getBoundingClientRect();return {bg:getComputedStyle(c).backgroundColor,shadow:getComputedStyle(send).boxShadow,sendInside:sr.left>=r.left&&sr.right<=r.right,status:document.getElementById('card-session-status')?.textContent,voice:!!c.querySelector('.voice-mic svg')};})()`);
      result[theme]=probe;
      ok(theme+' main/voice controls follow the approved theme',probe.sendInside&&probe.shadow==='none'&&probe.voice);
      ok(theme+' parameters have product labels',probe.status.includes('推理 · 高')&&probe.status.includes('速度 · 标准'));
      await snap(theme+'-session');
      const p=await cdp.eval('(()=>{const r=document.querySelector('+JSON.stringify(row)+').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
      await until('!!document.querySelector(".hub-session-peek")','hover summary');
      const hover=await cdp.eval('(()=>{const e=document.querySelector(".hub-session-peek"),r=e.getBoundingClientRect();return {x:r.left+20,y:r.top+20,inside:r.right<=innerWidth&&r.bottom<=innerHeight,text:e.textContent};})()');
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:hover.x,y:hover.y});await sleep(350);
      ok(theme+' hover remains open when entering card',hover.inside&&await cdp.eval('!!document.querySelector(".hub-session-peek")'));
      await snap(theme+'-hover');
      ok(theme+' hover stays visible after painting',await cdp.eval('!!document.querySelector(".hub-session-peek")'));
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await until('!document.querySelector(".hub-session-peek")','hover dismissed');
      await sleep(400);ok(theme+' Escape does not reopen hover',await cdp.eval('!document.querySelector(".hub-session-peek")'));
      await click('.composer-thinking');await until('!!document.querySelector(".model-picker-menu")','effort menu');
      await snap(theme+'-model');
      ok(theme+' model menu exposes keyboard targets',await cdp.eval('[...document.querySelectorAll(".model-picker-item")].some(e=>e.tabIndex===0)'));
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await until('!document.querySelector(".model-picker-menu")','model menu escape');
      // Component-level probe: repeated backend notices reuse a single dialog.
      await cdp.eval(`(()=>{const f=require('./ui-feedback');window.__noticeA=f.showHubAlert('会话恢复失败：already has an active writer');window.__noticeB=f.showHubAlert('会话恢复失败：already has an active writer');})()`);
      await until('!!document.querySelector(".hub-dialog[open]")','notice');
      ok(theme+' duplicate notice is consolidated',await cdp.eval('window.__noticeA === window.__noticeB && document.querySelectorAll(".hub-dialog").length === 1'));
      await snap(theme+'-dialog');await click('.hub-dialog .hub-button-primary');
      await until('!document.querySelector(".hub-dialog")','notice closed');
    }
    // Destructive action follows the real context-menu handler; cancellation
    // must leave the real Main session alive, acceptance removes only this test session.
    await click(row,'right');await click('#context-menu [data-action="delete"]');
    await until('!!document.querySelector(".hub-dialog[open]")','delete confirmation');
    ok('delete does not run before confirmation',await cdp.eval('(async()=> (await ipcRenderer.invoke("get-sessions")).some(s=>s.id==='+sid+'))()'));
    await click('.hub-dialog .hub-button:not(.hub-button-primary)');
    ok('cancel retains session',await cdp.eval('(async()=> (await ipcRenderer.invoke("get-sessions")).some(s=>s.id==='+sid+'))()'));
    const disposable=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{...opts,title:'删除确认验证'}})+')');
    const disposableId=JSON.stringify(disposable.id);
    await until('sessions.get('+disposableId+')?.nativeRuntime?.state === "idle"','disposable ready');
    await until('!!document.querySelector('+JSON.stringify('.session-item[data-session-id="'+disposable.id+'"]')+')','disposable row rendered');
    await click('.session-item[data-session-id="'+disposable.id+'"]','right');await click('#context-menu [data-action="delete"]');
    await until('!!document.querySelector(".hub-dialog[open]")','delete acceptance');
    ok('destructive confirmation focuses cancel',await cdp.eval('document.activeElement.textContent === "保留会话"'));
    await click('.hub-dialog .hub-button-danger');
    await until('(async()=> !(await ipcRenderer.invoke("get-sessions")).some(s=>s.id==='+disposableId+'))()','confirmed deletion');
    ok('accept deletes only the selected disposable session',await cdp.eval('(async()=> (await ipcRenderer.invoke("get-sessions")).some(s=>s.id==='+sid+'))()'));
    await click(row);
    const group=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'双主题群聊验证',scene:'general',workspace:cwd,slots:[{kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none',codexSpeedTier:'standard'}]})+')');
    result.meetingId=group.id;
    await until('sessions.get('+JSON.stringify(group.subSessions[0])+')?.nativeRuntime?.state === "idle"','group member ready');
    await cdp.eval('window.MeetingRoom.openMeeting('+JSON.stringify(group.id)+','+JSON.stringify(group)+')');
    await until('!!document.getElementById("mr-input-box")','group composer');
    for(const theme of ['dark','codex']){
      await click('#btn-theme');await click('#theme-menu [data-theme-id="'+theme+'"]');
      await click('#btn-theme');
      await snap(theme+'-group');
      ok(theme+' group voice and send stay visible',await cdp.eval('(()=>{const send=document.getElementById("mr-send-btn"),r=send.getBoundingClientRect();return r.width>0&&r.right<=innerWidth&&!!document.querySelector(".mr-group-composer .voice-mic");})()'));
      ok(theme+' group parameters share ordinary-session labels',await cdp.eval('document.querySelector(".mr-group-composer .composer-thinking").textContent.includes("推理 · 高") && document.querySelector(".mr-group-composer .composer-speed").textContent.includes("速度 · 标准")'));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
    await snap('codex-group-1024');
    ok('narrow group has no page overflow',await cdp.eval('document.documentElement.scrollWidth<=innerWidth'));
    result.passed=true;
  }catch(error){result.error=error.stack;throw error;}
  finally{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
