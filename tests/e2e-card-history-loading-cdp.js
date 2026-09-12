'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('../tests/helpers/hub-launcher');
const {connectFirstPage}=require('../tests/helpers/cdp-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-card-loading-probe-'));
const art=path.resolve('output/playwright/card-loading-'+Date.now());fs.mkdirSync(art,{recursive:true});
const store=path.join(root,'store.json'),work=path.join(root,'work');fs.mkdirSync(work);
fs.mkdirSync(path.join(work,'.git'));fs.mkdirSync(path.join(work,'.agents'));
fs.writeFileSync(path.join(work,'.agents/project.json'),JSON.stringify({name:'卡片加载验证',trunk:'master'}));
new (require('../core/prepared-project-registry').PreparedProjectRegistry)({dataDir:path.join(root,'data')}).register(work);
const ids=[randomUUID(),randomUUID()];
const threads=ids.map((id,n)=>[id,{id,cwd:work,path:null,status:{type:'idle'},model:'gpt-6-astra',reasoningEffort:'max',turns:Array.from({length:25},(_,i)=>({id:'turn-'+i,status:'completed',startedAt:1700000000+i,items:[{id:'u-'+i,type:'userMessage',content:[{type:'text',text:`会话 ${n+1} 的第 ${i+1} 个问题`}]},{id:'a-'+i,type:'agentMessage',phase:'final_answer',text:('## 验证内容\n\n**已确认**：保留 Markdown 与历史内容。\n\n- 第一项\n- 第二项\n\n```js\nconst ready = true;\n```\n\n').repeat(i===0?15:5)}]}))}]);
fs.writeFileSync(store,JSON.stringify(threads));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let hub,cdp;try{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve(__dirname,'../tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:store}});
 cdp=await connectFirstPage(hub);await cdp.send('Page.bringToFront');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1450,height:950,deviceScaleFactor:1,mobile:false});
 await cdp.send('Performance.enable');
 const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(art,name+'.png'),Buffer.from(r.data,'base64'));};
 const wait=async expr=>{const end=Date.now()+30000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(80);}throw Error('timeout '+expr);};
 await wait('typeof sessions!=="undefined"');const sessions=[];
 for(const id of ids){const s=await cdp.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:${JSON.stringify({cwd:work,useResume:true,codexSid:id,model:'gpt-6-astra',effort:'max',mcpProfile:'none'})}})`);sessions.push(s.id);await wait(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.connection==='connected'`);}
 await wait(`cardHistoryViews.ready(sessions.get(${JSON.stringify(sessions[1])}))`);
 await cdp.eval(`window.__cardProbe=[];const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=async function(ch,...args){if(ch!=='parse-session-transcript')return invoke(ch,...args);const row={sid:args[0].hubSessionId,start:performance.now()};window.__cardProbe.push(row);try{const r=await invoke(ch,...args);row.ipcMs=performance.now()-row.start;row.turns=r.turns?.length;return r;}finally{requestAnimationFrame(()=>requestAnimationFrame(()=>row.paintedMs=performance.now()-row.start));}};window.__loadingSeen=0;new MutationObserver(records=>{for(const m of records)for(const n of m.addedNodes)if(n.nodeType===1 && n.matches('.msg-overlay-placeholder'))window.__loadingSeen++;}).observe(document.querySelector('#msg-overlay'),{childList:true});`);
 const results=[];
 for(const [label,sid] of [['switch-A',sessions[0]],['repeat-A',sessions[0]],['switch-B',sessions[1]],['return-A',sessions[0]],['repeat-A-again',sessions[0]]]){
  const before=await metric();
  if(label==='return-A') {await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  await cdp.eval('window.__cardProbe=[];window.__loadingSeen=0');
  const p=await cdp.eval(`(()=>{const e=document.querySelector('[data-session-id="${sid}"]');e.scrollIntoView();const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});
  await wait(`cardHistoryViews.ready(sessions.get(${JSON.stringify(sid)}))`);
  await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  if(label==='return-A') {const profile=await cdp.send('Profiler.stop');fs.writeFileSync(path.join(art,'return-profile.json'),JSON.stringify(profile));}
  const after=await metric();
  const result=await cdp.eval('({requests:window.__cardProbe,loadingInsertions:window.__loadingSeen,cards:document.querySelectorAll("#msg-overlay>.turn-card").length,nodes:document.querySelectorAll("#msg-overlay *").length,cache:cardHistoryViews.stats()})');
  result.rendererTaskMs=1000*(after.TaskDuration-before.TaskDuration);results.push({label,...result});console.log(label,JSON.stringify(result));
  assert.equal(result.cards,50,label);if(label!=='switch-A')assert.equal(result.loadingInsertions,0,label);
  if(label.startsWith('repeat'))assert.equal(result.requests.length,0,'repeat must not re-read history');
  if(label==='switch-A')await cdp.eval(`window.__savedCard=document.querySelector('#msg-overlay>.turn-card.assistant');window.__savedDetail=__savedCard.querySelector('.conversation-long-message');if(!__savedDetail)throw Error('long message fixture missing');__savedDetail.open=true;`);
  if(label==='return-A') {const state=await cdp.eval(`({same:window.__savedCard===document.querySelector('#msg-overlay>.turn-card.assistant'),open:__savedDetail?.open,connected:__savedCard.isConnected,cache:cardHistoryViews.stats()})`);console.log('restore',state);assert(state.same && state.open!==false,'return keeps DOM and disclosure');}
  await sleep(150);
 }
 await shot('warm');
 // Controlled IPC failure validates visible error handling without erasing cached content.
 await cdp.eval(`window.__originalInvoke=ipcRenderer.invoke;ipcRenderer.invoke=(ch,...args)=>ch==='parse-session-transcript'?Promise.reject(Error('fixture offline')):window.__originalInvoke(ch,...args);`);
 await cdp.eval(`window._loadSessionHistoryToOverlay(${JSON.stringify(sessions[0])})`);
 assert(await cdp.eval(`document.querySelectorAll('#msg-overlay>.turn-card').length===50 && document.querySelector('.card-history-status').textContent.includes('fixture offline')`));
 await shot('refresh-error');
 await cdp.eval('ipcRenderer.invoke=window.__originalInvoke');
 await cdp.eval(`window._loadSessionHistoryToOverlay(${JSON.stringify(sessions[0])})`);
 assert(await cdp.eval(`!document.querySelector('.card-history-status')`));
 // A background provider update must be adopted after restoring the cached view.
 await cdp.eval(`selectSession(${JSON.stringify(sessions[1])})`);
 const sent=await cdp.eval(`ipcRenderer.invoke('session:send-prompt',{sessionId:${JSON.stringify(sessions[0])},text:'cache delta question'})`);assert(sent.ok);
 await wait(`sessions.get(${JSON.stringify(sessions[0])})?.nativeRuntime?.state==='completed'`);
 await cdp.eval(`selectSession(${JSON.stringify(sessions[0])})`);
 await wait(`document.querySelector('#msg-overlay').textContent.includes('cache delta question')`);
 assert(await cdp.eval(`document.querySelector('#msg-overlay').textContent.includes('原生回答')`));
 // Force an explicit cache miss, then use the real navigation/hydration path.
 await cdp.eval(`cardHistoryViews.drop(${JSON.stringify(sessions[0])});window.__beats=0;window.__beatTimer=setInterval(()=>window.__beats++,10);`);
 const cold=await cdp.eval(`(async()=>{const start=performance.now();const p=window._loadSessionHistoryToOverlay(${JSON.stringify(sessions[0])});const skeleton=!!document.querySelector('.card-history-loading');await p;clearInterval(window.__beatTimer);return{skeleton,beats:window.__beats,totalMs:performance.now()-start,cards:document.querySelectorAll('#msg-overlay>.turn-card').length,first:document.querySelector('#msg-overlay>.turn-card')?.dataset.turnId,last:document.querySelector('#msg-overlay>.turn-card:last-of-type')?.dataset.turnId};})()`);
 assert(cold.skeleton);assert(cold.beats>2,'cold hydration yields the UI thread');assert.equal(cold.cards,50);assert(cold.first.endsWith(':u-1'));results.push({label:'cold',...cold});
 // Hold only the test IPC response to capture the genuine cold loading UI.
 await cdp.eval(`cardHistoryViews.drop(${JSON.stringify(sessions[0])});window.__delayInvoke=ipcRenderer.invoke;ipcRenderer.invoke=async(ch,...args)=>{if(ch==='parse-session-transcript')await new Promise(r=>window.__releaseHistory=r);return window.__delayInvoke(ch,...args);};window.__coldPending=window._loadSessionHistoryToOverlay(${JSON.stringify(sessions[0])});void 0;`);
 await shot('cold-skeleton');await cdp.send('Emulation.setDeviceMetricsOverride',{width:760,height:950,deviceScaleFactor:1,mobile:false});await shot('cold-760');
 await cdp.eval('ipcRenderer.invoke=window.__delayInvoke;window.__releaseHistory();window.__coldPending');
 const refresh=await cdp.eval(`(async()=>{cardHistoryViews.drop(${JSON.stringify(sessions[0])});const p=window._loadSessionHistoryToOverlay(${JSON.stringify(sessions[0])});await selectSession(${JSON.stringify(sessions[1])});await p;return{active:activeSessionId,owners:[...document.querySelectorAll('#msg-overlay>.turn-card')].map(c=>c.dataset.sessionId)};})()`);
 assert.equal(refresh.active,sessions[1]);assert(refresh.owners.every(id=>id===sessions[1]),'stale cold batches never append to another session');
 fs.writeFileSync(path.join(art,'probe.json'),JSON.stringify({fixture:'25 completed turns per session, Markdown content; real isolated Electron, no cloud model',results},null,2));
 await shot('settled');
 console.log(JSON.stringify(results));console.log('PASS cache reuse, repeat navigation, disclosure, errors, cold yielding and rapid switch isolation');console.log('ARTIFACT_ROOT '+art);
}finally{if(hub)fs.writeFileSync(path.join(art,'hub.log'),hub.log().join('\n'));if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);}})().catch(e=>{console.error(e);process.exitCode=1;});




