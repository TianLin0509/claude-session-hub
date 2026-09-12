'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-composer-speed-'));
const data=path.join(root,'data'),work=path.join(root,'work'),trace=path.join(root,'trace.jsonl');
const art=path.resolve('output/playwright/composer-speed-'+Date.now());
for(const dir of [data,work,art,path.join(root,'codex')])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(root,'codex','models_cache.json'),JSON.stringify({models:[{slug:'gpt-6-astra',additional_speed_tiers:['fast'],supported_reasoning_levels:['high','max','ultra'].map(effort=>({effort}))}]}));
fs.writeFileSync(path.join(work,'.aiwork-root'),'');
const project=path.join(work,'demo');
fs.mkdirSync(path.join(project,'.git'),{recursive:true});fs.mkdirSync(path.join(project,'.agents'));
fs.writeFileSync(path.join(project,'.agents','project.json'),JSON.stringify({name:'速度验证',trunk:'master'}));
new (require('../core/prepared-project-registry').PreparedProjectRegistry)({dataDir:data}).register(project);
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 let hub,cdp;const evidence={passed:false,checks:[],art,provider:'controlled App Server fixture'};
 const ok=(label,value)=>{assert(value,label);evidence.checks.push(label);console.log('PASS '+label);};
 const wait=async expr=>{const end=Date.now()+30000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(100);}throw Error('Timeout '+expr);};
 const invoke=(ch,args)=>cdp.eval(`ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
 const click=async selector=>{
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e?.getBoundingClientRect().width>0 && !e.disabled;})()`);
  const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('covered '+${JSON.stringify(selector)});return{x,y};})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});
 };
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(art,name+'.png'),Buffer.from(r.data,'base64'));};
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await port(),windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:work,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});
  cdp=await connectFirstPage(hub);await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1450,height:950,deviceScaleFactor:1,mobile:false});
  await wait('!!window.WorkspaceController && !!window.MeetingRoom');
  const session=await invoke('create-session',{kind:'codex',opts:{cwd:work,model:'gpt-6-astra',effort:'high',mcpProfile:'none',codexSpeedTier:'fast'}});
  const sid=JSON.stringify(session.id);
  await wait(`sessions.get(${sid})?.nativeRuntime?.state==='idle'`);
  await click(`[data-session-id="${session.id}"]`);
  await click('.floating-input-box');await cdp.send('Input.insertText',{text:'保留这份草稿'});
  const threadId=(await invoke('get-sessions')).find(s=>s.id===session.id).codexSid;
  for(const tier of ['standard','fast','standard']){
   await click('.floating-input-bar .composer-speed');
   await wait(`!!document.querySelector('.speed-picker-menu [data-speed="${tier}"]:not(:disabled)')`);
   await click(`.speed-picker-menu [data-speed="${tier}"]`);
   await wait(`sessions.get(${sid})?.codexSpeedTier===${JSON.stringify(tier)} && !sessions.get(${sid})?._modelSwitchPending`);
   const updated=(await invoke('get-sessions')).find(s=>s.id===session.id);
   ok('ordinary '+tier+' preserves model/effort/thread',updated.codexSpeedTier===tier&&updated.effort==='high'&&updated.currentModel.id==='gpt-6-astra'&&updated.codexSid===threadId);
   ok('draft preserved '+tier,await cdp.eval(`document.querySelector('.floating-input-box').innerText==='保留这份草稿'`));
   await shot('ordinary-'+tier);
   await wait("!document.querySelector('.speed-picker-menu')");
   await click('.floating-input-box');
  }
  const requests=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  ok('switching creates no model turn',!requests.some(r=>r.method==='turn/start'));
  await click('.floating-input-send');
  await wait(`sessions.get(${sid})?.nativeRuntime?.state==='completed'`);
  const turns=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='turn/start');
  ok('next request carries standard tier with original effort',turns.at(-1).params.serviceTier==='default'&&turns.at(-1).params.effort==='high');
  await cdp.eval("openMeetingCreateModal('group')");
  await click('[data-mcm-workspace-mode="default"]');
  await cdp.eval(`document.querySelectorAll('.mcm-ai-select').forEach(s=>{s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})`);
  await click('#meeting-create-modal .mcm-create');
  await wait(`document.querySelectorAll('#mr-input-tuning .composer-speed').length===2`);
  await wait(`Array.from(document.querySelectorAll('#mr-input-tuning .mr-input-member-tuning')).every(e=>sessions.get(e.dataset.sid)?.nativeRuntime?.connection==='unstarted')`);
  const ids=await cdp.eval(`Array.from(document.querySelectorAll('#mr-input-tuning .mr-input-member-tuning'),e=>e.dataset.sid)`);
  const before=(await invoke('get-sessions')).find(s=>s.id===ids[1]).codexSpeedTier;
  await click(`#mr-input-tuning [data-sid="${ids[0]}"] .composer-speed`);
  await click('.speed-picker-menu [data-speed="fast"]');
  await wait(`sessions.get(${JSON.stringify(ids[0])})?.codexSpeedTier==='fast' && !sessions.get(${JSON.stringify(ids[0])})?._modelSwitchPending`);
  const after=await invoke('get-sessions');
  ok('group changes only the chosen member',before==='standard'&&after.find(s=>s.id===ids[0]).codexSpeedTier==='fast'&&after.find(s=>s.id===ids[1]).codexSpeedTier===before);
  ok('changing an unused seat does not start Codex',ids.every(id=>!after.find(s=>s.id===id).codexSid && after.find(s=>s.id===id).nativeRuntime.connection==='unstarted'));
  await shot('group-fast');await wait("!document.querySelector('.speed-picker-menu')");await click('#mr-input-box');
  for(const width of [1000,760]) {
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});
   await click(`#mr-input-tuning [data-sid="${ids[1]}"] .composer-speed`);
   ok('speed menu fits '+width,await cdp.eval(`(()=>{const r=document.querySelector('.speed-picker-menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`));
   await shot('group-'+width);
  }
  await cdp.send('Page.reload');
  await wait(`typeof sessions!=='undefined' && sessions.has(${sid})`);
  ok('renderer reload retains selected tier',await cdp.eval(`sessions.get(${sid}).codexSpeedTier==='standard'`));
  evidence.passed=true;
 }catch(e){evidence.error=e.stack;if(cdp){evidence.debug=await cdp.eval(`({catalog:window.WorkspaceController?.codexModelTuning('gpt-6-astra'),ui:document.querySelector('.speed-picker-menu')?.innerText,local:[...sessions.values()].map(s=>({id:s.id,pending:s._modelSwitchPending,tier:s.codexSpeedTier}))})`);console.log(JSON.stringify(evidence.debug));await shot('failure');}throw e;}
 finally{if(hub)fs.writeFileSync(path.join(art,'hub.log'),hub.log().join('\n'));if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(art,'checks.json'),JSON.stringify(evidence,null,2));console.log('ARTIFACT_ROOT '+art);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
