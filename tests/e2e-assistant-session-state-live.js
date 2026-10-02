'use strict';
// Real subscription PTYs. Sessions are created for setup; prompts and reading
// use actual mouse/keyboard input. No synthetic runtime/attention flags.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {readFinals}=require('../core/hub-assistant/live-history');
const {readCodexModelList}=require('../main/codex-model-catalog-service');
const {frozenSnapshotOutputs}=require('./helpers/assistant-native-evidence');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-state-live-')),data=path.join(root,'data'),home=path.join(root,'home'),codexHome=path.join(home,'codex'),workspace=path.join(root,'workspaces');
 const out=path.resolve('artifacts/assistant-state-live',new Date().toISOString().replace(/[:.]/g,'-')),job=path.join(workspace,'status-job');
 for(const d of [data,codexHome,workspace,job,out])fs.mkdirSync(d,{recursive:true});
 const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8')),provider=cfg.providers.codex;
 assert.equal(provider.backend,'subscription');const profile=provider.subscription_profiles.find(p=>p.id===provider.subscription_profile);assert(profile);
 const auth=path.join(profile.home||path.join(os.homedir(),'.codex'),'auth.json'),before=hash(auth);
 fs.copyFileSync(auth,path.join(codexHome,'auth.json'));
 const trusted=[workspace,job,path.resolve('.')].map(p=>"[projects.'"+p.toLowerCase()+"']\ntrust_level = \"trusted\"").join('\n');
 fs.writeFileSync(path.join(codexHome,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n'+trusted+'\n','utf8');
 fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{codex:'gpt-6.1-sol'}},providers:{codex:{backend:'subscription',subscription_profile:profile.id,subscription_profiles:[{id:profile.id,label:profile.label,home:codexHome}]}}}));
 let hub,cdp;const result={passed:false,scope:'真实隔离 Hub、真实 Codex PTY、真实主账号额度；非模拟状态',profile:profile.id,model:'gpt-6.1-sol',checks:[],root,out};
 const until=async(label,read,timeout=90000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await read();if(v)return v;await wait(200);}throw Error('timeout '+label);};
 const invoke=(channel,args)=>cdp.eval('ipcRenderer.invoke('+j(channel)+','+j(args)+')');
 const click=async selector=>{await until('clickable '+selector,()=>cdp.eval('(()=>{const e=document.querySelector('+j(selector)+');if(!e||e.disabled)return false;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(h===e||e.contains(h));})()'),30000);
   const p=await cdp.eval('(()=>{const r=document.querySelector('+j(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
   for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const screen=id=>cdp.eval('(()=>{const t=terminalCache.get('+j(id)+')?.terminal;if(!t)return "";const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||"").join(String.fromCharCode(10))})()');
 const send=async text=>{await click('.floating-input-box');await cdp.send('Input.insertText',{text});await click('.floating-input-send');};
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const meta=id=>cdp.eval('JSON.parse(JSON.stringify(sessions.get('+j(id)+')))');
 const finals=async id=>readFinals(await meta(id)).records;
 const sidebar=async id=>cdp.eval('(()=>{const e=document.querySelector('+j('[data-session-id="'+id+'"]')+');if(!e)return null;let n=e;while(n&&n.parentElement.id!=="session-list")n=n.parentElement;while(n&&!n.classList.contains("session-sec-header"))n=n.previousElementSibling;return {group:n?.className,unread:e.classList.contains("need-unread"),text:e.textContent}})()');
 try{
  const models=await readCodexModelList({home:codexHome,timeoutMs:20000});
  result.catalog=models.filter(m=>['gpt-6.1-sol','gpt-6-luna'].includes(m.id||m.slug)).map(m=>({id:m.id||m.slug,efforts:m.supportedReasoningEfforts||m.supported_reasoning_levels,speed:m.additional_speed_tiers,tiers:m.service_tiers}));
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,label:'assistant-state-live',windowMode:'background',allowExternalState:true,extraEnv:{
   CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:path.join(home,'claude'),CODEX_HOME:codexHome,CODEX_SQLITE_HOME:'',CLAUDE_HUB_AGENT_RUNTIME:'pty',HUB_CODEX_PROFILE:'',HUB_CODEX_BACKEND:'subscription',
   CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:'',CLAUDE_HUB_NATIVE_FIXTURE_STORE:'',CLAUDE_HUB_NATIVE_FIXTURE_TRACE:'',OPENAI_API_KEY:'',CODEX_API_KEY:'',DEEPSEEK_API_KEY:'',AI_HUB_WORKSPACE_ROOT:workspace,
   HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty')}});
  result.pid=hub.pid;cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
  if(await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');
  await click('#btn-assistant');
  const assistant=await until('assistant',()=>cdp.eval('([...sessions.values()].find(s=>s.purpose==="hub-assistant"))?.id'));
  result.assistantId=assistant;await until('assistant TUI ready',async()=>/Ask Codex to do anything/.test(await screen(assistant)));
  // Exercise the normal native model picker rather than editing runtime metadata.
  await click('.composer-thinking');await click('.effort-picker-menu [data-effort="low"]');
  await until('low effort confirmed',async()=>{const m=await meta(assistant);return m.effort==='low'&&!m._modelSwitchPending;});
  result.assistantTuning={effort:(await meta(assistant)).effort,codexSpeedTier:(await meta(assistant)).codexSpeedTier};
  await until('picker closed',()=>cdp.eval('!document.querySelector(".effort-picker-menu")'));
  await send('/fast');
  const fastScreen=await until('native Fast acknowledgement',async()=>{const text=await screen(assistant);return /fast mode.*(?:on|enabled)|(?:enabled|on).*fast mode|gpt-6\.1-sol.*low.*fast/i.test(text)?text:null;},30000);
  result.fastAcknowledgement=fastScreen;result.assistantTuning.nativeFast=true;
  result.checks.push('原生 Codex 已确认低思考及 Fast；仅隔离助理改变设置');
  const target=await invoke('create-session',{kind:'codex',opts:{title:'状态验收任务',cwd:job,codexProfile:profile.id,model:'gpt-6.1-sol',effort:'low',codexSpeedTier:'standard',mcpProfile:'none'}});
  const targetId=target.id;assert(targetId);result.targetId=targetId;
  await click('[data-session-id="'+targetId+'"]');
  await until('target TUI ready',async()=>/Ask Codex to do anything/.test(await screen(targetId)));
  const initial=await invoke('assistant:context',{});const initialRow=initial.workbench.inventory.find(s=>s.id===targetId);
  assert.equal(initialRow.isOpen,true);assert.equal(initialRow.hubState.isActive,false);result.checks.push('真实已打开空闲会话：助理不再把已打开当活跃');
  await click('[data-session-id="'+targetId+'"]');
  await send('这是运行状态验收。请使用命令等待15秒，然后仅回复“状态验收完成”。');
  await click('#btn-assistant');
  const running=await until('worker running in sidebar and assistant',async()=>{const p=await invoke('assistant:context',{}),r=p.workbench?.inventory.find(s=>s.id===targetId),v=await sidebar(targetId);return r?.hubState.isActive&&v?.group?.includes('sec-active')?{r,v}:null;},60000);
  result.running=running;await shot('01-real-running');result.checks.push('真实任务运行：侧栏活跃分组与助理状态一致');
  await until('target final',async()=>{const r=await finals(targetId);return r.length&&r.at(-1).text.includes('状态验收完成');},180000);
  const unread=await until('unread parity',async()=>{const p=await invoke('assistant:context',{}),r=p.workbench.inventory.find(s=>s.id===targetId),v=await sidebar(targetId);return r.hubState.hasUnread&&!r.hubState.isActive&&v?.unread&&!v.group.includes('sec-active')?{p,r,v}:null;});
  assert.equal(unread.r.hubState.unreadCount,(await meta(targetId)).unreadCount);
  assert(unread.r.hubState.unreadCount>0);assert.equal(unread.r.hubState.source,'Hub 侧栏当前状态快照');
  result.unread={row:unread.r,sidebar:unread.v};await shot('02-real-unread');result.checks.push('真实任务完成：退出活跃，侧栏新回复与助理未读状态及条数一致');
  const started=Date.now();
  await send('请查本轮最新状态，告诉我“状态验收任务”是否仍在运行、有没有未读回复、是否需要我回答问题。用三句白话回答。');
  const answer=await until('assistant status answer',async()=>{const r=await finals(assistant);return r.length?r.at(-1):null;},180000);
  result.answerLatencyMs=Date.now()-started;result.answer=answer.text;fs.writeFileSync(path.join(out,'assistant-answer.txt'),answer.text,'utf8');
  const records=fs.readFileSync(answer.transcriptPath,'utf8').trim().split('\n').map(JSON.parse),snapshotRecord=records.findLast(r=>r.type==='response_item'&&r.payload?.role==='user');
  const text=snapshotRecord.payload.content.map(c=>c.text||'').join(''),frame=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('[/AI_HUB_ASSISTANT_CONTEXT_V1]')));
  const outputs=frozenSnapshotOutputs(records,frame.history.requestToken);assert(outputs.length);
  const received=outputs.at(-1).packet.workbench.inventory.find(s=>s.id===targetId);
  assert.equal(received.hubState.isActive,false);assert.equal(received.hubState.hasUnread,true);assert.equal(received.hubState.needsUserInput,false);
  assert.equal(received.hubState.unreadCount,(await meta(targetId)).unreadCount);
  assert.match(answer.text,/未读/);assert.match(answer.text,/完成|结束|不.*运行/);assert.match(answer.text,/不需要|无需|没有.*问题|不用|不.*回答/);
  result.modelReceivedState=received.hubState;result.checks.push('真实 gpt-6.1-sol low + Fast 读取冻结状态资料并用白话正确回答');
  await shot('03-real-assistant-answer');
  await click('[data-session-id="'+targetId+'"]');
  await until('read parity',async()=>{const p=await invoke('assistant:context',{}),r=p.workbench.inventory.find(s=>s.id===targetId),v=await sidebar(targetId);return r.hubState.hasUnread===false&&v?.unread===false;});
  result.checks.push('鼠标打开回复：侧栏与助理同时更新为已读，无需新回答');
  assert.equal(hash(auth),before);result.productionAuthUnchanged=true;result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;if(cdp)await shot('failure').catch(()=>{});}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
