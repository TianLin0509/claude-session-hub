'use strict';
// Controlled workload in the real search engine and isolated Hub renderer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {SessionSearchEngine}=require('../core/session-search-engine');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
try{os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL)}catch{}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
async function sourceProbe(root) {
 const sessionsRoot=path.join(root,'codex','sessions'),dir=path.join(sessionsRoot,'2026','10','05');fs.mkdirSync(dir,{recursive:true});
 const files=new Set();
 for(let i=0;i<300;i++) {
  const file=path.join(dir,`rollout-roi-${i}.jsonl`);files.add(file);
  fs.writeFileSync(file,[{type:'session_meta',payload:{id:`roi-${i}`,cwd:root,source:'cli',base_instructions:{text:'x'.repeat(65536)}}},{type:'event_msg',payload:{type:'user_message',message:`ROI_USER_${i}`}},{type:'event_msg',payload:{type:'task_complete',last_agent_message:`ROI_ANSWER_${i}`}}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 }
 const engine=new SessionSearchEngine({databasePath:path.join(root,'search.sqlite'),codexRoots:[sessionsRoot],claudeRoots:[],kimiRoots:[],geminiRoots:[],meetingDir:path.join(root,'meetings')});
 const snapshot={sessions:[],meetings:[]};
 const oldOpen=fs.openSync,oldRead=fs.readSync,oldClose=fs.closeSync,fds=new Set();let opens=0,readBytes=0;
 try {
  await engine.refresh(snapshot,{force:true});
  assert.equal(engine.index.getStats().sessions,300);
  fs.openSync=function(file,...args){const fd=oldOpen.call(this,file,...args);if(typeof file==='string'&&files.has(path.resolve(file))){fds.add(fd);opens++}return fd};
  fs.readSync=function(fd,...args){const n=oldRead.call(this,fd,...args);if(fds.has(fd))readBytes+=n;return n};
  fs.closeSync=function(fd,...args){fds.delete(fd);return oldClose.call(this,fd,...args)};
  const start=performance.now();
  for(let i=0;i<5;i++)await engine.refresh(snapshot,{immediate:true});
  const stable={sources:300,refreshes:5,fileOpens:opens,fileBytesRead:readBytes,elapsedMs:performance.now()-start};
  fs.appendFileSync([...files][0],JSON.stringify({type:'event_msg',payload:{type:'task_complete',last_agent_message:'ROI_NEW_CONTENT_MARKER'}})+'\n');
  await engine.refresh(snapshot,{immediate:true});
  assert.equal((await engine.search({query:'ROI_NEW_CONTENT_MARKER'})).totalSessions,1,'changed content remains searchable');
  if(process.argv.includes('--verify'))assert.equal(stable.fileOpens,0,'unchanged identity headers must be reused');
  return {...stable,changedContentSearchable:true};
 } finally {fs.openSync=oldOpen;fs.readSync=oldRead;fs.closeSync=oldClose;await engine.close()}
}
async function rendererProbe(root) {
 let hub,c;
 try {
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),label:'roi-performance'});c=await connectFirstPage(hub);
  const end=Date.now()+30000;
  while(!(await c.eval('typeof sessions!=="undefined"&&typeof renderSessionList==="function"'))){if(Date.now()>end)throw Error('Hub readiness timeout');await wait(100)}
  return await c.eval(`(()=>{
   let statusReads=0;const now=Date.now(),count=1500;
   for(let i=0;i<count;i++){let state=i<20?'idle':'dormant';const s={id:'roi-'+i,kind:'codex',title:'ROI session '+i,createdAt:now-i*1000,lastMessageTime:i<20?now:now-4*86400000,codexSid:'native-roi-'+i,agentRuntime:'pty'};Object.defineProperty(s,'status',{enumerable:true,get(){statusReads++;return state},set(v){state=v}});sessions.set(s.id,s)}
   renderSessionList();statusReads=0;
   const start=performance.now();for(let i=0;i<30;i++)renderSessionList();
   const stable={sessions:count,refreshes:30,statusReads,elapsedMs:performance.now()-start};
   const before=[...document.querySelectorAll('#session-list .session-item')].map(e=>e.dataset.sessionId||e.dataset.meetingId);
   const s=sessions.get('roi-0');s.status='running';s.runtimeTruth={state:'running',source:'codex-hook',confidence:'authoritative',observedAt:Date.now()};renderSessionList();
   const runningRow=document.querySelector('#session-list .session-item[data-session-id="roi-0"]');
   const runningVisible=!!runningRow&&runningRow.classList.contains('running');
   s.status='idle';s.runtimeTruth={state:'idle',source:'codex-hook',confidence:'authoritative',observedAt:Date.now()};s.unreadCount=1;s.attentionState='reply-ready';renderSessionList();
   const unreadVisible=!!document.querySelector('#session-list .session-item[data-session-id="roi-0"].need-unread');
   return {...stable,displayedOrder:before,runningVisible,unreadVisible};
  })()`);
 }finally{await c?.close();if(hub)await gracefulQuit(hub)}
}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-roi-'));const result={source:await sourceProbe(root),scope:'real search engine; synthetic files; optional isolated renderer; no real model calls'};
 if(!process.argv.includes('--source-only')){result.renderer=await rendererProbe(root);assert.equal(result.renderer.runningVisible,true);assert.equal(result.renderer.unreadVisible,true)}
 const target=path.resolve(process.argv[2]||'artifacts/20261005-hub-roi-performance-codex1.json');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1});
