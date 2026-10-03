'use strict';
// Own isolated Hub, real selected Codex subscription, real cloud relay. Android
// driver operates the actual signed App; this process only provisions and observes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('../tests/helpers/hub-launcher'),{connectFirstPage}=require('../tests/helpers/cdp-client');
const {readFinals}=require('../core/hub-assistant/live-history');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),J=JSON.stringify;
async function main(){
 const restartRoot=process.env.HUB_PHONE_RESTART_ROOT;
 if(restartRoot&&(!path.resolve(restartRoot).startsWith(path.resolve(os.tmpdir())+path.sep+'aihub-phone-live-')||!fs.existsSync(path.join(restartRoot,'data','assistant','phone','channel.bin'))))throw Error('Not an owned phone fixture');
 const root=restartRoot||fs.mkdtempSync(path.join(os.tmpdir(),'aihub-phone-live-')),data=path.join(root,'data'),home=path.join(root,'home'),codex=path.join(root,'codex'),claude=path.join(root,'claude'),workspace=path.join(root,'workspace');
 const app='C:/AIWork/20261003-aihub-assistant-android-codex1',privateDir=path.join(app,'private'),out=path.join(app,'artifacts','20261003-phone-backends-codex1');
 for(const d of[data,home,codex,claude,workspace,privateDir,out])fs.mkdirSync(d,{recursive:true});
 const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8')),p=cfg.providers.codex,profile=p.subscription_profiles.find(x=>x.id===p.subscription_profile);if(!profile||p.backend!=='subscription')throw Error('选定的 Codex 订阅不可用');
 const auth=path.join(profile.home||path.join(os.homedir(),'.codex'),'auth.json'),before=crypto.createHash('sha256').update(fs.readFileSync(auth)).digest('hex');
 let hub,cdp,stop=false;const result={scope:'真实 Android 模拟器＋正式签名 APK＋真实云中继＋隔离 Hub＋真实 Codex / ASR',passed:false,profile:profile.id,root};
 try{
  fs.copyFileSync(auth,path.join(codex,'auth.json'));const cache=path.join(path.dirname(auth),'models_cache.json');if(fs.existsSync(cache))fs.copyFileSync(cache,path.join(codex,'models_cache.json'));
  fs.writeFileSync(path.join(codex,'config.toml'),'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n'+[workspace,path.resolve('.')].map(x=>"[projects.'"+x.toLowerCase()+"']\ntrust_level = \"trusted\"").join('\n')+'\n');
  const claudeAuth=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json');
  if(fs.existsSync(claudeAuth))fs.copyFileSync(claudeAuth,path.join(claude,'.credentials.json'));
  fs.writeFileSync(path.join(claude,'.claude.json'),J({hasCompletedOnboarding:true,theme:'light',skipDangerousModePermissionPrompt:true,projects:{}}));
  require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:claude,sourceScriptsDir:path.resolve('scripts'),logger:{log(){},warn(){}}});
  const acp=structuredClone(cfg.acp);acp.providers.qwen.model='qwen3.8-flash';acp.providers['deepseek-acp'].model='deepseek-v4-flash-0731';
  fs.writeFileSync(path.join(data,'config.json'),J({models:{defaults:{codex:'gpt-6-luna',claude:'claude-haiku-4-5-20251001',qwen:'qwen3.8-flash','deepseek-acp':'deepseek-v4-flash-0731',deepseek:'deepseek-v4-flash'}},acp,providers:{deepseek:cfg.providers.deepseek,codex:{backend:'subscription',subscription_profile:profile.id,subscription_profiles:[{id:profile.id,label:profile.label,home:codex}]}}}));
  const voice=path.join(os.homedir(),'.claude-session-hub/voice-input.json');if(fs.existsSync(voice))fs.copyFileSync(voice,path.join(data,'voice-input.json'));
  const original=path.join(workspace,'phone-original.png');fs.copyFileSync(path.resolve('renderer/assets/assistant/penguin.png'),original);
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n))});});
  hub=await launchIsolatedHub({dataDir:data,port,windowMode:'background',label:'phone-real-android',allowExternalState:true,extraEnv:{CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:claude,CODEX_HOME:codex,CODEX_SQLITE_HOME:'',CLAUDE_HUB_AGENT_RUNTIME:'pty',HUB_CODEX_BACKEND:'subscription',HUB_CODEX_PROFILE:'',CLAUDE_HUB_NO_FAST:'1',CLAUDE_HUB_E2E:'1',OPENAI_API_KEY:'',CODEX_API_KEY:'',ANTHROPIC_API_KEY:'',DEEPSEEK_API_KEY:'',AI_HUB_WORKSPACE_ROOT:workspace,HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty')}});
  cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const until=async(label,fn)=>{for(let end=Date.now()+120000;Date.now()<end;){const r=await fn();if(r)return r;await sleep(250)}throw Error(label+' timeout')};
  const click=async selector=>{const point=await until(selector,()=>cdp.eval(`(()=>{const e=document.querySelector(${J(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`));for(const type of['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});};
  await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
  if(await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');
  await click('#btn-assistant');await until('assistant',()=>cdp.eval('document.body.classList.contains("assistant-session-active")'));
  if(!restartRoot){
  await click('.assistant-phone');await click('[data-phone="pair"]');
  const code=await until('real relay registered',()=>cdp.eval('document.querySelector(".phone-code")?.value||null'));
  fs.writeFileSync(path.join(privateDir,'connect.txt'),code,{mode:0o600});
  await click('[data-phone="close"]');
  }
  const o=await cdp.eval('ipcRenderer.invoke("assistant:get-overview")');
  result.sessionId=o.sessionId;result.hubPid=hub.pid;result.cdpPort=port;result.originalImage=original;
  fs.writeFileSync(path.join(privateDir,'runtime.json'),J(result));
  console.log(J({event:'real-cloud-hub-ready',profile:profile.id,hubPid:hub.pid,sessionId:o.sessionId,privateSetupPrepared:true}));
  process.on('SIGINT',()=>{stop=true});process.on('SIGTERM',()=>{stop=true});
  const end=Date.now()+3*3600000;let oldCount=-1;
  while(!stop&&Date.now()<end&&!fs.existsSync(path.join(privateDir,'stop-hub'))){
   const commandFile=path.join(privateDir,'backend-command.json');
   if(fs.existsSync(commandFile)){
    const command=JSON.parse(fs.readFileSync(commandFile,'utf8'));fs.unlinkSync(commandFile);
    try{
      await click('.assistant-backend');await click('[data-assistant-backend="'+command.kind+'"]');
      await until('selected backend',async()=>{const state=await cdp.eval('ipcRenderer.invoke("assistant:get-overview")');return state.backendKind===command.kind&&!await cdp.eval('document.querySelector(".assistant-backend")?.disabled');});
      fs.writeFileSync(path.join(out,'backend-selected.json'),J({ok:true,kind:command.kind,overview:await cdp.eval('ipcRenderer.invoke("assistant:get-overview")')}));
    }catch(e){fs.writeFileSync(path.join(out,'backend-selected.json'),J({ok:false,error:e.message,kind:command.kind}));}
   }
   const o=await cdp.eval('ipcRenderer.invoke("assistant:get-overview")');
   fs.writeFileSync(path.join(out,'overview.json'),J(o));
   const meta=await cdp.eval('JSON.parse(JSON.stringify(sessions.get('+J(o.sessionId)+')))');
   const raw=await cdp.eval('ipcRenderer.invoke("debug:get-session-buffer",'+J(o.sessionId)+')');fs.writeFileSync(path.join(privateDir,'codex-raw.txt'),String(raw||''));fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
   if(meta){const parsed=await cdp.eval('ipcRenderer.invoke("parse-session-transcript",'+J({hubSessionId:o.sessionId,opts:{limit:80}})+')');const finals=parsed.turns||[];fs.writeFileSync(path.join(out,'native-final-evidence.json'),J(finals));if(finals.length!==oldCount){oldCount=finals.length;console.log(J({event:'native-finals',count:finals.length,turnIds:finals.map(x=>x.turnId)}));}}
   fs.writeFileSync(path.join(out,'phone-status.json'),J(await cdp.eval('ipcRenderer.invoke("assistant:phone-status")')));await sleep(1000);
  }
  result.productionAuthUnchanged=crypto.createHash('sha256').update(fs.readFileSync(auth)).digest('hex')===before;result.fixtureClosedSafely=result.productionAuthUnchanged;result.passed=false;
 }catch(e){result.error=e.stack;process.exitCode=1;}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub)}for(const file of[path.join(codex,'auth.json'),path.join(claude,'.credentials.json'),path.join(data,'config.json'),path.join(data,'voice-input.json')])if(fs.existsSync(file))fs.unlinkSync(file);fs.writeFileSync(path.join(out,'hub-runtime-result.json'),J(result));console.log(J({event:'isolated-hub-ended',passed:result.passed,exit:result.exit,error:result.error}));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
