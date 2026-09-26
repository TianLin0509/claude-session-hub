'use strict';
// One short, real Claude Haiku -> Codex low-effort PTY workflow. No code changes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-delivery-live-')),DATA=path.join(ROOT,'data'),ART=path.resolve('artifacts/delivery-live');fs.mkdirSync(ART,{recursive:true});
const secrets=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
function profiles(){const env={CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_HUB_HOME_DIR:path.join(ROOT,'home'),AI_HUB_WORKSPACE_ROOT:ROOT,DEEPSEEK_API_KEY:''};
 for(const [key,source,names] of [['CODEX_HOME','.codex',['auth.json','config.toml','models_cache.json']],['CLAUDE_CONFIG_DIR','.claude',['.credentials.json','settings.json']]]){
  const dest=path.join(ROOT,source.slice(1));fs.mkdirSync(dest,{recursive:true});env[key]=dest;
  for(const name of names){const original=path.join(os.homedir(),source,name),target=path.join(dest,name);if(fs.existsSync(original)){fs.copyFileSync(original,target);secrets.push(target);}}
 }
 const state=path.join(os.homedir(),'.claude.json');if(fs.existsSync(state)){const dest=path.join(env.CLAUDE_CONFIG_DIR,'.claude.json');fs.copyFileSync(state,dest);secrets.push(dest);}
 // Isolated hooks are deployed by Hub; never retain user notification hooks.
 const settings=path.join(env.CLAUDE_CONFIG_DIR,'settings.json');if(fs.existsSync(settings)){const s=JSON.parse(fs.readFileSync(settings,'utf8'));delete s.hooks;delete s.enabledPlugins;delete s.statusLine;fs.writeFileSync(settings,JSON.stringify(s),'utf8');}
 return env;
}
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{let hub,cdp,id;const e={realModel:true,runtime:'pty',root:ROOT,passed:false};
 const invoke=(ch,args={})=>cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
 const wait=async(label,pred,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await pred();if(r)return r;await delay(500);}throw Error('Timeout: '+label);};
 try{
  const workspace=path.join(ROOT,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'AGENTS.md'),'# Isolated protocol test\nOnly write the assigned workflow files. No code, repo, network, or extra research. Read the prior delivery if provided, write 2 short lines, verify UTF-8 and rename the draft.\n');
  hub=await launchIsolatedHub({dataDir:DATA,port:await port(),windowMode:'hidden',extraEnv:profiles()});cdp=await connectFirstPage(hub);e.pid=hub.pid;
  await wait('renderer',()=>cdp.eval('!!window.MeetingRoom'));
  const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'真实 Claude → Codex 文件交付',workspace,slots:[{index:0,memberId:'m1',kind:'claude',model:'claude-haiku-4-5-20251001',effort:'low',fastMode:false,mcpProfile:'lean'},{index:1,memberId:'m2',kind:'codex',model:'gpt-6-astra',effort:'low',mcpProfile:'lean'}]});id=m.id;assert.equal(m.subSessions.length,2);e.sessions=m.subSessions;
  const draft={kind:'serial',presetId:'custom',enabled:true,rounds:[{name:'Claude 简答',members:['m1'],prompt:'只需用两句话解释 1+1=2，将结果写进自己的草稿，回读并原子改名交付。不要调用子代理，不做其他工作。',after:'next'},{name:'Codex 核验',members:['m2'],prompt:'读取前序已交付文件，检查 1+1=2，写两句话结论进自己的草稿，回读并原子改名交付。不要调用子代理，不做其他工作。',after:'end'}]};
  const cfg=await invoke('workflow:configure',{meetingId:id,draft,expectedRevision:m.serialWorkflow?.settingsRevision||0});assert(cfg.ok,cfg.reason);
  const fresh=(await invoke('get-meetings')).find(x=>x.id===id);await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`);
  await wait('composer',()=>cdp.eval("!!document.querySelector('[data-delivery=files]')"));
  const point=await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
  for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});await cdp.send('Input.insertText',{text:'简单验证一次交接：Claude 先解释 1+1=2，Codex 再核对。每人交付两句话即可。'});
  for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  e.state=await wait('real workflow completion',async()=>{const s=await invoke('delivery:status',{meetingId:id});if(s.paused)throw Error(s.error);return s.done?s:null;},240000);
  const base=path.dirname(e.state.dir),run=JSON.parse(fs.readFileSync(path.join(base,'run.json'),'utf8'));assert.equal(run.steps.length,2);assert(run.steps.every(s=>Object.values(s.deliveries).length===1));
  e.deliveries=run.steps.flatMap(s=>Object.values(s.deliveries).map(d=>({...d,text:fs.readFileSync(d.path,'utf8')})));e.passed=true;
 }catch(error){e.error=error.stack;if(cdp&&id){e.state=await invoke('delivery:status',{meetingId:id});e.ui=await cdp.eval('document.body.innerText.slice(-16000)');}throw error;}
 finally{if(cdp){const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(ART,'live.png'),Buffer.from(shot.data,'base64'));await cdp.close();}if(hub){e.quit=await gracefulQuit(hub);e.logs=hub.log();}for(const file of secrets)if(fs.existsSync(file))fs.unlinkSync(file);fs.writeFileSync(path.join(ART,'evidence.json'),JSON.stringify(e,null,2),'utf8');console.log(JSON.stringify({passed:e.passed,error:e.error,state:e.state,root:ROOT},null,2));}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
