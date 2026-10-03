'use strict';
// Real UI submissions and real configured providers; no fixture engines.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {AssistantFinalReaders}=require('../core/hub-assistant/final-readers');
const {nativeId}=require('../core/hub-assistant/live-history');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-all-models-')),data=path.join(root,'data'),home=path.join(root,'home'),codexHome=path.join(root,'codex'),claudeHome=path.join(root,'claude'),kimiHome=path.join(root,'kimi'),workspace=path.join(root,'workspaces');
 const geminiHome=path.join(home,'.gemini'),out=path.resolve('artifacts/assistant-all-models-live',new Date().toISOString().replace(/[:.]/g,'-'));
 for(const d of [data,home,codexHome,claudeHome,kimiHome,geminiHome,workspace,out])fs.mkdirSync(d,{recursive:true});
 const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8'));
 const provider=cfg.providers.codex,profile=provider.subscription_profiles.find(p=>p.id===provider.subscription_profile);assert(profile);
 const result={passed:false,scope:'真实隔离 Hub、真实原生后端、真实账号；界面点击和输入',root,out,checks:[],backends:[]};let hub,cdp;
 const until=async(label,read,timeout=180000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await read();if(v)return v;await wait(350);}throw Error('timeout '+label);};
 const invoke=(channel,args={})=>cdp.eval('ipcRenderer.invoke('+j(channel)+','+j(args)+')');
 const meta=id=>cdp.eval('JSON.parse(JSON.stringify(sessions.get('+j(id)+')))');
 const active=()=>cdp.eval('activeSessionId');
 const click=async selector=>{await until('clickable '+selector,()=>cdp.eval('(()=>{const e=document.querySelector('+j(selector)+');if(!e||e.disabled)return false;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(h===e||e.contains(h))})()'),60000);const p=await cdp.eval('(()=>{const r=document.querySelector('+j(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const change=async kind=>{await click('.assistant-backend');await click('[data-assistant-backend="'+kind+'"]');return until('backend '+kind,async()=>{const r=await invoke('assistant:get-overview');return r.backendKind===kind&&(await active())===r.sessionId&&!await cdp.eval('document.querySelector(".assistant-backend")?.disabled')?r.sessionId:null;});};
 const send=async text=>{assert.equal((await cdp.eval('document.querySelector(".floating-input-box").textContent')).trim(),'');await click('.floating-input-box');await cdp.send('Input.insertText',{text});await click('.floating-input-send');};
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const reader=new AssistantFinalReaders({dataDir:data});
 const finals=async id=>{const m=await meta(id);if(['qwen','deepseek-acp','glm'].includes(m.kind)){const rows=await invoke('parse-session-transcript',{hubSessionId:id,opts:{limit:80}});return (rows.turns||[]).filter(t=>t.role==='assistant'&&t.nativeOutcome==='completed');}return reader.read(m).records;};
 const final=async(id,previous=0)=>until('native final '+id,async()=>{const r=await finals(id);return r.length>previous?r.at(-1):null;},240000);
 const settled=async id=>until('settled '+id,async()=>{const m=await meta(id),o=await invoke('assistant:get-overview');return !(o.sessionId===id&&o.submissionPending)&&!['running','waiting'].includes(m.status)&&!['running','submitting'].includes(m.cliRuntime?.state);});
 const copy=(src,dst)=>{if(fs.existsSync(src))fs.cpSync(src,dst,{recursive:true});};
 const kinds=(process.env.HUB_ASSISTANT_TEST_KINDS||'codex,claude,gemini,kimi,qwen,deepseek-acp,glm,deepseek').split(',');
 try{
  copy(path.join(profile.home||path.join(os.homedir(),'.codex'),'auth.json'),path.join(codexHome,'auth.json'));
  copy(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json'),path.join(claudeHome,'.credentials.json'));
  fs.writeFileSync(path.join(claudeHome,'.claude.json'),j({hasCompletedOnboarding:true,theme:'light',skipDangerousModePermissionPrompt:true,projects:{}}));
  assert.equal(require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:claudeHome,sourceScriptsDir:path.resolve('scripts'),logger:{log(){},warn(){}}}).errors.length,0);
  fs.writeFileSync(path.join(codexHome,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n'+[workspace,path.resolve('.')].map(p=>"[projects.'"+p.toLowerCase()+"']\ntrust_level = \"trusted\"").join('\n')+'\n');
  for(const name of ['oauth_creds.json','google_accounts.json','installation_id','trustedFolders.json'])copy(path.join(os.homedir(),'.gemini',name),path.join(geminiHome,name));
  const geminiSettings=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.gemini/settings.json'),'utf8'));delete geminiSettings.mcpServers;geminiSettings.general={...geminiSettings.general,disableAutoUpdate:true,enableAutoUpdate:false,enableAutoUpdateNotification:false};fs.writeFileSync(path.join(geminiHome,'settings.json'),j(geminiSettings));
  for(const name of ['config.toml','device_id','credentials'])copy(path.join(os.homedir(),'.kimi-code',name),path.join(kimiHome,name));
  fs.writeFileSync(path.join(kimiHome,'mcp.json'),j({mcpServers:{}}));
  const acp=structuredClone(cfg.acp);acp.providers.qwen.model='qwen3.8-flash';acp.providers['deepseek-acp'].model='deepseek-v4-flash-0731';
  fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{codex:'gpt-6.1-sol',claude:'claude-haiku-4-5-20251001',gemini:'gemini-2.5-flash',kimi:'kimi-code/k3',qwen:'qwen3.8-flash','deepseek-acp':'deepseek-v4-flash-0731',glm:'glm-5.2',deepseek:'deepseek-v4-flash'}},acp,providers:{deepseek:cfg.providers.deepseek,codex:{backend:'subscription',subscription_profile:profile.id,subscription_profiles:[{id:profile.id,label:profile.label,home:codexHome}]}}}));
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const launchOptions={dataDir:data,port,windowMode:'background',label:'assistant-all-models-live',allowExternalState:true,extraEnv:{CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:claudeHome,CODEX_HOME:codexHome,GEMINI_CLI_HOME:home,KIMI_CODE_HOME:kimiHome,CODEX_SQLITE_HOME:'',CLAUDE_HUB_AGENT_RUNTIME:'pty',HUB_CODEX_BACKEND:'subscription',HUB_CODEX_PROFILE:'',CLAUDE_HUB_NO_FAST:'1',CLAUDE_HUB_E2E:'1',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:'',CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:'',CLAUDE_HUB_NATIVE_FIXTURE_STORE:'',OPENAI_API_KEY:'',CODEX_API_KEY:'',ANTHROPIC_API_KEY:'',DEEPSEEK_API_KEY:'',AI_HUB_WORKSPACE_ROOT:workspace,HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty')}};
  hub=await launchIsolatedHub(launchOptions);result.pid=hub.pid;cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
  if(await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');
  await click('#btn-assistant');await until('initial assistant',async()=>{const r=await invoke('assistant:get-overview');return r.available;});
  let first=true;
  for(const kind of kinds){
   const row={kind,passed:false};result.backends.push(row);console.log(j({event:'backend-start',kind}));
   try{
    const id=(await invoke('assistant:get-overview')).backendKind===kind?await active():await change(kind);row.id=id;
    await until('ready '+kind,async()=>{if(['qwen','deepseek-acp','glm'].includes(kind))return (await meta(id)).nativeRuntime?.connection==='connected';const text=await cdp.eval('(()=>{const t=terminalCache.get('+j(id)+')?.terminal;if(!t)return "";const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||"").join(" ")})()');if(/client is no longer supported|OAuth login expired|No active session|requires login/.test(text))throw Error('provider authentication unavailable: '+text.match(/(?:Failed to sign in\.|OAuth login expired|No active session|requires login).{0,260}/)?.[0]);return /Ask Codex|Claude Code|Type your|context:|❯|>>>/.test(text);},120000);
    if(kind==='codex'){await click('.composer-thinking');await click('.effort-picker-menu [data-effort="low"]');await until('low effort',async()=>{const m=await meta(id);return m.effort==='low'&&!m._modelSwitchPending;});}
    const previous=(await finals(id)).length,started=Date.now();
    await send(first?'请先读取本轮资料。记住验收暗号“杉树企鹅”，仅用一句话确认。':'请读取本轮资料中的 assistantContinuity。刚刚我告诉上一位助理的验收暗号是什么？仅用一句话回答。');
    const answer=await final(id,previous);assert.match(answer.text,/杉树企鹅/);row.answer=answer.text;row.elapsedMs=Date.now()-started;await settled(id);
    assert.equal((await invoke('assistant:get-overview')).contextCoverage.snapshotRead,true);
    row.nativeId=nativeId(await meta(id));row.model=(await meta(id)).currentModel;await shot(kind+'-handoff');
    row.passed=true;first=false;result.checks.push(kind+' 真实资料读取、跨后端交接与最终回答');
   }catch(error){row.error=error.message;await shot(kind+'-failure').catch(()=>{});if((await invoke('assistant:get-overview')).submissionPending){result.blockedAt=kind;throw error;}}
   console.log(j({event:'backend-result',kind,passed:row.passed,elapsedMs:row.elapsedMs}));
  }
  result.passed=result.backends.every(row=>row.passed);if(!result.passed)process.exitCode=1;
 }catch(e){result.error=e.stack;process.exitCode=1;if(cdp){result.sessionDiagnostics=await cdp.eval('[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status,purpose:s.purpose,cliRuntime:s.cliRuntime,transcriptPath:s.transcriptPath}))').catch(()=>null);await shot('failure').catch(()=>{});}}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));try{result.exit=await gracefulQuit(hub);}catch(e){result.cleanupError=e.message;result.passed=false;process.exitCode=1;}}
  for(const file of [path.join(codexHome,'auth.json'),path.join(claudeHome,'.credentials.json'),path.join(geminiHome,'oauth_creds.json'),path.join(geminiHome,'google_accounts.json'),path.join(kimiHome,'config.toml'),path.join(data,'config.json')])if(fs.existsSync(file))fs.unlinkSync(file);
  const credentials=path.join(kimiHome,'credentials');if(fs.existsSync(credentials)&&path.resolve(credentials).startsWith(path.resolve(root)+path.sep))fs.rmSync(credentials,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),j(result));console.log(j({passed:result.passed,out,backends:result.backends.map(r=>({kind:r.kind,passed:r.passed,error:r.error})),error:result.error}));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
