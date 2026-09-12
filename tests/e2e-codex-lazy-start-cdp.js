'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {randomUUID}=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-lazy-gui-'));
const data=path.join(root,'data'),cwd=path.join(root,'work'),home=path.join(root,'codex');
const out=path.resolve('output/lazy-start/gui');
for(const dir of [data,cwd,home,out])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(cwd,'.aiwork-root'),'');
fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="high"\n');
const trace=path.join(root,'trace.jsonl');
const calls=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
const quote=JSON.stringify;
let hub,client;
const result={passed:false,root,checks:[],exits:[]};
async function until(expr,label){for(let i=0;i<300;i++){if(await client.eval(expr))return;await sleep(100)}throw Error('Timeout: '+label);}
async function click(selector){await client.send('Page.bringToFront');const r=await client.eval(`(()=>{const e=document.querySelector(${quote(selector)});if(!e)throw Error('missing element');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await client.send('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1});}
async function shot(name){await client.send('Page.bringToFront');const s=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));}
async function start(){hub=await launchIsolatedHub({dataDir:data,port:await port(),windowMode:'hidden',label:'codex-lazy-start',extraEnv:{
  CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),AI_HUB_WORKSPACE_ROOT:cwd,
  CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
  CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace,
  CLAUDE_HUB_NATIVE_FIXTURE_VOLATILE_EMPTY:'1'}});
  client=await connectFirstPage(hub);await client.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1050,deviceScaleFactor:1,mobile:false});
  await until('typeof sessions!=="undefined" && !!window.MeetingRoom','renderer');}
async function stop(){if(client){await client.close();client=null}if(hub){fs.appendFileSync(path.join(out,'hub.log'),hub.log().join('\n')+'\n');result.exits.push(await gracefulQuit(hub));hub=null;}}
const spec={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none',codexSpeedTier:'standard'};
async function createRoom(title,slots){return client.eval(`ipcRenderer.invoke('create-meeting',${quote({title,mode:'dev',scene:'dev',workspace:cwd,slots})})`);}
function handoff(dir,draft,done){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,draft),'隔离后端阶段文件 fixture，非真实代码交付','utf8');fs.renameSync(path.join(dir,draft),path.join(dir,done));}
async function run(){try{
  await start();const room=await createRoom('延迟创建验收',[spec,spec]);result.meeting=room.id;
  const [author,merger]=room.subSessions;result.members=room.subSessions;
  await client.eval(`selectMeeting(${quote(room.id)})`);await sleep(500);
  for(const sid of room.subSessions){
    await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${quote(sid)}})`);
    assert.equal(await client.eval(`sessions.get(${quote(sid)}).nativeRuntime.connection`),'unstarted');
  }
  assert.equal(calls().filter(x=>x.method==='thread/start').length,0);
  await shot('two-unused-seats');result.checks.push('real create IPC, both visible seats and transcript reads create no native threads');
  const workflow=await client.eval(`window.WorkflowTemplates.createTemplateConfig('dev-task',${quote([{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'codex'}])})`);
  await client.eval(`ipcRenderer.invoke('update-meeting-sync',${quote({meetingId:room.id,fields:{serialWorkflow:workflow}})})`);
  await until('!!document.querySelector("[data-file-kickoff]")','kickoff');await click('[data-file-kickoff]');await click('#mr-send-btn');
  const state=`ipcRenderer.invoke('groupchat:get-state',{meetingId:${quote(room.id)}})`;
  await until(`(async()=>Object.values((await ${state}).attempts||{}).some(a=>a.sid===${quote(author)} && a.status==='completed'))()`,'author kickoff');
  assert.equal(calls().filter(x=>x.method==='thread/start').length,1);
  assert.equal(await client.eval(`sessions.get(${quote(merger)}).nativeRuntime.connection`),'unstarted');
  const docs=path.join(data,'task-docs',room.id);handoff(docs,'开题报告.md','已完成-开题报告.md');
  await until(`(async()=>Object.values((await ${state}).attempts||{}).filter(a=>a.status==='completed').length>=2)()`,'author implementation');
  const authorThread=await client.eval(`sessions.get(${quote(author)}).codexSid`);
  await shot('author-only');await stop();await start();
  await until(`sessions.has(${quote(merger)})`,'persisted members');await client.eval(`selectMeeting(${quote(room.id)})`);
  await until(`sessions.get(${quote(merger)}).nativeRuntime.connection==='unstarted'`,'unused merger after restart');
  assert.equal(calls().filter(x=>x.method==='thread/start').length,1);
  handoff(docs,'实现手册-轮次1.md','已完成-实现手册-轮次1.md');
  await until(`(async()=>Object.values((await ${state}).attempts||{}).some(a=>a.sid===${quote(merger)} && a.status==='completed'))()`,'first merger dispatch after restart');
  assert.equal(calls().filter(x=>x.method==='thread/start').length,2);
  assert.equal(await client.eval(`sessions.get(${quote(author)}).codexSid`),authorThread);
  const mergeThread=await client.eval(`sessions.get(${quote(merger)}).codexSid`);
  assert.equal(calls().filter(x=>x.method==='turn/start' && x.params.threadId===mergeThread).length,1);
  await shot('merger-first-task-after-restart');result.checks.push('real kickoff and atomic file handoff start only the target; unused merger survives Hub restart and starts once');
  const legacy=await createRoom('旧空会话恢复验收',[spec]);const sid=legacy.subSessions[0];
  for(let i=0;i<100 && !fs.existsSync(path.join(data,'sessions',sid+'.json'));i++)await sleep(100);
  await stop();
  const file=path.join(data,'sessions',sid+'.json'),meta=JSON.parse(fs.readFileSync(file,'utf8'));
  const missing=randomUUID();meta.codexSid=missing;meta.transcriptPath=path.join(home,'sessions','missing.jsonl');
  meta.nativeRuntime={...meta.nativeRuntime,threadId:missing,connection:'disconnected',state:'unknown',lazyStart:false};
  fs.writeFileSync(file,JSON.stringify(meta));
  // Boot restores two backups; seed both with the same legacy fixture.
  const stateFile=path.join(data,'state.json'),persisted=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  Object.assign(persisted.sessions.find(s=>s.hubId===sid),meta);
  fs.writeFileSync(stateFile,JSON.stringify(persisted));
  await start();await until(`sessions.has(${quote(sid)})`,'legacy saved seat');await client.eval(`selectSession(${quote(sid)})`);
  await until(`!!sessions.get(${quote(sid)}).nativeRuntime.emptyRecovery`,'legacy explicit recovery');
  await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='为原席位建立新线程')`,'recovery control');
  const before=calls().filter(x=>x.method==='thread/start').length;
  assert.equal(await client.eval(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='为原席位建立新线程').disabled`),true);
  await shot('legacy-confirmation');
  assert((await client.eval('document.querySelector(".codex-native-confirm input").getBoundingClientRect().width'))<30);
  await click('.codex-native-confirm input');await click('.codex-native-confirm + button');
  await until(`sessions.get(${quote(sid)}).nativeRuntime.connection==='connected'`,'confirmed fresh thread');
  assert.equal(calls().filter(x=>x.method==='thread/start').length,before+1);
  const fresh=await client.eval(`sessions.get(${quote(sid)}).codexSid`);assert.notEqual(fresh,missing);
  assert.equal(calls().filter(x=>x.method==='turn/start' && x.params.threadId===fresh).length,0);
  result.checks.push('legacy missing proof requires visible confirmation, preserves Hub seat and does not resend');
  await shot('legacy-recovered');result.passed=true;
}finally{if(client&&!result.passed){try{result.failureState=await client.eval('({text:document.body.innerText.slice(-6000),sessions:[...sessions.values()]})');await shot('failure')}catch(e){result.captureError=e.message}}
await stop();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks}));}}
run().catch(e=>{console.error(e.stack);process.exitCode=1});
