'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {connectBroker,readMetadata}=require('../main/codex-runtime-broker-client');
const ROOT=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-backstage-'));
const dataDir=path.join(temp,'data'),home=path.join(temp,'codex'),workspace=path.join(temp,'workspace');
const out=path.join(ROOT,'artifacts/codex-backstage',String(Date.now()));
for(const dir of [dataDir,home,workspace,out])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
const exported=path.join(temp,'original-export.txt');
const entry=path.join(temp,'entry.cjs');
fs.writeFileSync(entry,`const e=require('electron');e.app.setAppPath(${JSON.stringify(ROOT)});process.chdir(${JSON.stringify(ROOT)});e.app.on('web-contents-created',(_e,w)=>w.setBackgroundThrottling(false));e.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(exported)}});e.shell.showItemInFolder=()=>{};require(${JSON.stringify(path.join(ROOT,'main-bootstrap.js'))});`);
const extraEnv={CODEX_HOME:home,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js'),CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1',AI_HUB_CODEX_BROKER_TEST:'1',CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(temp,'fixture.json'),CLAUDE_HUB_NATIVE_FIXTURE_HISTORY_CHARS:'6000',BACKSTAGE_TEST_API_KEY:'test-private-key-123456789'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});}
async function until(client,expression,label,timeout=25000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{last=await client.eval(expression);if(last)return last;}catch(error){last=error.message;}await sleep(100);}throw Error('timeout '+label+': '+JSON.stringify(last));}
async function click(client,selector){const point=await until(client,`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return false;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();if(!r.width||!r.height)return false;const x=r.x+r.width/2,y=r.y+r.height/2;const top=document.elementFromPoint(x,y);if(top!==el&&!el.contains(top))return false;return{x,y}})()`,'clickable '+selector,8000);await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});}
async function shot(client,name){const image=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(image.data,'base64'));}
const result={passed:false,checks:[],temp,out};const hubs=[],clients=[];
async function launch(label){const hub=await launchIsolatedHub({entryPath:entry,dataDir,port:await port(),label,extraEnv,windowMode:'hidden'});hubs.push(hub);const client=await connectFirstPage(hub);clients.push(client);await client.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1060,deviceScaleFactor:1,mobile:false});await until(client,'typeof sessions!=="undefined" && typeof terminalCache!=="undefined"','renderer');await client.eval('window.__backstageErrors=[];addEventListener("error",e=>__backstageErrors.push(e.message));addEventListener("unhandledrejection",e=>__backstageErrors.push(String(e.reason)))');return client;}
const checked=text=>{result.checks.push(text);console.log('PASS '+text);};
(async()=>{
try{
  const a=await launch('backstage-a');
  const created=await a.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd:workspace,model:'gpt-6-astra',effort:'high',mcpProfile:'none',title:'Codex 后台 · 现场信息'}})+')');
  const sid=JSON.stringify(created.id);result.sessionId=created.id;
  await until(a,`sessions.get(${sid})?.nativeRuntime?.connection==='connected'`,'native ready');
  await a.eval(`selectSession(${sid})`);if(await a.eval('currentView')!=='pty')await click(a,'#btn-backstage');
  await until(a,"document.querySelector('.codex-backstage') && !document.querySelector('.codex-backstage').hidden && document.querySelectorAll('.cb-entry').length>0",'backstage mounted');
  await click(a,'.floating-input-box');await a.send('Input.insertText',{text:'检查视频分段并保留完整错误。 fixture:backstage'});await click(a,'.floating-input-send');
  await until(a,"document.querySelector('.cb-list').textContent.includes('SEGMENT_PASS')",'stream original output');
  result.ipcMs=[];for(let i=0;i<6;i++)result.ipcMs.push(await a.eval("(async()=>{const t=performance.now();await ipcRenderer.invoke('get-sessions');return performance.now()-t;})()"));assert(Math.max(...result.ipcMs)<500,'Hub responds during streaming');
  await a.eval("window.__stableBackstageNode=document.querySelector('.cb-entry[data-type=commandExecution]')");
  await a.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:900,y:400,deltaX:0,deltaY:-2500});
  await until(a,"document.querySelector('.cb-follow-state').textContent==='阅读历史'",'scroll detaches');
  const top=await a.eval("document.querySelector('.cb-viewport').scrollTop");
  await until(a,"document.querySelector('.cb-follow').textContent.includes('次新输出')",'unread live output');
  assert(Math.abs(await a.eval("document.querySelector('.cb-viewport').scrollTop")-top)<3,'reading anchor stays stable');
  assert(await a.eval("window.__stableBackstageNode.isConnected && document.querySelector('.cb-entry[data-type=commandExecution]')===window.__stableBackstageNode"));checked('incremental rows preserve DOM identity and real-wheel reading position');
  await click(a,'.cb-follow');
  await until(a,`sessions.get(${sid}).nativeRuntime.state==='completed'`,'native completion');
  await until(a,"document.querySelector('.cb-list').textContent.includes('FIRST_HAND_STACK')",'exact command error and stack');
  assert(await a.eval("document.querySelector('.cb-list').textContent.includes('exit 7') && document.querySelector('.cb-list').textContent.includes('BACKSTAGE_STDERR')"));
  assert(!(await a.eval("document.querySelector('.cb-list').textContent")).includes(extraEnv.BACKSTAGE_TEST_API_KEY));
  assert(await a.eval("document.querySelector('.cb-list .cb-markdown strong')?.textContent==='检查完成。'"));
  assert.equal(await a.eval("terminalCache.get(activeSessionId)._gpuLoaded"),false,'readable transcript releases hidden xterm canvas');
  const errorVisible=await a.eval("(()=>{const e=document.querySelector('.cb-inline-error:not([hidden])');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return e.closest('details').open&&r.height>30&&e.textContent.includes('FIRST_HAND_STACK')})()");assert(errorVisible,'original stack is outside clipped command log and visible without expansion');
  assert(await a.eval("!document.querySelector('.cb-output b') && document.querySelector('.cb-list').textContent.includes('<b>not html</b>')"));checked('real native errors, stderr, exit code, Unicode and untrusted text remain visible');
  await shot(a,'completed');
  await click(a,'.cb-follow');
  const idleBefore=await a.eval('terminalCache.get(activeSessionId)._codexBackstage.stats()');await sleep(650);const idleAfter=await a.eval('terminalCache.get(activeSessionId)._codexBackstage.stats()');assert.equal(idleAfter.readCount,idleBefore.readCount);checked('idle backend causes no repeated record reads');
  await click(a,'.cb-entry[data-type=mcpToolCall] summary');await click(a,'.cb-entry[data-type=mcpToolCall] .cb-full');
  await until(a,"document.querySelector('.cb-detail-content').textContent.includes('ORIGINAL_HEAD')",'full detail first page');
  await shot(a,'original-detail');
  await click(a,'.cb-detail-dialog footer button:last-child');await until(a,"!document.querySelector('.cb-detail-content').textContent.includes('ORIGINAL_HEAD')",'next detail page');
  await click(a,'.cb-detail-dialog header button');checked('large original tool result opens and pages without replacing main transcript');
  await click(a,'.cb-tabs button:nth-child(2)');await until(a,"document.querySelector('.cb-raw-list').textContent.includes('ORIGINAL_TAIL')",'raw latest page');
  await click(a,'.cb-export');await until(a,`require('fs').existsSync(${JSON.stringify(exported)})`,'export original');
  const exportText=fs.readFileSync(exported,'utf8');for(const text of ['FIRST_HAND_STACK','ORIGINAL_HEAD','ORIGINAL_TAIL','BACKSTAGE_STDERR','[redacted]','"exitCode": 7'])assert(exportText.includes(text),text);assert(!exportText.includes(extraEnv.BACKSTAGE_TEST_API_KEY));checked('export retains complete large output, original diagnostics and explicit exit code');
  for(let i=0;i<4;i++){const old=await a.eval("document.querySelector('.cb-raw-chunk').dataset.seq");await click(a,'.cb-older');await until(a,`document.querySelector('.cb-raw-chunk').dataset.seq!==${JSON.stringify(old)}`,'older raw page');}
  await a.eval("window.__oldRawNode=document.querySelector('.cb-raw-chunk')");
  await a.eval(`ipcRenderer.invoke('session:send-prompt',{sessionId:${sid},text:'fixture:broker-burst',clientSubmissionId:'raw-history-burst'})`);
  await until(a,`sessions.get(${sid}).nativeRuntime.state==='completed'`,'raw burst complete');
  assert(await a.eval("__oldRawNode.isConnected && document.querySelectorAll('.cb-raw-chunk').length<=60"),'raw history remains attached within DOM cap');
  await click(a,'.cb-follow');await until(a,"document.querySelector('.cb-raw-list').textContent.includes('FINAL_ONLY_完整结束')",'raw return latest after capped history');
  checked('paged raw history stays bounded and returns to the complete latest tail');
  await click(a,'.cb-tabs button:first-child');await until(a,"document.querySelector('.cb-list').textContent.includes('FIRST_HAND_STACK')",'readable again');
  for(let i=0;i<3;i++){await click(a,'.cb-tabs button:nth-child(2)');await click(a,'.cb-tabs button:first-child');}
  await until(a,"document.querySelector('.cb-list').textContent.includes('FIRST_HAND_STACK') && document.querySelector('.cb-raw-list').hidden",'rapid mode changes retain latest readable view');
  await click(a,'.floating-input-box');await a.send('Input.insertText',{text:'fixture:approval'});await click(a,'.floating-input-send');
  await until(a,"document.querySelector('.codex-native-controls form')?.textContent.includes('允许本次')",'approval remains actionable');
  await click(a,'.codex-native-controls form button');await until(a,`sessions.get(${sid}).nativeRuntime.state==='completed'`,'approval completed');
  await click(a,'.floating-input-box');await a.send('Input.insertText',{text:'fixture:stop-delayed'});await click(a,'.floating-input-send');await until(a,`sessions.get(${sid}).nativeRuntime.state==='running'`,'stop fixture active');
  await click(a,'.floating-input-stop');await until(a,`sessions.get(${sid}).nativeRuntime.state==='interrupted'`,'native interrupted');
  checked('rapid view changes, real approval click and native Stop remain functional');
  await click(a,'.floating-input-box');await a.send('Input.insertText',{text:'草稿保留，不要发送。'});
  await click(a,'#btn-backstage');await until(a,"document.querySelector('.codex-backstage').hidden",'cards hide backstage');const suspendedBefore=await a.eval('terminalCache.get(activeSessionId)._codexBackstage.stats().readCount');
  await a.eval(`ipcRenderer.invoke('session:send-prompt',{sessionId:${sid},text:'fixture:broker-burst',clientSubmissionId:'backstage-hidden-burst'})`);
  await until(a,`sessions.get(${sid}).nativeRuntime.state==='completed'`,'hidden burst complete');await sleep(160);assert.equal(await a.eval('terminalCache.get(activeSessionId)._codexBackstage.stats().readCount'),suspendedBefore);
  await click(a,'#btn-backstage');await until(a,"document.querySelector('.cb-list').textContent.includes('FINAL_ONLY_完整结束')",'catch up without resend');assert.equal(await a.eval("document.querySelector('.floating-input-box').textContent"),'草稿保留，不要发送。');checked('card mode suspends reads; returning catches up and preserves composer draft');
  await click(a,'.cb-tabs button:last-child');
  const other=await a.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'powershell',opts:{cwd:workspace}})+')');
  await until(a,`activeSessionId===${JSON.stringify(other.id)}`,'other provider selected');
  assert(await a.eval("!document.querySelector('.codex-backstage') && !terminalCache.get(activeSessionId)._backstageReadable"),'other provider keeps its terminal');
  await click(a,`.session-item[data-session-id="${created.id}"]`);
  await until(a,`activeSessionId===${sid} && document.querySelector('.codex-backstage-legacy')`,'legacy mode survives real session switching');
  if(await a.eval('currentView')!=='pty')await click(a,'#btn-backstage');
  assert.equal(await a.eval("getComputedStyle(terminalCache.get(activeSessionId).container).visibility"),'visible');
  await click(a,'.cb-tabs button:first-child');await until(a,"document.querySelector('.cb-list').textContent.includes('FIRST_HAND_STACK')",'readable restored');
  assert.equal(await a.eval("terminalCache.get(activeSessionId)._gpuLoaded"),false);
  checked('switching sessions preserves legacy visibility and other providers keep their own UI');
  await a.eval("document.querySelector('.cb-appearance').value='classic';document.querySelector('.cb-appearance').dispatchEvent(new Event('change'))");await shot(a,'classic');
  await a.eval("document.querySelector('.cb-font-size').value='18';document.querySelector('.cb-font-size').dispatchEvent(new Event('change'))");assert.equal(await a.eval("getComputedStyle(document.querySelector('.cb-prose .cb-output')).fontSize"),'18px');
  await a.eval("document.querySelector('.cb-appearance').value='refined';document.querySelector('.cb-appearance').dispatchEvent(new Event('change'));document.querySelector('.cb-font-size').value='14';document.querySelector('.cb-font-size').dispatchEvent(new Event('change'))");
  await a.send('Emulation.setDeviceMetricsOverride',{width:800,height:1050,deviceScaleFactor:1,mobile:false});await shot(a,'narrow');assert(await a.eval("document.querySelector('.codex-backstage').getBoundingClientRect().right<=innerWidth+1"));checked('classic/refined style, font size and narrow layout work in actual Hub');
  // Wait on actual state persistence before the independent viewer attaches.
  await until(a,`(()=>{try{return JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dataDir,'state.json'))},'utf8')).sessions.some(s=>s.hubId===${sid}||s.id===${sid})}catch{return false}})()`,'state persistence');
  const b=await launch('backstage-b');await until(b,`sessions.has(${sid})`,'viewer restored session');await b.eval(`selectSession(${sid})`);if(await b.eval('currentView')!=='pty')await click(b,'#btn-backstage');
  await until(b,"document.querySelector('.cb-list')?.textContent.includes('FIRST_HAND_STACK')",'viewer original history');
  assert.equal(await b.eval(`sessions.get(${sid}).codexSharedControl.serverPid`),await a.eval(`sessions.get(${sid}).codexSharedControl.serverPid`));checked('second isolated Hub reads the same first-hand record from one native writer');
  await shot(b,'shared-viewer');
  for(const client of clients)assert.deepEqual(await client.eval('__backstageErrors'),[]);
  result.stats=await a.eval('terminalCache.get(activeSessionId)._codexBackstage.stats()');result.exportBytes=fs.statSync(exported).size;result.passed=true;
}finally{
  for(let i=0;i<clients.length;i++){try{await shot(clients[i],'final-'+i);}catch(error){result.screenshotError=error.message;}await clients[i].close();}
  for(const hub of hubs.reverse())await gracefulQuit(hub);
  try{const metadata=readMetadata(dataDir);if(metadata){const broker=await connectBroker({dataDir});try{await broker.request('shutdown-test',{});}finally{broker.close();}}}catch(error){result.brokerShutdown=error.message;}
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result));
}
})().catch(error=>{console.error(error.stack);if(error.logTail)console.error(error.logTail);process.exitCode=1;});
