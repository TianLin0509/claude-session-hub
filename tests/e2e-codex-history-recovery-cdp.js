'use strict';
// Real isolated Electron UI + real broker/native fixture; only the broker's
// advertised capabilities emulate the pre-backstage service still in use.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {CodexRuntimeBroker}=require('../core/codex-runtime-broker');
const {Peer,writeMetadata,removeOwnMetadata}=require('../main/codex-runtime-broker-process');
const {pipeName,PROTOCOL_VERSION}=require('../main/codex-runtime-broker-client');
const ROOT=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-history-recovery-'));
const dataDir=path.join(temp,'data'),home=path.join(temp,'codex'),workspace=path.join(temp,'workspace');
const out=path.join(ROOT,'artifacts/history-recovery',String(Date.now()));
for(const dir of [dataDir,home,workspace,out])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dataDir,'prepared-projects.json'),JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
const threadId=randomUUID(),fixtureStore=path.join(temp,'fixture.json'),exported=path.join(temp,'original.txt');
const items=[...Array.from({length:1000},(_,i)=>({id:'message-'+i,type:'agentMessage',phase:'commentary',text:'较早进展 '+i})),
  ...Array.from({length:80},(_,i)=>({id:'tool-'+i,type:'commandExecution',command:'verify '+i,aggregatedOutput:'SAVED_ORIGINAL_'+i,status:'completed',exitCode:0})),
  {id:'final',type:'agentMessage',phase:'final_answer',text:'推送完成：SAVED_FINAL_COMPLETE'}];
