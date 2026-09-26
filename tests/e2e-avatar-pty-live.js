'use strict';
// Opt-in real Claude Haiku / Codex Astra test; uses isolated profiles and workspace.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-avatar-live-')),data=path.join(root,'data'),workspace=path.join(root,'workspace');
const art=path.resolve('artifacts/avatar-routing/live'),j=JSON.stringify,delay=ms=>new Promise(r=>setTimeout(r,ms)),secrets=[];
fs.mkdirSync(art,{recursive:true});fs.mkdirSync(workspace);
function profiles(){
  const env={CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_HUB_HOME_DIR:path.join(root,'home'),AI_HUB_WORKSPACE_ROOT:root,DEEPSEEK_API_KEY:''};
  for(const [key,source,names] of [['CODEX_HOME','.codex',['auth.json','config.toml','models_cache.json']],['CLAUDE_CONFIG_DIR','.claude',['.credentials.json','settings.json']]]){
    const dest=path.join(root,source.slice(1));fs.mkdirSync(dest,{recursive:true});env[key]=dest;
    for(const name of names){const src=path.join(os.homedir(),source,name),out=path.join(dest,name);if(fs.existsSync(src)){fs.copyFileSync(src,out);secrets.push(out);}}
  }
  const src=path.join(os.homedir(),'.claude.json');if(fs.existsSync(src)){const out=path.join(env.CLAUDE_CONFIG_DIR,'.claude.json');fs.copyFileSync(src,out);secrets.push(out);}
  const settings=path.join(env.CLAUDE_CONFIG_DIR,'settings.json');if(fs.existsSync(settings)){const s=JSON.parse(fs.readFileSync(settings,'utf8'));delete s.hooks;delete s.enabledPlugins;delete s.statusLine;fs.writeFileSync(settings,j(s));}
  // Isolated Hub intentionally skips automatic Claude hook deployment. Deploy
  // the real integration into this test profile, never the user's live profile.
  const hooks=require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:env.CLAUDE_CONFIG_DIR,sourceScriptsDir:path.resolve('scripts')});
  assert.deepEqual(hooks.errors,[]);
  return env;
}
(async()=>{let hub,c,id;const e={passed:false,realModel:true,runtime:'pty',root,models:['claude-haiku-4-5-20251001','gpt-6-astra'],checks:[]};
  const invoke=(ch,args={})=>c.eval(`require('electron').ipcRenderer.invoke(${j(ch)},${j(args)})`);
  const until=async(label,fn,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await delay(300);}throw Error('timeout: '+label);};
  const click=async selector=>{const p=await c.eval(`(()=>{const el=document.querySelector(${j(selector)});if(!el)throw Error('missing '+${j(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
  const send=async text=>{await click('#mr-input-box');await c.send('Input.insertText',{text});for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
  const selected=()=>c.eval('[...document.querySelectorAll(".mr-free-slot-cb:checked")].map(e=>Number(e.dataset.slotIdx))');
  const select=async indexes=>{for(const n of [0,1])if((await selected()).includes(n)!==indexes.includes(n)){await click(`.mr-free-avatar-chk[data-slot-idx="${n}"]`);await until('avatar selection',async()=>(await selected()).includes(n)===indexes.includes(n));}};
  const state=()=>invoke('groupchat:get-state',{meetingId:id});
  try{
    fs.writeFileSync(path.join(workspace,'AGENTS.md'),'# Isolated interaction test\nOnly follow the assigned small test. No network, research, repository edits or subagents. Do not deliver workflow files until explicitly asked. User supplements can be answered directly.\n');
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    hub=await launchIsolatedHub({dataDir:data,port,windowMode:'hidden',extraEnv:profiles()});c=await connectFirstPage(hub);e.pid=hub.pid;
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await until('renderer',()=>c.eval('!!window.MeetingRoom'));
    const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'真实 CLI 活跃插话验证',workspace,slots:[{memberId:'m1',kind:'claude',model:e.models[0],effort:'low',fastMode:false,mcpProfile:'lean'},{memberId:'m2',kind:'codex',model:e.models[1],effort:'low',mcpProfile:'lean'}]});id=m.id;e.sessions=m.subSessions;
    const cfg=await invoke('workflow:configure',{meetingId:id,expectedRevision:m.serialWorkflow?.settingsRevision||0,draft:{kind:'serial',presetId:'custom',enabled:true,rounds:[{name:'等待插话',members:['m1','m2'],prompt:'这是隔离输入测试。先用工具在工作目录写 started-<你的成员ID>.txt（Claude 为 m1，Codex 为 m2），再执行一次 60 秒的等待命令（例如 powershell -NoProfile -Command "Start-Sleep -Seconds 60"）。等待后只回复 READY_WAITING。本次先不要改名交付文件，我们要测试运行中插话。若收到补充，直接回复要求的唯一标记即可，别重启任务或提前交付。',after:'end'}]}});assert(cfg.ok,cfg.reason);
    const fresh=(await invoke('get-meetings')).find(x=>x.id===id);await c.eval(`window.MeetingRoom.openMeeting(${j(id)},${j(fresh)})`);await until('composer',()=>c.eval('!!document.querySelector("[data-delivery=files]")'));
    await send('启动隔离测试：两位执行本阶段指定的等待任务，期间接收各自头像指定的补充。');
    await until('both CLI tools started',()=>['m1','m2'].every(n=>fs.existsSync(path.join(workspace,`started-${n}.txt`))),180000);
    e.before=await invoke('delivery:status',{meetingId:id});e.active=[];e.markers=[];
    for(const n of [1,0]){
      await select([n]);const truth=await c.eval(`require('../core/session-runtime-truth').getSessionRuntimeTruth(sessions.get(${j(m.subSessions[n])}))`);e.active.push({sid:m.subSessions[n],truth});assert.equal(truth.state,'running','recipient must really be running at send time');
      const marker=`AVATAR_${n===0?'CLAUDE':'CODEX'}_${Date.now()}`;e.markers.push({sid:m.subSessions[n],marker});await send(`补充：只回复唯一标记 ${marker}，不要修改工作流文件或阶段。`);
      await until('supplement persisted',async()=>(await state()).messages.some(x=>x.role==='user'&&String(x.content).includes(marker)));
    }
    e.state=await until('both real replies',async()=>{const s=await state();return e.markers.every(({sid,marker})=>s.messages.some(x=>x.role==='assistant'&&x.sid===sid&&String(x.content).includes(marker)))?s:null;},180000);
    for(const {sid,marker} of e.markers){const msg=e.state.messages.find(x=>x.role==='user'&&String(x.content).includes(marker));assert.deepEqual(msg.toSids,[sid]);assert(!e.state.messages.some(x=>x.role==='assistant'&&x.sid!==sid&&String(x.content).includes(marker)));}
    await delay(1000);
    await until('one visible answer per recipient',()=>c.eval(`${j(e.markers)}.every(({sid,marker})=>[...document.querySelectorAll('.mr-gc-msg.ai')].filter(el=>el.dataset.sourceSid===sid && el.querySelector('.mr-gc-bubble')?.innerText.includes(marker)).length===1)`));
    e.after=await invoke('delivery:status',{meetingId:id});assert.equal(e.after.runId,e.before.runId);assert.equal(e.after.round,e.before.round);assert.equal(e.after.done,false);
    e.checks.push('both recipients running when supplements sent','each avatar-selected CLI replies with its own marker','one visible reply per recipient','same workflow and phase; no premature file delivery');e.passed=true;
  }catch(error){e.error=error.stack;throw error;}
  finally{
    if(c){try{if(id)e.state=await state();e.ui=await c.eval('document.body.innerText.slice(-18000)');const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(art,'live.png'),Buffer.from(shot.data,'base64'));}catch(error){e.captureError=error.message;}await c.close();}
    if(hub){e.quit=await gracefulQuit(hub);e.logs=hub.log();}for(const file of secrets)if(fs.existsSync(file))fs.unlinkSync(file);
    fs.writeFileSync(path.join(art,'evidence.json'),j(e), 'utf8');console.log(j({passed:e.passed,error:e.error,root,checks:e.checks}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
