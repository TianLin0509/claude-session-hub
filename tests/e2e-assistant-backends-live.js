'use strict';
// Real subscription CLIs. Backend changes, input and answers use the ordinary
// native session UI. No fixture engines or synthetic runtime state.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {readFinals}=require('../core/hub-assistant/live-history');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-backends-live-')),data=path.join(root,'data'),home=path.join(root,'home'),codexHome=path.join(root,'codex'),claudeHome=path.join(root,'claude'),workspace=path.join(root,'workspaces');
 const out=path.resolve('artifacts/assistant-backends-live',new Date().toISOString().replace(/[:.]/g,'-'));
 for(const d of [data,home,codexHome,claudeHome,workspace,out])fs.mkdirSync(d,{recursive:true});
 const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8')),provider=cfg.providers.codex;
 const profile=provider.subscription_profiles.find(p=>p.id===provider.subscription_profile);assert(profile);assert.equal(provider.backend,'subscription');
 const codexAuth=path.join(profile.home||path.join(os.homedir(),'.codex'),'auth.json'),claudeAuth=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json');
 const before={codex:hash(codexAuth),claude:hash(claudeAuth)};
 const result={passed:false,scope:'真实隔离 Hub、真实 Codex 与 Claude PTY、真实订阅账号；非模拟',root,out,profile:profile.id,checks:[]};let hub,cdp;
 const until=async(label,read,timeout=180000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await read();if(v)return v;await wait(250);}throw Error('timeout '+label);};
 const invoke=(channel,args)=>cdp.eval('ipcRenderer.invoke('+j(channel)+','+j(args)+')');
 const meta=id=>cdp.eval('JSON.parse(JSON.stringify(sessions.get('+j(id)+')))');
 const active=()=>cdp.eval('activeSessionId');
 const screen=id=>cdp.eval('(()=>{const t=terminalCache.get('+j(id)+')?.terminal;if(!t)return "";const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||"").join(String.fromCharCode(10))})()');
 const click=async selector=>{await until('clickable '+selector,()=>cdp.eval('(()=>{const e=document.querySelector('+j(selector)+');if(!e||e.disabled)return false;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(h===e||e.contains(h))})()'),60000);const p=await cdp.eval('(()=>{const r=document.querySelector('+j(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const key=async(key,code,virtualKey,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:virtualKey,modifiers});};
 const change=async kind=>{await until('picker enabled',()=>cdp.eval('!!document.querySelector(".assistant-backend")&&!document.querySelector(".assistant-backend").disabled'));await cdp.eval('document.querySelector(".assistant-backend").focus()');await key(kind==='claude'?'End':'Home',kind==='claude'?'End':'Home',kind==='claude'?35:36);await key('Enter','Enter',13);await until('backend '+kind,async()=>{const r=await invoke('assistant:get-overview',{});return r.backendKind===kind&&(await active())===r.sessionId&&!await cdp.eval('document.querySelector(".assistant-backend")?.disabled')?r.sessionId:null;});};
 const send=async text=>{assert.equal(await cdp.eval('document.querySelector(".floating-input-box").textContent'),'');await click('.floating-input-box');await cdp.send('Input.insertText',{text});await click('.floating-input-send');};
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const final=async(id,previous=0)=>until('native final '+id,async()=>{const r=readFinals(await meta(id)).records;return r.length>previous?r.at(-1):null;});
 const settled=async id=>until('settled '+id,async()=>{const m=await meta(id);return !['running','waiting'].includes(m.status)&&!['running','submitting'].includes(m.cliRuntime?.state);});
 try{
  fs.copyFileSync(codexAuth,path.join(codexHome,'auth.json'));fs.copyFileSync(claudeAuth,path.join(claudeHome,'.credentials.json'));
  fs.writeFileSync(path.join(claudeHome,'.claude.json'),j({hasCompletedOnboarding:true,theme:'light',skipDangerousModePermissionPrompt:true,projects:{}}));
  fs.writeFileSync(path.join(codexHome,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n'+[workspace,path.resolve('.')].map(p=>"[projects.'"+p.toLowerCase()+"']\ntrust_level = \"trusted\"").join('\n')+'\n');
  fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{codex:'gpt-6.1-sol',claude:'claude-haiku-4-5-20251001'}},providers:{codex:{backend:'subscription',subscription_profile:profile.id,subscription_profiles:[{id:profile.id,label:profile.label,home:codexHome}]}}}));
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,windowMode:'background',label:'assistant-backends-live',allowExternalState:true,extraEnv:{CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:claudeHome,CODEX_HOME:codexHome,CODEX_SQLITE_HOME:'',CLAUDE_HUB_AGENT_RUNTIME:'pty',HUB_CODEX_BACKEND:'subscription',HUB_CODEX_PROFILE:'',CLAUDE_HUB_NO_FAST:'1',CLAUDE_HUB_E2E:'1',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:'',CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:'',CLAUDE_HUB_NATIVE_FIXTURE_STORE:'',OPENAI_API_KEY:'',CODEX_API_KEY:'',ANTHROPIC_API_KEY:'',DEEPSEEK_API_KEY:'',AI_HUB_WORKSPACE_ROOT:workspace,HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty')}});
  result.pid=hub.pid;cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
  if(await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');
  await click('#btn-assistant');const codex=await until('codex active',async()=>{const r=await invoke('assistant:get-overview',{});return r.available?r.sessionId:null;});result.codexId=codex;
  await until('codex ready',async()=>/Ask Codex to do anything/.test(await screen(codex)));
  await click('.composer-thinking');await click('.effort-picker-menu [data-effort="low"]');await until('effort low',async()=>{const m=await meta(codex);return m.effort==='low'&&!m._modelSwitchPending;});
  await send('请先读取本轮资料。记住验收暗号“青桥企鹅”，仅用一句话确认。');const codexAnswer=await final(codex);assert.match(codexAnswer.text,/青桥企鹅/);await settled(codex);result.checks.push('Codex 真实读取 Hub 资料并回答');
  result.codexNativeId=(await meta(codex)).codexSid;
  await click('.floating-input-box');await cdp.send('Input.insertText',{text:'待发草稿不要发送'});
  await change('claude');const claude=await active();result.claudeId=claude;assert.notEqual(codex,claude);
  await until('claude ready',async()=>/❯|Try|Claude Code/.test(await screen(claude)));
  assert.equal(await cdp.eval('document.querySelector(".floating-input-box").textContent'),'');
  await send('请读取本轮资料中的 assistantContinuity。刚刚我告诉上一位助理的验收暗号是什么？仅用一句话回答。');const claudeAnswer=await final(claude);assert.match(claudeAnswer.text,/青桥企鹅/);await settled(claude);
  await until('visible claude final',()=>cdp.eval('document.querySelector("#msg-overlay")?.textContent.includes("青桥企鹅")'));
  const context=await invoke('assistant:get-overview',{});assert.equal(context.contextCoverage.snapshotRead,true);result.checks.push('Claude 真实 MCP 读取冻结资料，接续 Codex 交接记录，普通卡片显示回答');result.claudeNativeId=(await meta(claude)).ccSessionId;await shot('01-claude-handoff');
  await change('codex');assert.equal(await active(),codex);assert.equal((await meta(codex)).codexSid,result.codexNativeId);assert.equal(await cdp.eval('document.querySelector(".floating-input-box").textContent'),'待发草稿不要发送');
  await click('.floating-input-box');await key('a','KeyA',65,2);await key('Backspace','Backspace',8);result.checks.push('返回 Codex 恢复同一原生会话和未发送草稿');
  await change('claude');assert.equal(await active(),claude);assert.equal((await meta(claude)).ccSessionId,result.claudeNativeId);
  const previous=readFinals(await meta(claude)).records.length;
  await send('新建一个 Codex Session，标题为“后端切换业务验收”，任务是：只回复“业务验收完成”，无需读写文件。请在派工后使用 watch_session 关注该新会话，有新回复时提醒我。提交确认后立即简短答复我。');
  const delegation=await final(claude,previous);result.delegationAnswer=delegation.text;await settled(claude);
  const action=await until('dispatch confirmed',async()=>{const r=await invoke('assistant:actions',{});return r.actions.find(a=>a.state==='acknowledged');});result.dispatch=action;
  const target=action.result.sessionId;assert(target);result.targetId=target;
  await final(target);const notices=await until('watch notification',async()=>{const r=await invoke('assistant:notifications',{});return r.notifications?.find(n=>n.sessionId===target||n.source?.sessionId===target);});result.notification=notices;result.checks.push('Claude 助理实际创建 Codex 业务会话、提交确认、关注并收到真实新回复通知');await shot('02-claude-delegation');
  const packet=await invoke('assistant:context',{});assert(!packet.workbench.inventory.some(s=>[codex,claude].includes(s.id)));assert.equal(packet.workbench.inventory.find(s=>s.id===target).hubState.isActive,false);assert(packet.assistantContinuity.records.some(r=>r.text.includes('青桥企鹅')));
  await change('codex');await send('请查最新资料：“后端切换业务验收”是否已经回复？用一句白话告诉我。');const answered=await final(codex,1);assert.match(answered.text,/业务验收完成|已.*回复|已.*完成/);await until('visible codex final',()=>cdp.eval('document.querySelector("#msg-overlay")?.textContent.includes('+j(answered.text.trim().split('\n').at(-1))+')'));result.finalAnswer=answered.text;await shot('03-codex-return');result.checks.push('切回 Codex 仍可查业务进展，两种助理均不被计为业务会话');
  assert.equal(hash(codexAuth),before.codex);assert.equal(hash(claudeAuth),before.claude);result.productionCredentialsUnchanged=true;result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;if(cdp){result.sessionDiagnostics=await cdp.eval('[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status,purpose:s.purpose,cliRuntime:s.cliRuntime,transcriptPath:s.transcriptPath}))').catch(()=>null);for(const m of result.sessionDiagnostics||[])result[m.kind+'Screen']=await screen(m.id).catch(()=>null);await shot('failure').catch(()=>{});}}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}for(const file of [path.join(codexHome,'auth.json'),path.join(claudeHome,'.credentials.json')])if(fs.existsSync(file))fs.unlinkSync(file);fs.writeFileSync(path.join(out,'result.json'),j(result));console.log(j(result));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