fs.writeFileSync(fixtureStore,JSON.stringify([[threadId,{id:threadId,cwd:workspace,model:'gpt-6-astra',reasoningEffort:'high',approvalPolicy:'never',sandbox:'danger-full-access',status:{type:'idle'},turns:[{id:'history',status:'completed',items}]}]]));
const entry=path.join(temp,'entry.cjs');
fs.writeFileSync(entry,`const e=require('electron');e.app.setAppPath(${JSON.stringify(ROOT)});process.chdir(${JSON.stringify(ROOT)});e.app.on('web-contents-created',(_e,w)=>w.setBackgroundThrottling(false));e.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(exported)}});e.shell.showItemInFolder=()=>{};require(${JSON.stringify(path.join(ROOT,'main-bootstrap.js'))});`);
const extraEnv={CODEX_HOME:home,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js'),CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1',CLAUDE_HUB_NATIVE_FIXTURE_STORE:fixtureStore};
const result={passed:false,checks:[],temp,out},hubs=[],clients=[],peers=new Set();
const serviceId=randomUUID(),token=randomUUID(),broker=new CodexRuntimeBroker({serviceId,idleRetentionMs:60000});
let reconnectDelay=0;
const server=net.createServer(socket=>{
  const peer=new Peer(socket,broker,token,serviceId);peers.add(peer);peer.once('closed',()=>peers.delete(peer));
  const send=peer.send.bind(peer);peer.send=message=>{
    if(message.result?.protocolVersion)message={...message,result:{...message.result,features:[],runtimeBuild:null,upgrade:null}};
    send(message);
  };
  const handle=peer.handle.bind(peer);peer.handle=async message=>{if(message.method==='hello'&&reconnectDelay)await new Promise(r=>setTimeout(r,reconnectDelay));return handle(message);};
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function until(client,expression,label,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await client.eval(expression);if(last)return last;await sleep(60);}throw Error('timeout '+label+': '+JSON.stringify(last));}
async function click(client,selector){const p=await until(client,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;const x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:false})()`,'click '+selector);await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});}
async function shot(client,name){const data=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(data.data,'base64'));}
async function launch(label){const h=await launchIsolatedHub({entryPath:entry,dataDir,port:await port(),label,extraEnv,windowMode:'hidden'});hubs.push(h);const c=await connectFirstPage(h);clients.push(c);await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1060,deviceScaleFactor:1,mobile:false});await until(c,'typeof sessions!=="undefined" && typeof terminalCache!=="undefined"','renderer');await c.eval('window.__recoveryErrors=[];addEventListener("error",e=>__recoveryErrors.push(e.message));addEventListener("unhandledrejection",e=>__recoveryErrors.push(String(e.reason)))');return c;}
function checked(text){result.checks.push(text);console.log('PASS '+text);}
(async()=>{try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipeName(dataDir),resolve);});
  writeMetadata(dataDir,{protocolVersion:PROTOCOL_VERSION,serviceId,token,pipe:pipeName(dataDir),pid:process.pid,startedAt:Date.now(),root:ROOT});
  const a=await launch('legacy-history-a');
  const created=await a.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd:workspace,useResume:true,codexSid:threadId,model:'gpt-6-astra',effort:'high',mcpProfile:'none',title:'恢复旧后台记录'}})+')');
  const sid=JSON.stringify(created.id);result.sessionId=created.id;
  await until(a,`sessions.get(${sid})?.nativeRuntime?.connection==='connected'`,'native resume');await a.eval(`selectSession(${sid})`);
  if(await a.eval('currentView')!=='card')await click(a,'#btn-backstage');
  await until(a,"document.querySelector('#message-list')?.textContent.includes('SAVED_FINAL_COMPLETE') || [...document.querySelectorAll('.turn-card')].some(e=>e.textContent.includes('SAVED_FINAL_COMPLETE'))",'initial final card');
  result.initialCards=await a.eval("document.querySelectorAll('.turn-card').length");assert(result.initialCards<=9,'first paint must not mount all 1000 messages');checked('first card view includes the saved final with at most nine cards');
  await click(a,'#btn-backstage');await until(a,"document.querySelector('.cb-list')?.textContent.includes('SAVED_FINAL_COMPLETE')",'legacy readable');
  assert(await a.eval("document.querySelector('.cb-compat').textContent==='历史兼容视图' && !document.querySelector('.cb-compat').hidden"));
  assert(!(await a.eval("document.querySelector('.codex-backstage').textContent")).includes('后台待升级'));await shot(a,'legacy-readable');checked('legacy service opens real work records without the upgrade blocker');
  await click(a,'.cb-tabs button:nth-child(2)');await until(a,"document.querySelector('.cb-raw-list').textContent.includes('SAVED_FINAL_COMPLETE')",'legacy raw');
  await click(a,'.cb-export');await until(a,`require('fs').existsSync(${JSON.stringify(exported)})`,'complete legacy export');
  const raw=fs.readFileSync(exported,'utf8');for(const text of ['较早进展 0','较早进展 999','SAVED_ORIGINAL_0','SAVED_ORIGINAL_79','SAVED_FINAL_COMPLETE'])assert(raw.includes(text),text);
  result.exportBytes=fs.statSync(exported).size;await shot(a,'legacy-raw');checked('raw tab and export include all 1081 saved source items');
  await click(a,'.cb-tabs button:first-child');await until(a,"document.querySelector('.cb-list').textContent.includes('SAVED_FINAL_COMPLETE')",'readable return');
  const record=[...broker.records.values()][0],native=record.session;reconnectDelay=1200;
  for(const peer of [...peers])peer.socket.destroy();
  await until(a,`sessions.get(${sid})?.nativeRuntime?.observation?.state==='reconnecting'`,'observation disconnect');
  assert(!(await a.eval("document.querySelector('.floating-input-wrap')?.textContent || document.body.textContent")).includes('Hub 状态同步连接已断开'));
  await until(a,`sessions.get(${sid})?.nativeRuntime?.connection==='connected'`,'observation recovered');
  assert.strictEqual([...broker.records.values()][0].session,native);assert(await a.eval("document.querySelector('.cb-list').textContent.includes('SAVED_FINAL_COMPLETE')"));reconnectDelay=0;checked('observation reconnect retains records and native writer without repeated red sync text');
  await until(a,`(()=>{try{return JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dataDir,'state.json'))},'utf8')).sessions.some(s=>s.hubId===${sid}||s.id===${sid})}catch{return false}})()`,'state persisted');
  const b=await launch('legacy-history-b');await until(b,`sessions.has(${sid})`,'second Hub restores');await b.eval(`selectSession(${sid})`);if(await b.eval('currentView')!=='pty')await click(b,'#btn-backstage');
  await until(b,"document.querySelector('.cb-list')?.textContent.includes('SAVED_FINAL_COMPLETE')",'restored work records');
  assert.strictEqual([...broker.records.values()][0].session,native);await shot(b,'legacy-resumed');checked('resumed second Hub inherits work records from the same legacy writer');
  for(const c of clients)assert.deepEqual(await c.eval('__recoveryErrors'),[]);
  result.passed=true;
}finally{
  for(let i=0;i<clients.length;i++){try{await shot(clients[i],'final-'+i);}catch(error){result.screenshotError=error.message;}await clients[i].close();}
  for(const hub of hubs.reverse()){await gracefulQuit(hub);const log=hub.log().join('\n');fs.writeFileSync(path.join(out,'hub-'+hub.pid+'.log'),log,'utf8');if(!/hook.*(?:listening|监听)/i.test(log))result.hookSmokeMissing=true;}
  for(const peer of peers)peer.socket.destroy();
  for(const record of broker.records.values()){clearTimeout(record.cleanupTimer);clearTimeout(record.contentTimer);record.session.kill();record.toolRoute?.dispose();}
  server.close();removeOwnMetadata(dataDir,serviceId);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result));
}
})().catch(error=>{console.error(error.stack);if(error.logTail)console.error(error.logTail);process.exitCode=1;});
