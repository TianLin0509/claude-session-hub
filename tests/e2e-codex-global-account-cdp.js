'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-account-switch-')),data=path.join(root,'data'),a=path.join(root,'a'),b=path.join(root,'b'),cwd=path.join(root,'work');
 const out=path.resolve('artifacts/codex-global-account/gui-'+Date.now());
 for(const p of [data,a,b,cwd,out])fs.mkdirSync(p,{recursive:true});
 const configFile=path.join(data,'config.json');
 fs.writeFileSync(configFile,JSON.stringify({providers:{codex:{backend:'subscription',subscription_profile:'default',subscription_profiles:[{id:'default',label:'账号 A · 默认',home:a},{id:'second',label:'账号 B · 备用',home:b}]}}}));
 const result={root,out,checks:[],passed:false};let hub,cdp;
 const until=async(expr,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await cdp.eval(expr))return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout '+label);};
 const invoke=(channel,value)=>cdp.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(value)})`);
 async function click(selector){const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});}
 async function start(){hub=await launchIsolatedHub({dataDir:data,port:await port(),label:'global-account',windowMode:'hidden',extraEnv:{
  CODEX_HOME:a,CLAUDE_HUB_HOME_DIR:path.join(root,'home'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),HUB_CODEX_PROFILE:'',HUB_CODEX_BACKEND:'subscription',
  AI_HUB_WORKSPACE_ROOT:path.join(root,'workspaces'),CLAUDE_HUB_E2E:'1',DEEPSEEK_API_KEY:'',
  CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT:'1',
  CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(root,'threads'),CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl')}});
  cdp=await connectFirstPage(hub);await until('!!window.WorkspaceController && typeof sessions!=="undefined"','renderer');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 }
 async function stop(){if(cdp){await cdp.close();cdp=null;}if(hub){fs.appendFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);hub=null;}}
 async function create(text){const s=await invoke('create-session',{kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'max',mcpProfile:'none',codexSpeedTier:'standard'}});
  await until(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.connection==='connected'`,'connected');
  if(text){const r=await invoke('session:send-prompt',{sessionId:s.id,text,clientSubmissionId:s.id+'-once'});assert(r.ok,JSON.stringify(r));await until(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.state===${JSON.stringify(text==='fixture:hold'?'running':'completed')}`,'turn');}
  return await cdp.eval(`JSON.parse(JSON.stringify(sessions.get(${JSON.stringify(s.id)})))`);
 }
 try{
  await start();const idle=await create('remember A history'),busy=await create('fixture:hold'),sleeping=await create('sleeping A history');
  assert((await invoke('close-session',sleeping.id)).ok);
  await click('#btn-new-more');await until('document.querySelector("#new-session-menu").style.display!=="none"','launcher');
  await click('.new-session-option[data-kind="codex"]');await until('document.querySelector("#new-session-account").options.length===2','accounts loaded');
  await click('#new-session-account');
  for(const [key,code,keyCode] of [['End','End',35],['Enter','Enter',13]])for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode});
  await until('document.querySelector("#new-session-account").value==="second" && !document.querySelector("#new-session-account").disabled','saved selection');
  assert.equal(JSON.parse(fs.readFileSync(configFile,'utf8')).providers.codex.subscription_profile,'second');
  await until(`sessions.get(${JSON.stringify(idle.id)}).codexProfile==='second' && sessions.get(${JSON.stringify(idle.id)}).nativeRuntime.connection==='connected'`,'idle migrated');
  assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(idle.id)}).codexSid`),idle.codexSid);
  assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(busy.id)}).codexProfile`),'default');
  result.checks.push('real launch selector persists global choice immediately; idle thread migrates; busy turn stays on original account');
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'selector.png'),Buffer.from(shot.data,'base64'));
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(JSON.parse(fs.readFileSync(configFile,'utf8')).providers.codex.subscription_profile,'second');
  result.checks.push('cancelling launch does not revert the global choice');
  assert((await invoke('codex:native-action',{sessionId:busy.id,action:'interrupt'})).ok);
  await until(`sessions.get(${JSON.stringify(busy.id)}).codexProfile==='second' && sessions.get(${JSON.stringify(busy.id)}).nativeRuntime.connection==='connected'`,'busy migrates after completion');
  const resumed=await invoke('resume-session',{...sleeping,hubId:sleeping.id});assert(resumed && resumed.codexProfile==='second',JSON.stringify(resumed));
  await until(`sessions.get(${JSON.stringify(sleeping.id)}).nativeRuntime.connection==='connected'`,'sleep resumed');
  assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(sleeping.id)}).codexSid`),sleeping.codexSid);
  const restarted=await invoke('restart-session',idle.id);assert.equal(restarted.codexProfile,'second');assert.equal(restarted.codexSid,idle.codexSid);
  const fresh=await create('fresh B history');assert.equal(fresh.codexProfile,'second');
  result.checks.push('busy completion, dormant resume, restart and new session all use B; old native IDs retained');
  await stop();await start();
  await until(`sessions.has(${JSON.stringify(idle.id)})`,'persisted card');
  await cdp.eval(`selectSession(${JSON.stringify(idle.id)})`);
  await until(`sessions.get(${JSON.stringify(idle.id)}).nativeRuntime.connection==='connected'`,'full restart resume');
  const again=await cdp.eval(`JSON.parse(JSON.stringify(sessions.get(${JSON.stringify(idle.id)})))`);
  assert.equal(again.codexProfile,'second');assert.equal(again.codexSid,idle.codexSid);
  assert.equal(again.nativeRuntime.sqliteHome,a);
  const sent=await invoke('session:send-prompt',{sessionId:idle.id,text:'continue after account switch and restart',clientSubmissionId:idle.id+'-after-restart'});
  assert(sent.ok,JSON.stringify(sent));
  await until(`sessions.get(${JSON.stringify(idle.id)}).nativeRuntime.state==='completed'`,'continued original thread');
  result.checks.push('same original thread accepts one new prompt after account switch and full restart; SQLite home remains A');
  await stop();
  const threadFile=path.join(root,'threads',idle.codexSid+'.json'),parked=threadFile+'.unavailable';
  fs.renameSync(threadFile,parked);
  const timestamp=new Date().toISOString();
  fs.appendFileSync(idle.transcriptPath,[
   {type:'event_msg',payload:{type:'task_started',turn_id:'saved-offline-turn'}},
   {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Show saved offline history'}]}},
   {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',
    content:[{type:'output_text',text:'Saved history remains visible while the account is disconnected.'}]}},
   {type:'event_msg',payload:{type:'task_complete',turn_id:'saved-offline-turn',
    last_agent_message:'Saved history remains visible while the account is disconnected.'}},
  ].map(record=>JSON.stringify({timestamp,...record})).join('\n')+'\n');
  try{
   await start();await until(`sessions.has(${JSON.stringify(idle.id)})`,'failed-resume card');
   await cdp.eval(`selectSession(${JSON.stringify(idle.id)})`);
   await until(`sessions.get(${JSON.stringify(idle.id)}).nativeRuntime.connection==='disconnected'`,'resume failure');
   await cdp.eval(`applyViewMode('card')`);
   await until(`document.querySelector('#msg-overlay')?.innerText.includes('Saved history remains visible')`,'saved history fallback');
   assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(idle.id)}).codexSid`),idle.codexSid);
   const historyShot=await cdp.send('Page.captureScreenshot',{format:'png'});
   fs.writeFileSync(path.join(out,'20260924-disconnected-history-codex1.png'),Buffer.from(historyShot.data,'base64'));
   result.checks.push('failed native resume keeps original identity and displays saved history in real card UI');
  }finally{fs.renameSync(parked,threadFile);}
  await stop();await start();await until(`sessions.has(${JSON.stringify(idle.id)})`,'retry card');
  await cdp.eval(`selectSession(${JSON.stringify(idle.id)})`);
  await until(`sessions.get(${JSON.stringify(idle.id)}).nativeRuntime.connection==='connected'`,'restart after failure');
  assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(idle.id)}).codexSid`),idle.codexSid);
  result.checks.push('one Hub restart recovers failed resume without replacing the original thread');
  const trace=fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const oldResumes=trace.filter(r=>r.method==='thread/resume' && r.params.threadId===idle.codexSid);
  assert(oldResumes.length>=2);assert(oldResumes.every(r=>r.fixtureHome===b && r.params.path===idle.transcriptPath));
  assert.equal(trace.filter(r=>r.method==='turn/start' && r.params.clientUserMessageId===idle.id+'-once').length,1);
  assert.equal(trace.filter(r=>r.method==='turn/start' && r.params.clientUserMessageId===idle.id+'-after-restart').length,1);
  result.checks.push('full Hub restart retains B, original history path and ID; earlier prompt is never resent');
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;
  if(cdp)try{result.ui=await cdp.eval(`({view:currentView,active:activeSessionId,history:document.querySelector('#msg-overlay')?.innerText?.slice(0,1500)})`);}catch{}
 }
 finally{await stop();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})();
