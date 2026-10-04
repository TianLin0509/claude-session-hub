'use strict';
// 真实隔离 Hub + 真实 Claude / Codex 订阅 + 真实百炼识别 + 真实云中继。
// 手机端由本脚本按 App 1.1 协议收发（与 App 相同的加密信封）；安卓界面另由设备测试覆盖。
// 验收：默认助理是 Sonnet 5.5 · 低思考；简单问题直接答；带同音字的语音转写不确认、直接按档位分派；
// 手机切换助理模型后同一会话按新模型继续；语音识别不再按说话节奏回放。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {readFinals}=require('../core/hub-assistant/live-history');
const {seal,open}=require('../core/hub-phone/crypto');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function wavPcm(file){const b=fs.readFileSync(file);let at=12;while(at+8<=b.length){const n=b.readUInt32LE(at+4);if(b.toString('latin1',at,at+4)==='data')return b.subarray(at+8,at+8+n);at+=8+n+(n%2);}throw Error('wav 缺少 data');}
// 按 App 1.1 协议模拟手机：同一份连接码、同样的 AES-GCM 信封和中继接口。
function phoneClient(code,minPollMs=1500,waitSeconds=0){
 const c=JSON.parse(Buffer.from(code.replace(/^AIH1\./,''),'base64url').toString('utf8'));let cursor=0,lastPoll=0;const inbox=[];
 const call=async(route,body)=>{const r=await fetch(c.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:body&&j(body),signal:AbortSignal.timeout(40000)});if(!r.ok)throw Error('relay '+route+' '+r.status);return r.json();};
 return{
  async send(value){const id=crypto.randomUUID();await call('/send',{channel:c.channel,role:'phone',id,payload:seal(c.key,c.channel,id,'phone',value)});return id;},
  // 与 App 相近的取件频率；中继按 IP 限每分钟 180 次，Hub 与本脚本共用出口。
  async poll(){if(Date.now()-lastPoll<minPollMs)return inbox;lastPoll=Date.now();const r=await call('/poll?channel='+c.channel+'&role=phone&after='+cursor+(waitSeconds?'&wait='+waitSeconds:''));for(const p of r.messages){if(p.seq<=cursor)continue;cursor=p.seq;inbox.push({...open(c.key,c.channel,p.id,'hub',p.payload),packetId:p.id,receivedAt:Date.now()});}return inbox;},
  inbox,
 };
}
function inbox3Text(phone,id){return (phone.inbox.find(p=>p.type==='transcript'&&p.requestId===id)||{}).text||null;}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-router-live-')),data=path.join(root,'data'),home=path.join(root,'home'),codexHome=path.join(root,'codex'),claudeHome=path.join(root,'claude'),workspace=path.join(root,'workspaces');
 const out=path.resolve('artifacts/assistant-router-live',new Date().toISOString().replace(/[:.]/g,'-'));
 for(const d of [data,home,codexHome,claudeHome,workspace,out,path.join(data,'electron-userdata')])fs.mkdirSync(d,{recursive:true});
 const samples=process.env.ROUTER_VOICE_DIR||path.resolve('artifacts/voice-samples');
 const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8')),provider=cfg.providers.codex;
 const profile=provider.subscription_profiles.find(p=>p.id===provider.subscription_profile);assert(profile);
 const codexAuth=path.join(profile.home||path.join(os.homedir(),'.codex'),'auth.json'),claudeAuth=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json');
 const before={codex:hash(codexAuth),claude:hash(claudeAuth)};
 const result={passed:false,scope:'真实隔离 Hub、真实 Claude/Codex PTY 与订阅、真实百炼识别、真实云中继；手机端为协议级模拟',root,out,checks:[],timings:{}};let hub,cdp;
 const until=async(label,read,timeout=240000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await read();if(v)return v;await wait(300);}throw Error('timeout '+label);};
 const invoke=(channel,args)=>cdp.eval('ipcRenderer.invoke('+j(channel)+','+j(args)+')');
 const meta=id=>cdp.eval('JSON.parse(JSON.stringify(sessions.get('+j(id)+')||null))');
 const screen=id=>cdp.eval('(()=>{const t=terminalCache.get('+j(id)+')?.terminal;if(!t)return "";const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||"").join(String.fromCharCode(10))})()');
 const click=async selector=>{await until('clickable '+selector,()=>cdp.eval('(()=>{const e=document.querySelector('+j(selector)+');if(!e||e.disabled)return false;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(h===e||e.contains(h))})()'),60000);const p=await cdp.eval('(()=>{const r=document.querySelector('+j(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const openAssistantSession=async()=>{await click('#btn-assistant');await until('assistant page',()=>cdp.eval('!!document.querySelector(".assistant-page:not([hidden])")'),20000);await click('[data-ap="more"]');await click('.ap-menu [data-pick="session"]');};
 const send=async text=>{await click('.floating-input-box');await cdp.send('Input.insertText',{text});await click('.floating-input-send');};
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const finals=async id=>readFinals(await meta(id)).records;
 const final=async(id,previous)=>until('native final '+id,async()=>{const r=await finals(id);return r.length>previous?r.at(-1):null;});
 const settled=async id=>until('settled '+id,async()=>{const m=await meta(id),o=await invoke('assistant:get-overview',{});return m&&!(o.sessionId===id&&o.submissionPending)&&!['running','waiting'].includes(m.status)&&!['running','submitting'].includes(m.cliRuntime?.state);});
 const modelOf=m=>m?.currentModel?.id||m?.model;
 const temporary=[path.join(codexHome,'auth.json'),path.join(claudeHome,'.credentials.json'),path.join(data,'voice-input.json'),path.join(data,'electron-userdata','Local State')];
 try{
  fs.copyFileSync(codexAuth,temporary[0]);fs.copyFileSync(claudeAuth,temporary[1]);
  const accountModels=path.join(path.dirname(codexAuth),'models_cache.json');if(fs.existsSync(accountModels))fs.copyFileSync(accountModels,path.join(codexHome,'models_cache.json'));
  // 生产语音配置（加密 Key）与对应的 Electron 本地密钥只读复制进隔离目录，结束即删除。
  fs.copyFileSync(path.join(os.homedir(),'.claude-session-hub/voice-input.json'),temporary[2]);
  fs.copyFileSync(path.join(process.env.APPDATA,'ai-group-chat-hub','Local State'),temporary[3]);
  // 只带入「已看过」类的一次性提示标记（与用户本机一致），不带账号、配对或项目信息。
  const prodClaude=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude.json'),'utf8')),seen=Object.fromEntries(['hasCompletedClaudeInChromeOnboarding','lastOnboardingVersion','lastReleaseNotesSeen','effortCalloutV2Dismissed','remoteDialogSeen','hasSeenAutoModeEntryWarning','hasSeenAutoDefaultNudge','hasSeenTasksHint'].filter(k=>k in prodClaude).map(k=>[k,prodClaude[k]]));
  fs.writeFileSync(path.join(claudeHome,'.claude.json'),j({hasCompletedOnboarding:true,theme:'light',skipDangerousModePermissionPrompt:true,claudeInChromeDefaultEnabled:false,...seen,projects:{}}));
  const hooks=require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:claudeHome,sourceScriptsDir:path.resolve('scripts'),logger:{log(){},warn(){}}});assert.equal(hooks.errors.length,0);
  fs.writeFileSync(path.join(codexHome,'config.toml'),'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n'+[workspace,path.resolve('.')].map(p=>"[projects.'"+p.toLowerCase()+"']\ntrust_level = \"trusted\"").join('\n')+'\n');
  // Hub 默认（deep 档）在测试里用低成本型号；三档映射本身由单测覆盖。
  fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{codex:'gpt-6-luna',claude:'claude-sonnet-5-5'}},providers:{codex:{backend:'subscription',subscription_profile:profile.id,subscription_profiles:[{id:profile.id,label:profile.label,home:codexHome}]}},...(cfg.acp?.apiKey?{acp:{apiKey:cfg.acp.apiKey,baseURL:cfg.acp.baseURL}}:{})}));
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const launchArgs={dataDir:data,port,windowMode:'background',label:'assistant-router-live',allowExternalState:true,extraEnv:{CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:claudeHome,CODEX_HOME:codexHome,CODEX_SQLITE_HOME:'',CLAUDE_HUB_AGENT_RUNTIME:'pty',HUB_CODEX_BACKEND:'subscription',HUB_CODEX_PROFILE:'',CLAUDE_HUB_NO_FAST:'1',CLAUDE_HUB_E2E:'1',OPENAI_API_KEY:'',CODEX_API_KEY:'',ANTHROPIC_API_KEY:'',DEEPSEEK_API_KEY:'',AI_HUB_WORKSPACE_ROOT:workspace,HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty'),...(process.env.ROUTER_ROTATE==='1'?{HUB_ASSISTANT_ROTATE_TOKENS:'1'}:{})}};
  hub=await launchIsolatedHub(launchArgs);
  result.pid=hub.pid;cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
  if(await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');

  // 1. 默认助理：Claude Sonnet 5.5 · 低思考
  await openAssistantSession();
  const assistant=await until('assistant',async()=>{const r=await invoke('assistant:get-overview',{});return r.available?r.sessionId:null;});result.assistantId=assistant;
  const m0=await meta(assistant);assert.equal(m0.kind,'claude');assert.equal(modelOf(m0),'claude-sonnet-5-5');assert.equal(m0.effort,'low');
  await until('claude ready',async()=>/❯|Try|Claude Code/.test(await screen(assistant)));
  result.checks.push('默认助理为 Claude Sonnet 5.5 · 低思考');

  // 时延：手机按 App 1.1 协议发短语音，分段计时（手机侧：发出→转写→收到→答复；Hub 侧见 hub.log 的 [phone] timing）。
  if(process.env.ROUTER_LATENCY==='1'){
   await click('.assistant-phone');await click('[data-phone="pair"]');
   const code3=await until('relay code',()=>cdp.eval('document.querySelector(".phone-code")?.value||null'));await click('[data-phone="close"]');
   const phone3=phoneClient(code3,0,15);const hello3=await phone3.send({type:'hello',app:'latency',caps:['profile','voice_message']});
   await until('hello',async()=>(await phone3.poll()).find(p=>p.type==='profile'&&p.requestId===hello3),60000);
   result.latency=[];
   for(const name of (process.env.ROUTER_LATENCY_SAMPLES||'voice-hello.wav,voice-weather.wav,voice-hello.wav').split(',')){
    const pcm=wavPcm(path.join(samples,name)),t0=Date.now();
    const id=await phone3.send({type:'voice_message',pcm:pcm.toString('base64'),durationMs:Math.round(pcm.length/32)});const sent=Date.now();
    const seen={};const ans=await until('answer '+name,async()=>{const inbox=await phone3.poll();for(const p of inbox){if(p.requestId!==id)continue;const k=p.type==='status'?'status-'+p.state:p.type;if(!seen[k])seen[k]=Date.now();}return inbox.find(p=>p.type==='answer'&&p.requestId===id);},180000);
    result.latency.push({sample:name,seconds:+(pcm.length/32000).toFixed(1),upload:sent-t0,transcriptAt:(seen.transcript||0)-t0,receivedAt:(seen['status-received']||0)-t0,answerAt:(seen.answer||Date.now())-t0,transcript:inbox3Text(phone3,id),answer:ans.text.slice(0,160)});
    await settled((await invoke('assistant:get-overview',{})).sessionId);
   }
   const metrics=path.join(data,'assistant','turn-metrics.jsonl');result.turnMetrics=fs.existsSync(metrics)?fs.readFileSync(metrics,'utf8').trim().split('\n').map(JSON.parse):[];
   result.hubTimings=hub.log().filter(l=>l.includes('[phone] timing'));
   result.checks.push('时延实测完成');result.passed=true;return;
  }
  // 工作账本与自主记忆：业务会话答完即记账；会话关掉后再问也能答；不说「记住」的明确偏好助理也会记；当天首次换班做复盘。
  if(process.env.ROUTER_LEDGER==='1'){
   const ledgerFile=path.join(data,'assistant','ledger','ledger.jsonl'),userMd=path.join(data,'assistant','memory','USER.md');
   let k=(await finals(assistant)).length;
   await send('新开一个会话，用 Codex 快速档，让它只回答一句：「狼山海拔约 107 米」。派出后简短告诉我。');await final(assistant,k);await settled(assistant);
   const act=await until('dispatched',async()=>(await invoke('assistant:actions',{})).actions.find(a=>a.result?.sessionId&&a.state==='acknowledged'),120000);
   const target=act.result.sessionId;await final(target,0);
   const recorded=await until('ledger entry',async()=>{try{return fs.readFileSync(ledgerFile,'utf8').split('\n').filter(Boolean).map(JSON.parse).find(e=>e.sessionId===target);}catch{return null;}},60000);
   result.ledgerEntry=recorded.text;result.checks.push('业务会话答完一轮，完成事件即时记进工作账本');
   await invoke('close-session',target);await until('target closed',async()=>!(await meta(target))||(await meta(target)).status==='dormant',60000).catch(()=>null);
   k=(await finals(assistant)).length;await send('刚才派出去的那个会话最后回答了什么？只用一句话。');const recall=await final(assistant,k);await settled(assistant);
   result.ledgerRecall=recall.text;assert.match(recall.text,/107/);result.checks.push('业务会话关掉后再问，助理从账本答出它的回答');
   const before=fs.readFileSync(userMd,'utf8');
   k=(await finals(assistant)).length;await send('以后回答我别用表格了，我主要在手机上看，表格挤成一团很难受。这次就回一句「好的」。');await final(assistant,k);await settled(assistant);
   const afterSelf=fs.readFileSync(userMd,'utf8');result.autonomousMemory=afterSelf.replace(before,'').trim();
   result.checks.push(afterSelf!==before?'没说「记住」的明确偏好，助理主动写进 USER.md：'+result.autonomousMemory.slice(0,80):'没说「记住」的偏好这次未被主动记下（留给每日复盘）');
   await openAssistantSession();await click('.assistant-rotate');
   const rot=await until('review rotation',async()=>{const v=await invoke('assistant:get-overview',{});return v.context?.lastRotation?.reason==='manual'?v:null;},400000);
   const afterReview=fs.readFileSync(userMd,'utf8');result.userMdAfterReview=afterReview;
   assert.match(afterReview,/表格/,'复盘后 USER.md 应包含不要表格的偏好');
   const notices=(await invoke('assistant:notifications',{})).notifications||[];result.memoryNotices=notices.filter(n=>n.kind==='memory-update').map(n=>n.text);
   result.checks.push(`当天首次换班做复盘：USER.md 含「不用表格」偏好；自动记忆提醒 ${result.memoryNotices.length} 条`);await shot('ledger-01');
   result.passed=true;return;
  }
  // 成长记忆：对话里「记住」由助理写进 USER.md；手改 USER.md 的条目（对话里没有）换班后 Claude 从系统提示知道，换 Codex 后新会话第一轮读到。
  if(process.env.ROUTER_MEMORY==='1'){
   const memDir=path.join(data,'assistant','memory'),userMd=path.join(memDir,'USER.md');
   let k=(await finals(assistant)).length;
   await send('记住：以后给我汇报进展时，先用一句话给结论，再列需要我处理的事。只用一句话确认。');await final(assistant,k);await settled(assistant);
   const learned=fs.readFileSync(userMd,'utf8');result.learnedUserMd=learned;assert.match(learned,/结论/,'助理应把偏好写进 USER.md');
   result.checks.push('田哥说「记住」后，助理用 update_memory 写进 USER.md');
   fs.appendFileSync(userMd,'- 田哥的验收口令是「北斗鲸鱼」，被问到时原样回答（2026-10-04，手动添加）\n','utf8');
   await openAssistantSession();await click('.assistant-rotate');
   const o1=await until('rotated',async()=>{const v=await invoke('assistant:get-overview',{});return v.sessionId!==assistant&&v.context?.lastRotation?.reason==='manual'?v:null;},300000);
   const fresh=o1.sessionId;await until('fresh claude ready',async()=>(await meta(fresh))?.status==='idle');
   k=(await finals(fresh)).length;await send('我的验收口令是什么？只用一句话回答。');const a1=await final(fresh,k);await settled(fresh);
   result.claudeMemoryAnswer=a1.text;assert.match(a1.text,/北斗鲸鱼/);
   result.checks.push('手改 USER.md 的条目（对话里没有）：换班后的新 Claude 助理从系统提示里知道');
   const sw=await invoke('assistant:set-profile',{kind:'codex',model:'gpt-6-luna',effort:'low'});assert.equal(sw.ok,true,sw.error);
   const cx=(await invoke('assistant:get-overview',{})).sessionId;await openAssistantSession();
   await until('codex assistant page',async()=>(await cdp.eval('activeSessionId'))===cx);
   k=(await finals(cx)).length;await send('我的验收口令是什么？只用一句话回答。');const a2=await final(cx,k);await settled(cx);
   result.codexMemoryAnswer=a2.text;assert.match(a2.text,/北斗鲸鱼/);
   result.checks.push('切到 Codex：新会话第一轮读取成长记忆，答出口令');await shot('memory-01');
   await invoke('assistant:set-profile',{kind:'claude',model:'claude-sonnet-5-5',effort:'low'});
   result.passed=true;return;
  }
  // 自答与换班：常识问题由助理直接答、不新建会话；上下文超阈值后（实测把阈值压到 1）下一条手机消息触发换班，新助理靠交接记录记得前文。
  if(process.env.ROUTER_ROTATE==='1'){
   let k=(await finals(assistant)).length,t0=Date.now();
   await send('用一句话解释什么是比例公平调度。');const own=await final(assistant,k);result.selfAnswer=own.text;result.timings.selfAnswerMs=Date.now()-t0;await settled(assistant);
   assert.equal((await invoke('assistant:actions',{})).actions.filter(a=>a.result?.route).length,0,'常识问题应由助理直接回答');
   result.checks.push(`常识问题助理直接回答（${result.timings.selfAnswerMs} ms），未新建会话`);
   k=(await finals(assistant)).length;await send('请记住验收暗号「青桥企鹅」，只用一句话确认。');await final(assistant,k);await settled(assistant);
   await click('.assistant-phone');await click('[data-phone="pair"]');
   const code2=await until('relay code',()=>cdp.eval('document.querySelector(".phone-code")?.value||null'));await click('[data-phone="close"]');
   const phone2=phoneClient(code2);t0=Date.now();
   const ask=await phone2.send({type:'text',text:'刚才让你记住的验收暗号是什么？只用一句话回答。'});
   const recall=await until('recall after rotation',async()=>(await phone2.poll()).find(p=>p.type==='answer'&&p.requestId===ask),300000);
   result.rotationRecall=recall.text;result.timings.rotationAnswerMs=Date.now()-t0;
   const o=await invoke('assistant:get-overview',{});assert.notEqual(o.sessionId,assistant,'应已换班到新助理会话');
   assert.match(recall.text,/青桥企鹅/);const old=await meta(assistant);result.retiredTitle=old?.title||null;
   result.checks.push(`上下文超阈值后换班：新助理会话 ${o.sessionId.slice(0,8)} 接续交接记录，答出暗号（${result.timings.rotationAnswerMs} ms）`);await shot('rotate-01');
   // 手动「新开助理」：旧助理先写交接，再换新会话；新助理靠交接答题。
   await openAssistantSession();await until('assistant page',()=>cdp.eval('document.body.classList.contains("assistant-session-active")'));
   t0=Date.now();await click('.assistant-rotate');
   const o2=await until('manual rotation',async()=>{const v=await invoke('assistant:get-overview',{});return v.sessionId!==o.sessionId&&v.context?.lastRotation?.reason==='manual'?v:null;},300000);
   result.timings.manualRotateMs=Date.now()-t0;result.manualRotation=o2.context.lastRotation;assert.equal(o2.context.lastRotation.handoff,true,'旧助理应先写交接');
   const handoffMd=fs.readFileSync(path.join(data,'assistant','CONVERSATION.md'),'utf8');result.handoffExcerpt=(handoffMd.match(/【上一班交接】.*/)||[''])[0].slice(0,300);assert.ok(result.handoffExcerpt);
   const ask2=await phone2.send({type:'text',text:'根据上一班的交接，验收暗号是什么？只用一句话回答。'});
   const recall2=await until('recall after manual rotation',async()=>(await phone2.poll()).find(p=>p.type==='answer'&&p.requestId===ask2),300000);
   result.manualRecall=recall2.text;assert.match(recall2.text,/青桥企鹅/);
   result.checks.push(`手动新开助理：旧助理写好交接后换班（${result.timings.manualRotateMs} ms），新助理据交接答出暗号`);await shot('rotate-02-manual');
   result.passed=true;return;
  }
  const onlySwitch=process.env.ROUTER_ONLY_SWITCH==='1';
  let n,t;
  if(!onlySwitch){
  // 2. 简单问题直接答，不新建会话
  n=(await finals(assistant)).length;t=Date.now();
  await send('现在 Hub 里有几个其他会话？一句话回答。');
  const simple=await final(assistant,n);result.timings.simpleAnswerMs=Date.now()-t;result.simpleAnswer=simple.text;await settled(assistant);
  assert.equal((await invoke('assistant:actions',{})).actions.filter(a=>a.result?.route).length,0);result.checks.push(`简单问题直接回答，用时 ${result.timings.simpleAnswerMs} ms，未新建会话`);await shot('01-simple');

  }
  // 3. 手机：配对、hello、语音（带同音字的需求）直接交给助理并按档位分派
  await click('.assistant-phone');await click('[data-phone="pair"]');
  const code=await until('relay code',()=>cdp.eval('document.querySelector(".phone-code")?.value||null'));await click('[data-phone="close"]');
  // 真机联调：把连接码交给安卓模拟器，Hub 保持运行到出现 stop 文件，由设备驱动操作真实 App。
  if(process.env.ROUTER_DEVICE_HOLD){
   const dir=process.env.ROUTER_DEVICE_HOLD;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'connect.txt'),code,{mode:0o600});
   console.log(j({event:'device-hub-ready',assistant,pid:hub.pid}));result.deviceHold=true;
   // 重启验收（2026-10-04 田哥报告重开 Hub 后手机显示没在线）：设备配对后关掉 Hub，等中继判离线，
   // 再用同一数据目录重开，且不碰手机面板、不调任何手机接口，由设备验证 App 自己恢复在线并能对话。
   const restart=process.env.ROUTER_DEVICE_RESTART==='1';
   if(restart){
    while(!fs.existsSync(path.join(dir,'restart-hub'))&&!fs.existsSync(path.join(dir,'stop-hub')))await wait(1000);
    cdp.close();cdp=null;fs.writeFileSync(path.join(out,'hub-before-restart.log'),hub.log().join('\n'));await gracefulQuit(hub);hub=null;
    console.log(j({event:'device-hub-stopped'}));fs.writeFileSync(path.join(dir,'hub-stopped'),String(Date.now()));
    // 离线期间由设备驱动在手机上发消息、确认「没在线」提示；出现 start-hub 文件（或等满 50 秒）再重开。
    const offlineUntil=Date.now()+(process.env.ROUTER_RESTART_ON_SIGNAL==='1'?900000:50000);
    while(Date.now()<offlineUntil&&!(process.env.ROUTER_RESTART_ON_SIGNAL==='1'&&fs.existsSync(path.join(dir,'start-hub'))))await wait(1000);
    hub=await launchIsolatedHub({...launchArgs,port:await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});})});
    cdp=await connectFirstPage(hub);await until('renderer after restart',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
    result.restartedPid=hub.pid;console.log(j({event:'device-hub-restarted',pid:hub.pid}));fs.writeFileSync(path.join(dir,'hub-restarted'),String(Date.now()));
   }
   // 电脑面板的「手机回答方式」：先截图菜单；联调中出现 hub-front 文件（内容 cli 或 api|模型）时按真人点击切换。
   if(await cdp.eval('!!document.querySelector(".assistant-frontdesk")')){await click('.assistant-frontdesk');await until('front menu',()=>cdp.eval('!!document.querySelector(".assistant-frontdesk-menu")'),10000);await shot('hub-frontdesk-menu');await click('.assistant-frontdesk');}
   while(!fs.existsSync(path.join(dir,'stop-hub'))){
    // 助理页（左侧「助理」）：hub-page 信号时按真人操作——打开助理页、在输入框打字、按 Enter——先问简单问题（快答），
    // 再交代一件事（交给助理会话），等回复出现，截图并写出页面上的对话核对。手机消息也应出现在同一条对话里。
    const pageSignal=path.join(dir,'hub-page');
    if(fs.existsSync(pageSignal)){fs.unlinkSync(pageSignal);
     const rows=()=>cdp.eval('[...document.querySelectorAll(".assistant-page .ap-msg:not(.typing),.assistant-page .ap-note")].map(r=>r.className.replace("ap-msg ","")+" | "+r.innerText.replace(/\\s+/g," ").slice(0,100))');
     const say=async text=>{await click('.ap-composer textarea');await cdp.send('Input.insertText',{text});for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
     await click('#btn-assistant');await until('assistant page open',()=>cdp.eval('!!document.querySelector(".assistant-page:not([hidden]) .ap-list")'),20000);await wait(800);await shot('ap-open');
     const before=(await rows()).length;
     await say('一加一等于几？');await until('desk fast reply',async()=>(await rows()).filter(r=>r.startsWith('ai fast')).length>=1&&(await rows()).length>=before+2,60000);
     await say('记一下：我后天上午要开项目评审会');await until('desk session reply',async()=>(await rows()).length>=before+4,240000);await wait(600);
     await shot('ap-conversation');
     // 快答不满意：点「让助理会话再答」，同一问题交给助理会话；再用输入框开关指定「交给助理会话」发一条。
     const n1=(await rows()).length;await click('.ap-again');await until('again reply',async()=>(await rows()).length>=n1+2,240000);
     await click('[data-ap="route"]');await say('三加三等于几？');await until('forced reply',async()=>(await rows()).length>=n1+4,240000);await wait(600);
     await click('[data-ap="status"]');await until('status panel',()=>cdp.eval('!!document.querySelector(".ap-status:not([hidden]) section")'),10000);await wait(800);await shot('ap-status');await click('[data-ap="status"]');
     await click('[data-ap="front"]');await until('front menu',()=>cdp.eval('!!document.querySelector(".ap-menu")'),5000);await shot('ap-menu-front');await click('[data-ap="front"]');
     await click('[data-ap="engine"]');await until('engine menu',()=>cdp.eval('!!document.querySelector(".ap-menu select")'),5000);await shot('ap-menu-engine');await click('[data-ap="engine"]');
     await click('[data-ap="more"]');await until('more menu',()=>cdp.eval('!!document.querySelector(".ap-menu")'),5000);await shot('ap-menu-more');await click('[data-ap="more"]');
     fs.writeFileSync(path.join(dir,'hub-page-done.json'),j({before,rows:await rows()},null,1));}
    // hub-page-shot：打开助理页截图，并写出 Markdown 渲染情况（表格、加粗是否成型、是否残留星号）。
    const shotSignal=path.join(dir,'hub-page-shot');
    if(fs.existsSync(shotSignal)){fs.unlinkSync(shotSignal);
     if(!await cdp.eval('!!document.querySelector(".assistant-page:not([hidden])")'))await click('#btn-assistant');
     await until('assistant page open',()=>cdp.eval('!!document.querySelector(".assistant-page:not([hidden]) .ap-list")'),20000);await wait(800);await shot('ap-markdown');
     fs.writeFileSync(path.join(dir,'hub-page-shot.json'),j(await cdp.eval('({tables:document.querySelectorAll(".assistant-page .ap-md table").length,strong:document.querySelectorAll(".assistant-page .ap-md strong").length,stars:[...document.querySelectorAll(".assistant-page .ap-md")].filter(e=>/\\*\\*/.test(e.innerText)).length})'),null,1));}
    // hub-say：在助理页输入框按真人操作说一句话（文件内容即这句话）；hub-targets：列出当前窗口（核对通知卡片是否弹出）。
    const saySignal=path.join(dir,'hub-say');
    if(fs.existsSync(saySignal)){const text=fs.readFileSync(saySignal,'utf8').trim();fs.unlinkSync(saySignal);
     if(!await cdp.eval('!!document.querySelector(".assistant-page:not([hidden])")'))await click('#btn-assistant');
     await click('.ap-composer textarea');await cdp.send('Input.insertText',{text});for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});fs.writeFileSync(path.join(dir,'hub-say-done'),text);}
    const targetsSignal=path.join(dir,'hub-targets');
    if(fs.existsSync(targetsSignal)){fs.unlinkSync(targetsSignal);const t=await cdp.send('Target.getTargets');fs.writeFileSync(path.join(dir,'hub-targets.json'),j((t.targetInfos||[]).map(x=>({type:x.type,url:String(x.url).slice(0,120),title:x.title})),null,1));}
    // hub-page-live：助理页开着时，手机发来的消息与回复实时出现在同一条对话里。
    const liveSignal=path.join(dir,'hub-page-live');
    if(fs.existsSync(liveSignal)){fs.unlinkSync(liveSignal);
     if(!await cdp.eval('!!document.querySelector(".assistant-page:not([hidden])")'))await click('#btn-assistant');
     await until('assistant page open',()=>cdp.eval('!!document.querySelector(".assistant-page:not([hidden]) .ap-list")'),20000);await wait(600);
     const count=()=>cdp.eval('document.querySelectorAll(".assistant-page .ap-msg:not(.typing)").length'),before=await count();fs.writeFileSync(path.join(dir,'hub-page-live-ready'),String(before));
     await until('live rows',async()=>(await count())>=before+2,120000);await wait(500);await shot('ap-live');
     fs.writeFileSync(path.join(dir,'hub-page-live-done.json'),j({before,after:await count(),rows:await cdp.eval('[...document.querySelectorAll(".assistant-page .ap-msg:not(.typing)")].map(r=>r.innerText.replace(/\\s+/g," ").slice(0,100))')},null,1));}
    const signal=path.join(dir,'hub-front');
    if(fs.existsSync(signal)){const [mode,model]=fs.readFileSync(signal,'utf8').trim().split('|');fs.unlinkSync(signal);
     await click('.assistant-frontdesk');await click(`[data-front-mode="${mode}"]`+(model?`[data-front-model="${model}"]`:''));
     await until('hub front label',async()=>(await cdp.eval('document.querySelector(".assistant-frontdesk")?.dataset.mode'))===mode,10000);await shot('hub-frontdesk-'+mode);fs.writeFileSync(path.join(dir,'hub-front-done'),mode);}
    const o=await invoke('assistant:get-overview',{}),live=await meta(o.sessionId);
    fs.writeFileSync(path.join(dir,'hub-state.json'),j({profile:o.profile,frontDesk:(await invoke('assistant:front-desk',{}))?.current,assistant:o.sessionId,model:modelOf(live),effort:live?.effort,actions:(await invoke('assistant:actions',{})).actions.map(a=>({state:a.state,route:a.result?.route,sessionId:a.result?.sessionId})),phone:restart?'（重启验收中不查询，避免顺带拉起手机连接）':await invoke('assistant:phone-status',{}),finals:(await finals(o.sessionId)).slice(-6).map(r=>r.text)},null,1));
    await wait(2000);
   }
   await shot('device-final');result.passed=true;return;
  }
  const phone=phoneClient(code);
  const hello=await phone.send({type:'hello',app:'1.1.0-e2e',caps:['profile','voice_message']});
  const profile0=await until('profile after hello',async()=>(await phone.poll()).find(p=>p.type==='profile'&&p.requestId===hello),60000);
  assert.equal(profile0.current.kind,'claude');assert.equal(profile0.current.model,'claude-sonnet-5-5');assert.ok(profile0.kinds.length>=8);result.phoneProfileLabel=profile0.current.label;
  result.checks.push('手机 hello 后收到助理设置与全部后端型号表：'+profile0.current.label);
  if(!onlySwitch){
  const pcm=wavPcm(path.join(samples,'voice-dispatch.wav'));n=(await finals(assistant)).length;t=Date.now();
  const voiceId=await phone.send({type:'voice_message',pcm:pcm.toString('base64'),durationMs:Math.round(pcm.length/32)});
  const transcript=await until('auto transcript',async()=>(await phone.poll()).find(p=>p.type==='transcript'&&p.requestId===voiceId),90000);
  result.timings.voiceSeconds=+(pcm.length/32000).toFixed(1);result.timings.transcriptMs=Date.now()-t;result.voiceTranscript=transcript.text;assert.equal(transcript.auto,true);
  await until('voice received',async()=>(await phone.poll()).find(p=>p.type==='status'&&p.requestId===voiceId&&p.state==='received'),120000);
  const answer=await until('phone answer',async()=>(await phone.poll()).find(p=>p.type==='answer'&&p.requestId===voiceId),300000);
  result.timings.voiceToAnswerMs=Date.now()-t;result.voiceAnswer=answer.text;await settled(assistant);
  assert.ok(!phone.inbox.some(p=>p.type==='transcript'&&!p.auto),'没有让手机核对的转写');
  const routed=await until('routed action',async()=>(await invoke('assistant:actions',{})).actions.find(a=>a.result?.route),60000);
  result.route=routed.result.route;assert.equal(routed.result.route.kind,'codex');assert.equal(routed.result.route.model,'gpt-6-luna');assert.equal(routed.result.route.effort,'low');
  const target=routed.result.sessionId;const targetFinal=await final(target,0);result.targetAnswer=targetFinal.text;
  result.checks.push(`语音 ${result.timings.voiceSeconds} 秒：${result.timings.transcriptMs} ms 出转写（不需确认），${result.timings.voiceToAnswerMs} ms 收到助理答复；同音字转写被正确理解并按快速档交给 ${routed.result.route.label}`);await shot('02-voice-routed');

  // 4. 文字点名「Claude 中等思考」：遵从点名
  n=(await finals(assistant)).length;
  await send('新建一个会话，用 Claude 中等思考，任务是：用一句话介绍南通狼山，不要读写文件。派出后简短告诉我交给了谁。');
  await final(assistant,n);await settled(assistant);
  const named=await until('named route',async()=>(await invoke('assistant:actions',{})).actions.find(a=>a.result?.route&&a.result.sessionId!==target),120000);
  result.namedRoute=named.result.route;assert.equal(named.result.route.kind,'claude');assert.equal(named.result.route.effort,'medium');
  const namedMeta=await meta(named.result.sessionId);assert.equal(namedMeta.effort,'medium');const namedFinal=await final(named.result.sessionId,0);result.namedAnswer=namedFinal.text;assert.match(namedFinal.text,/狼山/);result.checks.push('点名「Claude 中等思考」被遵从：'+named.result.route.label);

  }
  // 5. 手机切换助理模型：Codex GPT-6 Luna · 低 → 回到 Claude Opus 5.5 · 中（同一会话按新模型重启）
  const toCodex=await phone.send({type:'set_profile',kind:'codex',model:'gpt-6-luna',effort:'low'});
  const p1=await until('codex profile',async()=>(await phone.poll()).find(p=>p.type==='profile'&&p.requestId===toCodex)||phone.inbox.find(p=>p.type==='status'&&p.requestId===toCodex&&p.state==='rejected'),240000);
  assert.equal(p1.type,'profile',p1.text);assert.equal(p1.current.kind,'codex');assert.equal(p1.current.model,'gpt-6-luna');
  const codexAssistant=(await invoke('assistant:get-overview',{})).sessionId;const cm=await meta(codexAssistant);assert.equal(cm.kind,'codex');assert.equal(modelOf(cm),'gpt-6-luna');assert.equal(cm.effort,'low');
  result.checks.push('手机切换助理到 Codex GPT-6 Luna · 低，无需重新配对');
  const toOpus=await phone.send({type:'set_profile',kind:'claude',model:'claude-opus-5-5',effort:'medium'});
  const p2=await until('opus profile',async()=>(await phone.poll()).find(p=>p.type==='profile'&&p.requestId===toOpus)||phone.inbox.find(p=>p.type==='status'&&p.requestId===toOpus&&p.state==='rejected'),240000);
  assert.equal(p2.type,'profile',p2.text);assert.equal(p2.current.model,'claude-opus-5-5');assert.equal(p2.current.effort,'medium');
  const om=await meta(assistant);assert.equal(modelOf(om),'claude-opus-5-5');assert.equal(om.effort,'medium');
  n=(await finals(assistant)).length;const ask=await phone.send({type:'text',text:'你刚才把狼山的任务交给了谁？一句话回答。'});
  const recall=await until('recall answer',async()=>(await phone.poll()).find(p=>p.type==='answer'&&p.requestId===ask),300000);result.recallAnswer=recall.text;
  assert.equal((await meta(assistant)).ccSessionId,m0.ccSessionId||(await meta(assistant)).ccSessionId);
  result.checks.push('手机切回 Claude 并改为 Opus 5.5 · 中：同一助理会话按新模型重启后继续回答');await shot('03-profile-switched');
  // 恢复默认，便于人工复查
  const back=await phone.send({type:'set_profile',kind:'claude',model:'claude-sonnet-5-5',effort:'low'});
  await until('back to default',async()=>(await phone.poll()).find(p=>p.type==='profile'&&p.requestId===back),240000);
  assert.equal(hash(codexAuth),before.codex);assert.equal(hash(claudeAuth),before.claude);result.productionCredentialsUnchanged=true;result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;if(cdp){result.sessionDiagnostics=await cdp.eval('[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status,purpose:s.purpose,model:s.currentModel?.id||s.model,effort:s.effort,cliRuntime:s.cliRuntime}))').catch(()=>null);for(const m of result.sessionDiagnostics||[])result['screen-'+m.id]=await screen(m.id).catch(()=>null);result.phoneStatus=await invoke('assistant:phone-status',{}).catch(()=>null);await shot('failure').catch(()=>{});}}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));try{result.exit=await gracefulQuit(hub);}catch(e){result.cleanupError=e.message;result.passed=false;process.exitCode=1;}}for(const file of temporary)if(fs.existsSync(file))fs.unlinkSync(file);fs.writeFileSync(path.join(out,'result.json'),j(result,null,1));console.log(j(result,null,1));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
