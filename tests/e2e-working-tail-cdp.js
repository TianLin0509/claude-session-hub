'use strict';
// Real isolated Hub, native protocol fixture and normal send/stop/UI routes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-working-tail-')),out=path.resolve('artifacts/working-tail');
  fs.mkdirSync(out,{recursive:true});const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  const result={checks:[],boundary:'Isolated Electron and real Hub IPC; native App Server protocol fixture',passed:false};let hub,c;
  const wait=async(expr)=>{const end=Date.now()+25000;while(Date.now()<end){if(await c.eval(expr))return;await sleep(100);}throw Error('Timeout: '+expr);};
  const invoke=(name,arg)=>c.eval(`ipcRenderer.invoke(${j(name)},${j(arg)})`);
  const click=async(sel)=>{await wait(`!!document.querySelector(${j(sel)})`);const p=await c.eval(`(()=>{const e=document.querySelector(${j(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${j(sel)});return {x,y};})()`);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
  const shot=async(name)=>{const v=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(v.data,'base64'));};
  const check=(name,value)=>{assert(value,name);result.checks.push(name);console.log('PASS '+name);};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',label:'working-tail',extraEnv:{CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.join(__dirname,'fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'gated',CLAUDE_HUB_FIXTURE_GATE_DIR:path.join(root,'claude-gates')}});
    c=await connectFirstPage(hub);await wait('!!window.MeetingRoom');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1500,height:950,deviceScaleFactor:1,mobile:false});
    const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
    const ordinary=await invoke('create-session',{kind:'codex',opts:{...model,cwd}}),sid=j(ordinary.id);
    await click(`.session-item[data-session-id="${ordinary.id}"]`);
    await wait('!!document.querySelector(".floating-input-box")');
    await click('.floating-input-box');await c.send('Input.insertText',{text:'fixture:working-tail'});await click('.floating-input-send');
    await wait(`sessions.get(${sid})?.nativeRuntime?.state==='running' && document.querySelectorAll('#msg-overlay [data-phase="activity"]').length>0`);
    const tailProbe=`(()=>{const o=document.querySelector('#msg-overlay'),e=o.querySelector('.streaming-indicator');const cards=[...o.querySelectorAll(':scope > .turn-card')].filter(x=>x.getClientRects().length);return !!e && e.parentElement===o && o.lastElementChild===e && e.getBoundingClientRect().height>0 && cards.every(x=>x.getBoundingClientRect().bottom<=e.getBoundingClientRect().top+1);})()`;
    for(const theme of ['dark','codex']){
      await click('#btn-theme');await click(`[data-theme-id="${theme}"]`);await click('#btn-theme');
      await wait(tailProbe);check(theme+' tool-only running indicator remains visible below latest progress',await c.eval(tailProbe));
      check(theme+' ordinary provider logo breathes',await c.eval(`getComputedStyle(document.querySelector('.session-item[data-session-id="${ordinary.id}"] .sl-kind')).animationName==='sl-logo-breathe'`));
      await shot(theme+'-tail');
    }
    await c.eval(`window.__tail=document.querySelector('#msg-overlay > .streaming-indicator');window.__tailAnimation=window.__tail.getAnimations()[0];window.__tailTime=window.__tailAnimation.currentTime;`);
    await sleep(700);
    check('working chip is stable and animation advances during silence',await c.eval('window.__tail===document.querySelector("#msg-overlay > .streaming-indicator") && window.__tailAnimation.currentTime>window.__tailTime+300'));
    await click('.floating-input-stop');await wait(`sessions.get(${sid})?.nativeRuntime?.state==='interrupted' && !document.querySelector('#msg-overlay .streaming-indicator')`);
    check('native stop immediately removes working state',true);
    const group=await invoke('create-meeting',{title:'任意成员工作 · 状态验证',scene:'general',workspace:cwd,slots:[model,model,{kind:'claude',model:'opus',mcpProfile:'none'}]});
    await click(`.session-item[data-meeting-id="${group.id}"]`);await wait('document.querySelector("#mr-input-box")?.getBoundingClientRect().height>0');
    check('new group opens through sidebar on first entry',true);
    const [worker,waiting]=group.subSessions;
    assert((await invoke('session:send-prompt',{sessionId:waiting,text:'fixture:wait'})).ok);
    await wait(`sessions.get(${j(waiting)})?.nativeRuntime?.state==='waiting'`);
    assert((await invoke('session:send-prompt',{sessionId:worker,text:'fixture:working-tail'})).ok);
    const groupSel=`.session-item[data-meeting-id="${group.id}"]`;
    await wait(`document.querySelector(${j(groupSel)})?.classList.contains('running')`);
    check('one working member overrides another waiting member',await c.eval(`document.querySelector(${j(groupSel+' .sl-group-icon')}).classList.contains('run')`));
    check('group logos breathe while a member works',await c.eval(`[...document.querySelectorAll(${j(groupSel+' .sl-group-logos .ai-logo')})].every(e=>getComputedStyle(e).animationName==='sl-logo-breathe')`));
    await shot('group-working');
    // Compact group members are revealed by a real pointer hover.
    const hover=await c.eval(`(()=>{const r=document.querySelector(${j(groupSel)}).getBoundingClientRect();return {x:r.left+40,y:r.top+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...hover});
    await wait(`document.querySelector('.session-item[data-session-id="${worker}"]')?.getBoundingClientRect().height>0`);
    await click(`.session-item[data-session-id="${worker}"]`);
    await wait(tailProbe);check('working member opened from group retains visible tail',true);
    await click('.floating-input-stop');
    await wait(`!document.querySelector(${j(groupSel)})?.classList.contains('running') && document.querySelector(${j(groupSel+' .sl-group-icon')})?.classList.contains('wait')`);
    check('group returns to waiting when its last working member stops',true);
    const claude=group.subSessions[2];
    assert((await invoke('session:send-prompt',{sessionId:claude,text:'检查 Claude 原生执行状态'})).ok);
    await wait(`sessions.get(${j(claude)})?.nativeRuntime?.state==='running' && document.querySelector(${j(groupSel)})?.classList.contains('running')`);
    check('Claude native work also activates the whole group',true);
    await click(`.session-item[data-session-id="${claude}"]`);
    await wait(tailProbe);check('Claude working feedback uses the same visible stream tail',true);
    await shot('claude-tail');
    await click('.floating-input-stop');
    await wait(`!document.querySelector(${j(groupSel)})?.classList.contains('running') && !document.querySelector('#msg-overlay .streaming-indicator')`);
    check('Claude stop clears its working chip',true);
    await click(`.session-item[data-session-id="${ordinary.id}"]`);
    await wait(`activeSessionId===${sid}`);check('switching sessions leaves no ghost working chip',await c.eval('!document.querySelector("#msg-overlay .streaming-indicator")'));
    result.passed=true;
  }catch(error){result.error=error.stack;if(c)await shot('failure');throw error;}
  finally{fs.writeFileSync(path.join(out,'result.json'),j(result));if(c)await c.close();if(hub)await gracefulQuit(hub);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
