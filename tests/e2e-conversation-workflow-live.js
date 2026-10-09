'use strict';
// Two successive natural inputs through real subscribed PTY Codex -> Claude.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-conversation-live-')),DATA=path.join(ROOT,'data'),ART=path.resolve('artifacts/20261009-conversation-live-codex1');fs.mkdirSync(ART,{recursive:true});
const secrets=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
function profiles(){
 const env={CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_HUB_HOME_DIR:path.join(ROOT,'home'),AI_HUB_WORKSPACE_ROOT:ROOT,DEEPSEEK_API_KEY:''};
 const accounts=require('../core/codex-global-account'),codexSource=accounts.resolveAccount(accounts.currentConfig()).home;
 for(const [key,source,names] of [['CODEX_HOME','.codex',['auth.json','config.toml','models_cache.json']],['CLAUDE_CONFIG_DIR','.claude',['.credentials.json','settings.json']]]){
  const dest=path.join(ROOT,source.slice(1));fs.mkdirSync(dest,{recursive:true});env[key]=dest;
  for(const name of names){const original=path.join(key==='CODEX_HOME'?codexSource:path.join(os.homedir(),source),name),target=path.join(dest,name);if(fs.existsSync(original)){fs.copyFileSync(original,target);secrets.push(target);}}
 }
 const state=path.join(os.homedir(),'.claude.json');if(fs.existsSync(state)){const dest=path.join(env.CLAUDE_CONFIG_DIR,'.claude.json');fs.copyFileSync(state,dest);secrets.push(dest);}
 const settings=path.join(env.CLAUDE_CONFIG_DIR,'settings.json');if(fs.existsSync(settings)){const s=JSON.parse(fs.readFileSync(settings,'utf8'));delete s.hooks;delete s.enabledPlugins;delete s.statusLine;fs.writeFileSync(settings,JSON.stringify(s),'utf8');}
 const hooks=require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:env.CLAUDE_CONFIG_DIR,sourceScriptsDir:path.resolve('scripts'),logger:{log(){}},settingsOptions:{manageStatusLine:false,managePermissionMode:false}});
 assert.equal(hooks.errors.length,0,'isolated Claude must receive the same lifecycle hooks as normal Hub sessions');
 return env;
}
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{let hub,c,id;const e={passed:false,realModel:true,runtime:'pty',root:ROOT,cycles:[]};
 const invoke=(channel,args={})=>c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
 const wait=async(label,pred,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await pred();if(r)return r;await delay(500);}throw Error('Timeout: '+label);};
 const click=async selector=>{const p=await wait(selector,()=>c.eval(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`));for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const send=async input=>{await click('#mr-input-box');await c.send('Input.insertText',{text:input});for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
 try{
  const workspace=path.join(ROOT,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'AGENTS.md'),'# Isolated group conversation test\nAnswer only the current simple question in two short Chinese sentences. Write the assigned ordinary group answer file. No code, repository, network, research or subagents.\n','utf8');
  hub=await launchIsolatedHub({dataDir:DATA,port:await port(),windowMode:'hidden',label:'conversation-live',extraEnv:profiles()});c=await connectFirstPage(hub);await wait('renderer',()=>c.eval('!!window.MeetingRoom'));
  const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'真实按顺序发言：Codex → Claude',workspace,slots:[{index:0,memberId:'m1',kind:'claude',model:'claude-opus-5-5[1m]',effort:'high',fastMode:false,mcpProfile:'none'},{index:1,memberId:'m2',kind:'codex',model:'gpt-6.1-sol',effort:'high',mcpProfile:'none'}]});id=m.id;e.models=m.slotSpecs;e.sessions=m.subSessions;
  const configured=await invoke('workflow:configure',{meetingId:id,expectedRevision:m.serialWorkflow?.settingsRevision||0,draft:{kind:'serial',presetId:'custom',enabled:true,rounds:[{name:'Codex 先回答',members:['m2'],prompt:'',after:'next'},{name:'Claude 接着说',members:['m1'],prompt:'',after:'end'}]}});assert(configured.ok,configured.reason);assert.equal(configured.config.conversationVersion,1);
  await click(`[data-meeting-id="${id}"] .sl-title`);await wait('conversation composer',()=>c.eval(`!!document.querySelector('.mr-conversation-flow')`));
  let previousTurns=new Set();
  for(const input of ['Codex 先用两句话解释 1+1=2；Claude 接着说，明确回应 Codex 的观点并补充一个核对。','这次请讨论 2+2=4：Codex 先说，Claude 接着回应 Codex 的观点；每位仍只写两句话。']){
   await send(input);
   const status=await wait('two real speeches',async()=>{const s=await invoke('loop:status',{meetingId:id});if(s.serialRunState?.status==='paused')throw Error(JSON.stringify(s.serialRunState.lastError));return !s.running&&s.serialRunState?.status==='done'&&s.serialRunState?.goal===input?s:null;},420000);
   const state=await invoke('groupchat:get-state',{meetingId:id});
   const entries=Object.entries(state.answerFiles||{}).filter(([turn])=>!previousTurns.has(turn));
   const answers=entries.flatMap(([turn,by])=>Object.values(by).map(a=>({turn:Number(turn),member:a.memberId,path:a.ready,text:fs.readFileSync(a.ready,'utf8')}))).sort((a,b)=>a.turn-b.turn);
   assert.equal(answers.length,2);assert.deepEqual(answers.map(a=>a.member),['m2','m1']);assert(answers.every(a=>a.text.trim()));assert(answers[1].text.includes('Codex'),'Claude explicitly responds to preceding Codex');
   assert(!fs.existsSync(path.join(DATA,'task-docs',id,'deliveries')));e.cycles.push({input,status,answers});previousTurns=new Set(Object.keys(state.answerFiles));console.log('PASS real Codex -> Claude: '+input);
  }
  assert.equal(e.cycles[0].status.serialRunState.runId===e.cycles[1].status.serialRunState.runId,false);e.passed=true;
 }catch(error){
  e.error=error.stack;
  if(c&&id)try{e.status=await invoke('loop:status',{meetingId:id});e.ui=await c.eval('document.body.innerText.slice(-12000)');}catch(diagnosticError){e.diagnosticError=diagnosticError.message;}
  throw error;
 }
 finally{
  const cleanupErrors=[];
  if(c){
   try{const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(ART,'live.png'),Buffer.from(shot.data,'base64'));}catch(error){cleanupErrors.push('screenshot: '+error.message);}
   try{await c.close();}catch(error){cleanupErrors.push('CDP close: '+error.message);}
  }
  if(hub){try{e.quit=await gracefulQuit(hub);if(e.quit.exitCode!==0||e.quit.forced)cleanupErrors.push('test Hub did not close gracefully');}catch(error){cleanupErrors.push('Hub close: '+error.message);}e.logs=hub.log();}
  for(const file of secrets)try{if(fs.existsSync(file))fs.unlinkSync(file);}catch(error){cleanupErrors.push('isolated credential cleanup: '+error.message);}
  e.temporaryCredentialsRemoved=secrets.every(file=>!fs.existsSync(file));
  if(cleanupErrors.length){e.cleanupErrors=cleanupErrors;e.passed=false;process.exitCode=1;}
  fs.writeFileSync(path.join(ART,'evidence.json'),JSON.stringify(e,null,2));console.log(JSON.stringify({passed:e.passed,error:e.error,root:ROOT,cycles:e.cycles.length}));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
