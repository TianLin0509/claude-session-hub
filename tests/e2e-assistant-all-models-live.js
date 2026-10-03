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
 const final=async(id,previous=0)=>until('native final '+id,async()=>{const r=await finals(id);if(r.length>previous)return r.at(-1);const text=await cdp.eval('document.body.innerText');const error=text.match(/(?:\[provider\.api_error\]\s*403|Error: 403|Your current subscription does not have access)[^\n]{0,300}/);if(error)throw Error('provider request rejected: '+error[0]);return null;},240000);
 const settled=async id=>until('settled '+id,async()=>{const m=await meta(id),o=await invoke('assistant:get-overview');return !(o.sessionId===id&&o.submissionPending)&&!['running','waiting'].includes(m.status)&&!['running','submitting'].includes(m.cliRuntime?.state);});
 const copy=(src,dst)=>{if(fs.existsSync(src))fs.cpSync(src,dst,{recursive:true});};
 const kinds=(process.env.HUB_ASSISTANT_TEST_KINDS||'codex,claude,gemini,kimi,qwen,deepseek-acp,glm,deepseek').split(',');
 try{
  copy(path.join(profile.home||path.join(os.homedir(),'.codex'),'auth.json'),path.join(codexHome,'auth.json'));
  copy(path.join(profile.home||path.join(os.homedir(),'.codex'),'models_cache.json'),path.join(codexHome,'models_cache.json'));
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
    await until('ready '+kind,async()=>{if(['qwen','deepseek-acp','glm'].includes(kind)){const m=await meta(id),runtime=m.cliRuntime||m.nativeRuntime;if(runtime?.connection==='disconnected')throw Error('provider connection failed: '+runtime.reason);return runtime?.connection==='connected'&&!!m.acpSid;}const text=await cdp.eval('(()=>{const t=terminalCache.get('+j(id)+')?.terminal;if(!t)return "";const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||"").join(" ")})()');if(/client is no longer supported|OAuth login expired|No active session|requires login/.test(text))throw Error('provider authentication unavailable: '+text.match(/(?:Failed to sign in\.|OAuth login expired|No active session|requires login).{0,260}/)?.[0]);return /Ask Codex|Claude Code|Type your|context:|❯|>>>/.test(text);},120000);
    if(kind==='codex'&&process.env.HUB_ASSISTANT_KEEP_EFFORT!=='1'){await click('.composer-thinking');await click('.effort-picker-menu [data-effort="low"]');await until('low effort',async()=>{const m=await meta(id);return m.effort==='low'&&!m._modelSwitchPending;});}
    const previous=(await finals(id)).length,started=Date.now();
    await send(first?'请先读取本轮资料。记住验收暗号“杉树企鹅”，仅用一句话确认。':'请读取本轮资料中的 assistantContinuity。刚刚我告诉上一位助理的验收暗号是什么？仅用一句话回答。');
    const answer=await final(id,previous);assert.match(answer.text,/杉树企鹅/);row.answer=answer.text;row.elapsedMs=Date.now()-started;await settled(id);
    assert.equal((await invoke('assistant:get-overview')).contextCoverage.snapshotRead,true);
    row.nativeId=nativeId(await meta(id));row.model=(await meta(id)).currentModel;await shot(kind+'-handoff');
    if(kind==='qwen'&&process.env.HUB_ASSISTANT_MODEL_SWITCHES==='1'){
      await click('.composer-model');await click('.model-picker-item[data-model-id="qwen3.7-plus"]');
      await until('qwen model change',async()=>{const m=await meta(id);return m.currentModel?.id==='qwen3.7-plus'&&!m._modelSwitchPending;},30000);
      const beforeModelAnswer=(await finals(id)).length;
      await send('请读取本轮资料，用一句话说出刚才的验收暗号。');
      assert.match((await final(id,beforeModelAnswer)).text,/杉树企鹅/);await settled(id);
      assert.equal(nativeId(await meta(id)),row.nativeId);assert.equal((await meta(id)).currentModel.id,'qwen3.7-plus');
      row.modelAfterSwitch=(await meta(id)).currentModel;await shot(kind+'-model-change');
      result.checks.push('千问普通模型菜单真实切换到 qwen3.7-plus，同一原生会话继续读取资料并回答');
    }
    if(kind==='deepseek'&&process.env.HUB_ASSISTANT_MODEL_SWITCHES==='1'){
      await click('.composer-model');await click('.model-picker-item[data-model-id="deepseek-v4-pro"]');
      await until('DeepSeek Pro native selection',async()=>{const m=await meta(id);return m.currentModel?.id==='deepseek-v4-pro'&&!m._modelSwitchPending;},30000);
      const beforeModelAnswer=(await finals(id)).length;
      const modelStarted=Date.now();await send('当前有哪些会话、什么进展？请实际读取本轮资料并核对 packetHash，然后用一句话说明当前会话数量和验收暗号。');row.modelSwitchAnswer=(await final(id,beforeModelAnswer)).text;assert.match(row.modelSwitchAnswer,/杉树企鹅/);await settled(id);
      row.modelReplyElapsedMs=Date.now()-modelStarted;
      assert.equal((await invoke('assistant:get-overview')).contextCoverage.snapshotRead,true,'changed model must read this turn instead of only remembering the code word');
      const rollout=fs.readFileSync((await meta(id)).transcriptPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const turnStart=rollout.findLastIndex(item=>item.type==='turn_context');
      const modelTurn=rollout.slice(turnStart);
      row.modelToolCalls=modelTurn.filter(item=>item.payload?.type==='function_call').map(item=>item.payload.name);
      row.modelToolErrors=modelTurn.filter(item=>item.payload?.type==='function_call_output'&&String(item.payload.output).startsWith('unsupported call:')).map(item=>item.payload.output);
      assert.deepEqual(row.modelToolErrors,[],'native tool calls must work without a shell/HTTP fallback');
      const readCall=modelTurn.find(item=>item.payload?.type==='function_call'&&['history_context','mcp__hub_assistant__history_context'].includes(item.payload.name));
      assert.ok(readCall,'changed model must use its registered assistant tool');
      assert.ok(modelTurn.some(item=>item.payload?.type==='function_call_output'&&item.payload.call_id===readCall.payload.call_id&&JSON.stringify(item.payload.output).includes('snapshotReceipt')),'registered tool must return the current snapshot receipt');
      assert.equal(nativeId(await meta(id)),row.nativeId);assert.equal((await meta(id)).currentModel.id,'deepseek-v4-pro');row.modelAfterSwitch=(await meta(id)).currentModel;
      await shot(kind+'-model-change');result.checks.push('DeepSeek 普通模型菜单真实切换到 V4 Pro，同一原生会话继续读取资料并回答');
    }
    if(process.env.HUB_ASSISTANT_DISPATCH==='1'){
      const beforeDispatch=(await finals(id)).length,title='验收业务-'+kind,oldActions=new Set((await invoke('assistant:actions')).actions.map(a=>a.id));
      const exactTask='只回复“业务验收完成”，无需读写任何文件。';
      await send('新建一个 Codex Session，标题为'+title+'，任务 prompt 请原样下达：'+exactTask+' 提交确认后立即简短答复我，有新回复时提醒我。');
      row.delegationAnswer=(await final(id,beforeDispatch)).text;await settled(id);
      const action=await until('confirmed '+kind+' dispatch',async()=>{const r=await invoke('assistant:actions');return r.actions.find(a=>a.state==='acknowledged'&&!oldActions.has(a.id));},60000);
      const target=action.result.sessionId;row.targetId=target;assert.equal((await meta(target)).title,title);
      assert.match((await final(target)).text,/业务验收完成/);
      const {DatabaseSync}=require('node:sqlite'),ledger=new DatabaseSync(path.join(data,'assistant','assistant.sqlite'),{readOnly:true});
      const taskPayload=JSON.parse(ledger.prepare('SELECT payload FROM actions WHERE id=?').get(action.id).payload);ledger.close();
      row.verbatimUserTask=taskPayload.text===exactTask;
      if(process.env.HUB_ASSISTANT_VERBATIM_TASK==='1')assert.equal(taskPayload.text,exactTask,'the manager must submit the requested original task');
      const targetRollout=fs.readFileSync((await meta(target)).transcriptPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const original=require('../core/hub-assistant/delegated-prompt');
      const wire=targetRollout.filter(item=>item.payload?.type==='message'&&item.payload.role==='user').map(item=>item.payload.content?.map(block=>block.text||'').join('')).find(text=>(original.delegatedPromptDisplay(text)?.userText??text)===taskPayload.text);
      assert.ok(wire,'the native record must retain the exact delegated task after decoding');row.delegatedOriginalMatched=true;
      await click('#session-list .session-item[data-session-id="'+target+'"] .sl-title');
      await until('delegated business selected',async()=>await active()===target,30000);
      await until('original delegated task card',()=>cdp.eval('(()=>{const e=document.querySelector("#msg-overlay");return !!e&&e.innerText.includes('+j(taskPayload.text)+')})()'),30000);
      row.delegatedCardMatched=true;
      await click('#btn-assistant');await until('assistant reselected',async()=>await active()===id);
      row.notification=await until('new reply notice '+kind,async()=>{const r=await invoke('assistant:notifications');return r.notifications?.find(n=>n.sessionId===target||n.source?.sessionId===target);});
      await shot(kind+'-dispatch');result.checks.push(kind+' 真实创建 Codex 业务会话、确认派工、收到新回复提醒');
    }
    row.passed=true;first=false;result.checks.push(kind+' 真实资料读取、跨后端交接与最终回答');
   }catch(error){row.error=error.message;await shot(kind+'-failure').catch(()=>{});if(kind==='codex')fs.writeFileSync(path.join(out,'codex-raw-buffer.txt'),await cdp.eval('ipcRenderer.invoke("debug:get-session-buffer",'+j(row.id)+')'));if((await invoke('assistant:get-overview')).submissionPending){result.blockedAt=kind;throw error;}}
   console.log(j({event:'backend-result',kind,passed:row.passed,elapsedMs:row.elapsedMs,error:row.error}));
  }
  result.passed=result.backends.every(row=>row.passed);if(!result.passed)process.exitCode=1;
 }catch(e){result.error=e.stack;process.exitCode=1;if(cdp){result.sessionDiagnostics=await cdp.eval('[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status,purpose:s.purpose,cliRuntime:s.cliRuntime,transcriptPath:s.transcriptPath}))').catch(()=>null);await shot('failure').catch(()=>{});}}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));try{result.exit=await gracefulQuit(hub);}catch(e){result.cleanupError=e.message;result.passed=false;process.exitCode=1;}}
  for(const file of [path.join(codexHome,'auth.json'),path.join(claudeHome,'.credentials.json'),path.join(geminiHome,'oauth_creds.json'),path.join(geminiHome,'google_accounts.json'),path.join(kimiHome,'config.toml'),path.join(data,'config.json')])if(fs.existsSync(file))fs.unlinkSync(file);
  const credentials=path.join(kimiHome,'credentials');if(fs.existsSync(credentials)&&path.resolve(credentials).startsWith(path.resolve(root)+path.sep))fs.rmSync(credentials,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),j(result));console.log(j({passed:result.passed,out,backends:result.backends.map(r=>({kind:r.kind,passed:r.passed,error:r.error})),error:result.error}));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
