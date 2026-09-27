'use strict';
// Actual isolated Electron composer -> IPC -> dispatcher -> OS-pipe provider.
// The gated provider is controlled; file production here is NOT a model test.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const D=require('../core/delivery-workflow');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-delivery-gui-')),DATA=path.join(ROOT,'data'),GATES=path.join(ROOT,'gates');
const ART=path.resolve('artifacts/delivery-workflow');fs.mkdirSync(ART,{recursive:true});fs.mkdirSync(GATES,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const received=()=>{const p=path.join(GATES,'received.jsonl');return fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];};
const release=m=>fs.writeFileSync(path.join(GATES,m.uuid+'.json'),JSON.stringify({result:'CLI 已完成本次回答'}));
(async()=>{
 let hub,cdp,id,launchOptions;const evidence={controlledProtocol:true,realModel:false,checks:[],root:ROOT};
 const invoke=(channel,args={})=>cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
 const wait=async(label,pred,ms=35000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await pred();if(r)return r;await delay(120);}throw Error('Timeout: '+label);};
 const state=()=>invoke('delivery:status',{meetingId:id});
 const click=async sel=>{const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const send=async text=>{await click('#mr-input-box');await cdp.send('Input.insertText',{text});for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
 function deliver(member){const base=D.directory(DATA,id),r=JSON.parse(fs.readFileSync(path.join(base,'run.json'),'utf8')),s=r.steps.at(-1),p=D.paths(base,r,s,member);fs.appendFileSync(p.draft,'已核对本轮职责；隔离协议夹具交付。\n');fs.renameSync(p.draft,p.ready);}
 const shot=async name=>{const p=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(ART,name+'.png'),Buffer.from(p.data,'base64'));};
 try{
  const workspace=path.join(ROOT,'workspace');fs.mkdirSync(workspace);
  launchOptions={dataDir:DATA,port:await port(),windowMode:'hidden',extraEnv:{CLAUDE_HUB_HOME_DIR:path.join(ROOT,'home'),AI_HUB_WORKSPACE_ROOT:ROOT,
   CLAUDE_CONFIG_DIR:path.join(ROOT,'claude'),CODEX_HOME:path.join(ROOT,'codex'),CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'gated',CLAUDE_HUB_FIXTURE_GATE_DIR:GATES}};
  hub=await launchIsolatedHub(launchOptions);
  cdp=await connectFirstPage(hub);evidence.pid=hub.pid;
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await wait('renderer',()=>cdp.eval('!!window.MeetingRoom'));
  const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'逐成员文件交付验收',workspace,slots:[0,1,2].map(i=>({index:i,memberId:'m'+(i+1),kind:'claude',model:'claude-haiku-4-5-20251001',mcpProfile:'lean'}))});id=m.id;
  const draft={version:1,kind:'serial',presetId:'custom',enabled:true,rounds:[{name:'独立作答',members:['m1','m2'],prompt:'各自交付独立答案。',after:'next'},{name:'交叉核对',members:['m3'],prompt:'读取前序两个文件后交付结论。',after:'next'},{name:'补充验证',members:['m1'],prompt:'核对上一步并交付。',after:'end'}]};
  const configured=await invoke('workflow:configure',{meetingId:id,draft,expectedRevision:m.serialWorkflow?.settingsRevision || 0});assert(configured.ok,configured.reason);
  const fresh=(await invoke('get-meetings')).find(x=>x.id===id);await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`);
  await wait('delivery controls',()=>cdp.eval("!!document.querySelector('[data-delivery=files]')"));await send('验证每人交付、晚到文件与显式暂停。');
  await wait('two first members',()=>received().length===2);const first=[...received()];
  release(first[0]);await delay(1300);assert.equal(received().length,2);assert.equal((await state()).round,1);evidence.checks.push('CLI final without files does not advance');
  deliver('m1');await wait('one delivered',async()=>(await state()).delivered===1);assert.equal(received().length,2);
  deliver('m2');await wait('next different member before old CLI final',()=>received().length===3);assert.equal((await state()).round,2);evidence.checks.push('all members barrier; completed files advance to different seat despite old pending chat');
  first.forEach(release); // The receipt order of the two parallel members is not fixed.
  await click('[data-delivery=stop]');await wait('paused',async()=>(await state()).paused);deliver('m3');await delay(2500);assert.equal(received().length,3);evidence.checks.push('user pause survives late delivery');
  await shot('paused');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:850,height:1100,deviceScaleFactor:1,mobile:false});
  assert(await cdp.eval("[...document.querySelectorAll('[data-delivery]')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.x>=0&&r.right<=innerWidth+1;})"),'delivery controls remain visible at narrow width');await shot('narrow');
  assert(await cdp.eval("(()=>{const head=document.querySelector('#mr-composer-head').getBoundingClientRect(),row=document.querySelector('#mr-input-row').getBoundingClientRect();return head.y>=row.y&&head.bottom<=row.bottom;})()"),'progress remains inside composer without overlapping chat');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click('[data-delivery=resume]');await wait('third round',()=>received().length===4);assert.equal((await state()).round,3);
  await click('[data-delivery=resume]');await delay(600);assert.equal(received().length,4);evidence.checks.push('explicit reconciliation advances exactly once and never replays intent');
  deliver('m1');await wait('all done',async()=>(await state()).done);await shot('done');evidence.checks.push('delivery completes with last CLI answer still pending');
  // Close only this test Hub and verify that its writers drain cleanly.
  const runId=(await state()).runId;await cdp.close();cdp=null;const quit=await gracefulQuit(hub);assert(!quit.forced,'clean writer shutdown');hub=null;evidence.quit=quit;evidence.runId=runId;
  hub=await launchIsolatedHub({...launchOptions,port:await port()});cdp=await connectFirstPage(hub);await wait('restarted renderer',()=>cdp.eval('!!window.MeetingRoom'));
  const restored=await state();assert(restored.done);assert.equal(restored.runId,runId);await delay(1600);assert.equal(received().length,4);evidence.checks.push('real Hub restart retains completed run without re-sending any prompt');
  evidence.passed=true;
 }catch(error){evidence.error=error.stack;if(cdp){try{await shot('failure');evidence.state=await state();evidence.ui=await cdp.eval('document.body.innerText.slice(-14000)');}catch(e){evidence.captureError=e.message;}}throw error;}
 finally{evidence.received=received().map(x=>({sessionId:x.sessionId,uuid:x.uuid}));if(cdp)await cdp.close();if(hub){evidence.logs=hub.log();evidence.quit=await gracefulQuit(hub);}fs.writeFileSync(path.join(ART,'evidence.json'),JSON.stringify(evidence,null,2),'utf8');console.log(JSON.stringify(evidence,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
