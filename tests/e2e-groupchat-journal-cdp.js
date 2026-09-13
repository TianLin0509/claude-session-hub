'use strict';
// Real isolated Hub + native stdio fixture. No production data or paid AI calls.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,pause=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-journal-')),out=path.resolve(process.env.JOURNAL_EVIDENCE_DIR||'artifacts/groupchat-journal');
  fs.mkdirSync(out,{recursive:true});const cwd=path.join(root,'workspace'),home=path.join(root,'codex');fs.mkdirSync(cwd);fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  const port=await new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>res(n));});});
  let hub,c,clipboard;const evidence={checks:[],passed:false};
  const until=async(expr,label)=>{const end=Date.now()+60000;while(Date.now()<end){if(await c.eval(expr))return;await pause(150);}throw Error('timeout: '+label);};
  const click=async selector=>{const pos=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('missing '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...pos});for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});await pause(120);};
  const shot=async name=>{await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await pause(180);const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
  const check=(name,pass,detail)=>{assert(pass,name+': '+j(detail));evidence.checks.push({name,detail});console.log('PASS '+name);};
  const send=async text=>{await c.eval(`(()=>{const e=document.getElementById('mr-input-box');e.textContent=${j(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);await click('#mr-send-btn');};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',label:'groupchat-journal',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js')}});
    evidence.pid=hub.pid;c=await connectFirstPage(hub);await c.send('Page.enable');await c.send('Page.bringToFront');await until('typeof sessions!=="undefined" && !!window.__hubE2E','renderer');
    clipboard=await c.eval('require("electron").clipboard.readText()');
    await c.eval('require("electron").webFrame.setZoomFactor(1)');await c.send('Emulation.setDeviceMetricsOverride',{width:1550,height:1080,deviceScaleFactor:1,mobile:false});
    const opts={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none',codexSpeedTier:'standard'};
    const group=await c.eval(`ipcRenderer.invoke('create-meeting',${j({title:'线性手记 · 群聊阅读验证',groupChat:true,scene:'general',workspace:cwd,slots:[opts,opts]})})`);evidence.group=group.id;
    const open=async()=>{await until(`!!document.querySelector('[data-meeting-id="${group.id}"]')`,'sidebar group');await click(`[data-meeting-id="${group.id}"]`);await until('!!document.getElementById("mr-input-box")','group composer');};
    await open();await send('fixture:conversation\n请用完整长回答核对群聊折叠与成员身份。');
    await until('document.querySelectorAll(".mr-gc-messages .mr-gc-msg.ai:not(.pending) .gc-journal-text [data-phase=final_answer]").length===2','two complete native answers');
    await until('document.querySelectorAll(".mr-gc-messages .gc-journal-long").length===2','long answer measurement');
    const ids=await c.eval('[...document.querySelectorAll(".mr-gc-msg.ai")].map(e=>e.dataset.gcMsgId)');
    const first=`[data-gc-msg-id="${ids[0]}"]`;
    const initial=await c.eval(`(()=>{const a=[...document.querySelectorAll('.mr-gc-msg.ai')];return a.map(e=>({color:e.dataset.journalColor,bg:getComputedStyle(e.querySelector('.mr-gc-bubble')).backgroundColor,height:e.querySelector('.gc-journal-text').clientHeight,full:e.querySelector('.gc-journal-text').scrollHeight,nested:e.querySelectorAll('.conversation-long-message').length}));})()`);
    check('same-provider members have distinct color; complete source is clipped once',new Set(initial.map(x=>x.bg)).size===2&&initial.every(x=>x.height<=240&&x.full>300&&x.nested===0),initial);
    check('actions are in the header; inert raw-index button removed',await c.eval(`!document.querySelector('.mr-gc-anchor') && document.querySelectorAll('.mr-gc-msg.ai .mr-gc-bubble-row > button').length===0 && document.querySelectorAll('.mr-gc-msg.ai .mr-gc-meta .mr-gc-copy-btn').length===2`));
    await shot('dark-collapsed');await click(first+' .gc-journal-expand');
    check('expand complete answer',await c.eval(`document.querySelector(${j(first)}).dataset.journalExpanded==='true' && document.querySelector(${j(first+' .gc-journal-text')}).clientHeight>300`));
    await click(first+' [data-gc-copy-message]');await until('(require("electron").clipboard.readText().match(/这是同一条长回答中的验证说明/g)||[]).length===36','copy includes all 36 list items');
    check('copy full answer includes all 36 list items',true);
    await click(first+' .gc-journal-minimize');check('whole card folds',await c.eval(`getComputedStyle(document.querySelector(${j(first+' .mr-gc-bubble-row')})).display==='none'`));
    await click(first+' .gc-journal-minimize');check('restored card retains manual full-text state',await c.eval(`document.querySelector(${j(first)}).dataset.journalExpanded==='true' && !document.querySelector(${j(first+' .gc-journal-expand')}).hidden`));
    await click(first+' .gc-journal-menu > summary');await until(`document.querySelector(${j(first+' .gc-journal-menu')}).open`,'action menu');await shot('actions');
    await click(first+' [data-gc-view-prompt]');await until('!!document.querySelector(".mr-gc-prompt-modal-overlay")','archived prompt');
    check('real archived prompt opens',await c.eval('document.querySelector(".mr-gc-prompt-modal-body").textContent.includes("fixture:conversation")'));
    await click('.mr-gc-prompt-modal-close');
    await click('#btn-theme');await click('#theme-menu [data-theme-id="codex"]');await until('document.documentElement.dataset.theme==="codex"','paper theme');await click('#btn-theme');
    await click(first+' .gc-journal-expand');await shot('codex-collapsed');
    await click(first+' .gc-journal-expand');
    // A second real native turn rebuilds/patches group cards while reading old text.
    await send('fixture:compact-progress\n继续记录进展，不改变我展开的上一轮。');
    await until('document.querySelectorAll(".mr-gc-msg.ai").length>=4','next round starts');
    await c.eval(`document.querySelector('.mr-gc-messages').focus()`);
    for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36});
    await until('document.querySelector(".mr-gc-messages").scrollTop<3 && !document.querySelector(".mr-gc-messages")._cardFollowController.isFollowing()','user reads history with Home');
    const oldTop=await c.eval('document.querySelector(".mr-gc-messages").scrollTop');
    await until('document.querySelectorAll(".mr-gc-msg.ai:not(.pending) .gc-journal-text [data-phase=final_answer]").length===4','second real round complete');
    const finalTop=await c.eval('document.querySelector(".mr-gc-messages").scrollTop');
    check('stream updates preserve old disclosure and reading position',await c.eval(`document.querySelector(${j(first)}).dataset.journalExpanded==='true'`)&&Math.abs(finalTop-oldTop)<5,{oldTop,finalTop});
    await c.send('Page.reload');await until('typeof window.MeetingRoom!=="undefined"','reload');await open();
    await until(`!!document.querySelector(${j(first)})`,'durable answers');
    check('reload retains expansion and member identity',await c.eval(`document.querySelector(${j(first)}).dataset.journalExpanded==='true' && document.querySelector(${j(first)}).dataset.journalColor===${j(initial[0].color)}`));
    await c.send('Emulation.setDeviceMetricsOverride',{width:1050,height:800,deviceScaleFactor:1,mobile:false});await shot('narrow');
    check('narrow group has no horizontal overflow',await c.eval('document.querySelector(".mr-gc-messages").scrollWidth<=document.querySelector(".mr-gc-messages").clientWidth+1'));
    await click('#mr-btn-group-tools');await click('[data-journal-collapse-all]');
    check('bulk collapse from group tools',await c.eval('[...document.querySelectorAll(".mr-gc-msg.ai")].every(e=>e.dataset.journalExpanded==="false")'));
    await click(first+' [data-gc-open-session]');await until('!!document.querySelector(".floating-input-box")','member session');
    check('ordinary member view remains separate',await c.eval('document.querySelectorAll("#msg-overlay [data-journal-key]").length===0'));
    const dev=await c.eval(`ipcRenderer.invoke('create-meeting',${j({title:'线性手记 · 开发群聊',groupChat:true,mode:'dev',workspace:cwd,slots:[opts,opts]})})`);
    check('development group created with the real dev scene',dev.scene==='dev',dev.scene);
    await until(`!!document.querySelector('[data-meeting-id="${dev.id}"]')`,'dev sidebar');await click(`[data-meeting-id="${dev.id}"]`);await send('fixture:compact-progress\n核对开发群聊的整卡折叠。');
    await until('!!document.querySelector(".mr-gc-msg.ai:not(.pending) .gc-journal-text [data-phase=final_answer]")','dev final');await shot('dev-journal');
    check('development group uses journal without exposing forbidden retry',await c.eval('!!document.querySelector(".gc-journal-long") && !document.querySelector("[data-gc-retry-answer]")'));
    evidence.passed=true;
  }catch(error){evidence.error=error.stack;throw error;}
  finally{if(c){try{await shot('last');if(clipboard!==undefined)await c.eval(`require('electron').clipboard.writeText(${j(clipboard)})`);}catch(error){evidence.captureError=error.message;}await c.close();}if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));evidence.exit=await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'evidence.json'),j(evidence));console.log(j(evidence));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
