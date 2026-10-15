'use strict';
// Real Windows ConPTY / production main handlers, controlled CLI only.
// Background automation intentionally calls the same main handlers as company bridge.
// The noInheritCursor flag is present only on the original create contract, never resume.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
const SOURCE=path.resolve(__dirname,'..');
const {launchIsolatedHub,gracefulQuit,_waitMs:wait}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,stamp=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(SOURCE,'artifacts','20261015-background-resume-'+stamp+'-codex2');fs.mkdirSync(out,{recursive:true});
const baselineFile=process.env.BACKGROUND_BASELINE_RECEIPT||null;
const baseline=baselineFile?JSON.parse(fs.readFileSync(baselineFile,'utf8')):null;
if(baseline){
  assert.equal(baseline.redReproduced,true,'Cold recovery must use the recorded genuine ConPTY baseline');
  const rel=path.relative(path.resolve(os.tmpdir()),path.resolve(baseline.root));
  assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&/^hub-bg-resume-[^\\/]+$/.test(rel),'Only this regression own temp root is allowed');
  assert.ok(baseline.processAudit.every(p=>!p.alive),'Old test receipt must confirm cleanup');
  for(const {pid} of baseline.processAudit){let absent=false;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')absent=true;else throw error;}assert.ok(absent,'Old test PID must still be absent');}
}
const root=baseline?baseline.root:fs.mkdtempSync(path.join(os.tmpdir(),'hub-bg-resume-')),dataDir=path.join(root,'data'),work=path.join(root,'work'),cac=path.join(root,'cac');
const logFile=path.join(out,'20261015-background-resume-cli-events-codex2.jsonl'),receiptFile=path.join(out,'20261015-background-resume-receipt-codex2.json');
const cfg=path.join(root,'fixture.json'),cmd=path.join(root,'codeagent.cmd');
const result={passed:false,sha:execFileSync('git',['rev-parse','HEAD'],{cwd:SOURCE,encoding:'utf8'}).trim(),phase:process.env.BACKGROUND_RESUME_PHASE||'baseline',case:baseline?'upgrade-cold':'new-warm-gui',scope:'实际 Windows ConPTY + 隔离 Hub/main；受控 CLI/JSONL/hooks，无公司原生 CLI、凭据或业务工具',source:SOURCE,root,out,startedAt:new Date().toISOString(),checks:[],observations:[],screenshots:[],launches:[],cleanups:[]};
const save=()=>fs.writeFileSync(receiptFile,j(result,null,2));
const log=text=>{console.log(new Date().toISOString()+' '+text);save();};
const check=(ok,label,evidence)=>{result.checks.push({ok:!!ok,label,evidence});save();assert.ok(ok,label);log('PASS '+label);};
const events=()=>fs.existsSync(logFile)?fs.readFileSync(logFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hashes=()=>Object.fromEntries(['core/session-manager.js','main/ipc/resume-session-handlers.js','core/company-bridge/company.js'].map(p=>[p,hash(path.join(SOURCE,p))]));
const until=async(label,read,ms=30000)=>{let last;for(const end=Date.now()+ms;Date.now()<end;){try{const value=await read();if(value)return value;}catch(e){last=e.message;}await wait(120);}throw Error('timeout: '+label+(last?' ('+last+')':''));};
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const value=s.address().port;s.close(()=>resolve(value));});});
let hub,c,sid;
const ipc=(channel,arg)=>c.eval(`require('electron').ipcRenderer.invoke(${j(channel)},${j(arg)})`);
const sessions=()=>ipc('get-sessions',null);
async function launch(){
  const clearBridgeEnv=Object.fromEntries(Object.keys(process.env).filter(k=>k.startsWith('HUB_BRIDGE_')).map(k=>[k,'']));
  hub=await launchIsolatedHub({dataDir,port:await port(),entryPath:SOURCE,windowMode:'background',label:'CodeAgent background resume',extraEnv:{
    ...clearBridgeEnv,CLAUDE_HUB_E2E:'1',CLAUDE_HUB_E2E_REAL_CLIPBOARD:'',CLAUDE_HUB_BRIDGE_ROLE:'company',CLAUDE_HUB_BRIDGE_TIMER:'0',CLAUDE_HUB_WIRELESS_TIMER:'0',CLAUDE_HUB_HOME_DIR:path.join(root,'home'),AI_HUB_WORKSPACE_ROOT:work,
    AI_HUB_CODEAGENT_COMMAND:cmd,AI_HUB_CODEAGENT_CONFIG_DIR:cac,REENTRY_FIXTURE_CONFIG:cfg,CODEX_HOME:path.join(root,'codex-empty'),CLAUDE_CONFIG_DIR:path.join(root,'claude-empty'),DEEPSEEK_API_KEY:'',ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',CODEX_API_KEY:'',AI_HUB_RULES_BASE_URL:'http://127.0.0.1:9/hub-rules/',
    AI_HUB_UPDATE_SOURCES:j([{id:'isolated',name:'isolated',manifest:'http://127.0.0.1:9/x.json',files:'http://127.0.0.1:9/'}]),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'none'),HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'none')
  }});result.launches.push({pid:hub.pid,port:hub.port,at:Date.now()});save();
  c=await connectFirstPage(hub,t=>t.type==='page'&&/renderer[\\/]index\.html/.test(t.url));
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer ready',()=>c.eval('typeof sessions!=="undefined"&&typeof terminalCache!=="undefined"'));
}
async function stop(){if(c){await c.close();c=null;}if(hub){result.cleanups.push({pid:hub.pid,...await gracefulQuit(hub)});hub=null;save();}}
async function observe(label){
  const rawValue=await ipc('debug:get-session-buffer',sid),raw=typeof rawValue==='string'?rawValue:'',snapshot=await ipc('get-session-buffer-snapshot',sid);
  const view=await c.eval(`({activeSessionId,currentView,hasTerminalCache:terminalCache.has(${j(sid)}),cacheOpened:!!terminalCache.get(${j(sid)})?.opened})`);
  const live=(await sessions()).find(s=>s.id===sid)||null;
  const row={label,at:Date.now(),sid,rawAvailable:typeof rawValue==='string',rawLength:raw.length,rawOnlyDsr:raw==='\u001b[6n',raw,snapshot,view,session:live,fixtureStarts:events().filter(e=>e.event==='start'&&e.sid===sid)};
  result.observations.push(row);save();return row;
}
async function screenshot(label){const p=path.join(out,'20261015-background-resume-'+label+'-codex2.png');fs.writeFileSync(p,Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));result.screenshots.push(p);save();}
async function click(selector){
  await c.eval(`document.querySelector(${j(selector)})?.scrollIntoView({block:'nearest',behavior:'instant'})`);
  let previous=null,since=0;
  const p=await until('clickable '+selector,async()=>{const next=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect(),x=r.x+Math.min(70,r.width/2),y=r.y+r.height/2,h=document.elementFromPoint(x,y);return r.width&&r.height&&(e===h||e.contains(h))?{x,y}:null})()`);if(!next){previous=null;return null;}if(!previous||Math.abs(next.x-previous.x)>0.5||Math.abs(next.y-previous.y)>0.5){previous=next;since=Date.now();return null;}return Date.now()-since>=250?next:null;});
  for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
}
async function key(key,code,vk,modifiers=0){for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk,modifiers});}
async function finished(text){const answer=await until('native GUI answer',()=>events().findLast(e=>e.event==='answer-ready'&&e.sid===sid&&e.text===text),45000);await until('completed GUI stop',()=>c.eval(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed'`));return answer;}
async function sendCard(text){await click('.floating-input-box');await key('a','KeyA',65,2);await c.send('Input.insertText',{text});await click('.floating-input-send');return finished(text);}
function once(text,nativeId,label){const matches=events().filter(e=>e.event==='submit'&&e.text===text);check(matches.length===1&&matches[0].nativeId===nativeId&&matches[0].sid===sid,label,{count:matches.length,nativeId});}
async function sendBackground(text){
  const key=randomUUID();
  await c.eval(`(()=>{window.__backgroundSends||={};const r=window.__backgroundSends[${j(key)}]={at:Date.now()};require('electron').ipcRenderer.invoke('session:send-prompt',${j({sessionId:sid,text,clientSubmissionId:key,waitForCliReady:true})}).then(value=>Object.assign(r,{done:true,value,endedAt:Date.now()}),error=>Object.assign(r,{done:true,error:error.message,endedAt:Date.now()}));return true;})()`);
  const reply=await until('background send result',()=>c.eval(`window.__backgroundSends[${j(key)}]?.done ? window.__backgroundSends[${j(key)}] : null`),75000);
  result.deliveries||=[];result.deliveries.push({text,reply});save();assert.ok(reply.value?.ok,j(reply));
  const answer=await until('native controlled answer',()=>events().findLast(e=>e.event==='answer-ready'&&e.sid===sid&&e.text===text));
  await until('completed stop',()=>c.eval(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed'`));
  return answer;
}
(async()=>{try{
  assert.equal(process.platform,'win32','This regression requires actual Windows ConPTY');
  result.productHashes=hashes();result.scriptHashes={[path.basename(__filename)]:hash(__filename),'e2e-codeagent-background-resume-fixture.js':hash(path.join(__dirname,'e2e-codeagent-background-resume-fixture.js'))};
  if(process.env.EXPECTED_UPSTREAM_SHA)assert.equal(result.sha,process.env.EXPECTED_UPSTREAM_SHA,'Run the frozen source SHA');
  if(baseline){
    result.baseline={receipt:baselineFile,receiptSha256:hash(baselineFile),sha:baseline.sha,sid:baseline.sid,nativeId:baseline.nativeId};
    result.oldStateEvidence=[];
    for(const p of [path.join(dataDir,'state.json'),path.join(dataDir,'sessions',baseline.sid+'.json'),...new Set(baseline.events.filter(e=>e.event==='start').map(e=>e.nativeFile))])if(fs.existsSync(p)){
      const target=path.join(out,'20261015-background-resume-old-'+path.basename(p).replace(/\.(jsonl?|txt)$/,'')+'-codex2'+path.extname(p));fs.copyFileSync(p,target);result.oldStateEvidence.push({source:p,copy:target,sha256:hash(p)});
    }
  }
  for(const d of [dataDir,work,cac])fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(work,'.aiwork-root'),'controlled background recovery fixture');
  fs.writeFileSync(cfg,j({log:logFile}));fs.writeFileSync(cmd,'@echo off\r\n"'+process.execPath+'" "'+path.join(__dirname,'e2e-codeagent-background-resume-fixture.js')+'" %*\r\n');
  await launch();
  if(baseline){
    sid=baseline.sid;result.sid=sid;result.nativeId=baseline.nativeId;
    await until('old saved dormant session',()=>c.eval(`sessions.get(${j(sid)})?.status==='dormant'`));
    const before=await observe('upgrade-cold-before-resume');
    check(!before.view.hasTerminalCache&&before.view.activeSessionId!==sid&&!(await sessions()).some(s=>s.id===sid),'冷启动沿用旧版实际落盘数据，原会话未自动激活后台');
    result.resumeRequest={hubId:sid};result.resumeResponse=await ipc('resume-session',result.resumeRequest);save();
    await until('cold background CLI start',()=>events().some(e=>e.event==='hook'&&e.hook==='session-start'&&e.sid===sid));
    const cold=await observe('upgrade-cold-resumed'),start=events().find(e=>e.event==='start'&&e.sid===sid);
    check(!cold.view.hasTerminalCache&&cold.view.activeSessionId!==sid&&!cold.rawOnlyDsr&&cold.rawLength>4,'旧版数据在新 Hub 后台冷恢复，无需 renderer 光标响应');
    check(start.nativeId===baseline.nativeId&&start.resumeSource===baseline.nativeId&&!start.fork,'升级型冷恢复实际 --resume 保持原生编号');
    const answer=await sendBackground('BACKGROUND-UPGRADE-COLD-1015');
    check(answer.priorUserTexts.includes('BACKGROUND-RESUME-SEED-1015')&&answer.nativeId===baseline.nativeId,'升级型冷恢复读到旧版首问历史并正确作答');
    once('BACKGROUND-UPGRADE-COLD-1015',baseline.nativeId,'升级型冷恢复正文实际仅提交一次');
    const after=await observe('upgrade-cold-answered');check(!after.view.hasTerminalCache,'升级型冷恢复全程未创建 renderer 终端');
    await screenshot('upgrade-cold-answered');
  }else{
  const created=await ipc('create-session',{kind:'codeagent',opts:{cwd:work,title:'后台恢复隔离验收',purpose:'company-bridge',autonomous:true,noInheritCursor:true,codeagentModelPick:false,effort:'low',mcpProfile:'none'}});sid=created.id;result.sid=sid;save();
  await until('new background fixture session-start',()=>events().some(e=>e.event==='hook'&&e.hook==='session-start'&&e.sid===sid));
  const initial=await observe('new-background');
  check(!initial.view.hasTerminalCache&&initial.view.activeSessionId!==sid&&!initial.rawOnlyDsr&&initial.rawLength>4,'联动新建后台会话无需 renderer 终端即可输出',initial.view);
  const first=await sendBackground('BACKGROUND-RESUME-SEED-1015');
  const seeded=await observe('new-background-answered');result.nativeId=first.nativeId;
  check(!seeded.view.hasTerminalCache&&events().filter(e=>e.event==='submit'&&e.text==='BACKGROUND-RESUME-SEED-1015').length===1,'后台首问真实 send-prompt 仅提交一次并得到原生回执');
  const close=await ipc('close-session',sid);check(close.ok,'后台会话可恢复休眠');
  await until('main no live session',async()=>!(await sessions()).some(s=>s.id===sid));
  const before=events().filter(e=>e.event==='start'&&e.sid===sid).length;
  result.resumeRequest={hubId:sid};result.resumeResponse=await ipc('resume-session',result.resumeRequest);save();
  // Sample three times without opening or feeding any terminal. DSR is generated by ConPTY,
  // not by the fixture. Read-only snapshots do not send a cursor response.
  for(let n=0;n<3;n++){await wait(1000);await observe('warm-background-resume-'+n);}
  const warm=result.observations.filter(o=>o.label.startsWith('warm-background-resume-'));
  result.redReproduced=warm.every(o=>o.rawOnlyDsr&&o.rawLength===4&&!o.view.hasTerminalCache)&&events().filter(e=>e.event==='start'&&e.sid===sid).length===before;
  if(result.redReproduced)log('RED REPRODUCED: three raw samples contain only ESC[6n; no renderer terminal; resumed CLI never starts');
  await screenshot('warm-resume');
  check(!result.redReproduced,'关闭后后台恢复不能停在 ESC[6n 光标握手',warm.map(o=>({at:o.at,rawLength:o.rawLength,rawOnlyDsr:o.rawOnlyDsr,seq:o.snapshot?.seq,hasTerminalCache:o.view.hasTerminalCache})));
  await until('resumed CLI start',()=>events().filter(e=>e.event==='start'&&e.sid===sid).length===before+1);
  const second=await sendBackground('BACKGROUND-WARM-RESUME-1015');
  check(second.nativeId===first.nativeId&&second.priorUserTexts.includes('BACKGROUND-RESUME-SEED-1015'),'暖恢复沿用原生身份与历史');
  const warmAnswered=await observe('warm-background-answered');
  check(!warmAnswered.view.hasTerminalCache&&warmAnswered.view.activeSessionId!==sid,'暖恢复首答完成前未创建 renderer 终端');
  once('BACKGROUND-WARM-RESUME-1015',first.nativeId,'暖恢复正文实际仅提交一次');
  await click(`#session-list .session-item[data-session-id="${sid}"]`);await until('card active',()=>c.eval(`activeSessionId===${j(sid)}&&currentView==='card'`));
  const card=await sendCard('BACKGROUND-CARD-SEND-1015');
  check(card.nativeId===first.nativeId&&card.priorUserTexts.includes('BACKGROUND-WARM-RESUME-1015'),'实际鼠标打开卡片后，输入框正常发问且历史保持');
  once('BACKGROUND-CARD-SEND-1015',first.nativeId,'卡片输入正文实际仅提交一次');await screenshot('card-answered');
  await click('#btn-backstage');await until('backstage visible',()=>c.eval(`activeSessionId===${j(sid)}&&currentView==='pty'&&terminalCache.get(${j(sid)})?.opened===true`));
  const terminalPoint=await c.eval(`(()=>{const e=terminalCache.get(${j(sid)}).container.querySelector('.xterm-screen'),r=e.getBoundingClientRect();return{x:r.x+Math.min(r.width/2,300),y:r.y+Math.min(r.height/2,200)};})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...terminalPoint,button:'left',clickCount:1});
  await c.send('Input.insertText',{text:'BACKGROUND-DIRECT-TYPING-1015'});await key('Enter','Enter',13);
  const typed=await finished('BACKGROUND-DIRECT-TYPING-1015');
  check(typed.nativeId===first.nativeId&&typed.priorUserTexts.includes('BACKGROUND-CARD-SEND-1015'),'实际鼠标进入后台后原生键入与回车正常');
  once('BACKGROUND-DIRECT-TYPING-1015',first.nativeId,'后台键入正文实际仅提交一次');await screenshot('backstage-answered');
  await click('#btn-backstage');await until('back to card',()=>c.eval(`currentView==='card'`));
  const back=await sendCard('BACKGROUND-BACK-TO-CARD-1015');
  check(back.nativeId===first.nativeId&&back.priorUserTexts.includes('BACKGROUND-DIRECT-TYPING-1015'),'返回卡片后继续问答，原生身份和历史不变');
  once('BACKGROUND-BACK-TO-CARD-1015',first.nativeId,'返回卡片后正文实际仅提交一次');
  // Ordinary user close/reopen is a separate real UI path, without background launch opts.
  await click('.floating-input-box');await key('w','KeyW',87,2);
  await until('GUI Ctrl+W dormant',()=>c.eval(`sessions.get(${j(sid)})?.status==='dormant'`));
  const startsBeforeUi=events().filter(e=>e.event==='start'&&e.sid===sid).length;
  await click(`#session-list .session-item[data-session-id="${sid}"]`);
  await until('GUI resume ready',()=>events().filter(e=>e.event==='start'&&e.sid===sid).length===startsBeforeUi+1);
  await until('GUI resume card',()=>c.eval(`activeSessionId===${j(sid)}&&currentView==='card'`));
  const restored=await sendCard('BACKGROUND-GUI-RESUME-1015');
  check(restored.nativeId===first.nativeId&&restored.priorUserTexts.includes('BACKGROUND-BACK-TO-CARD-1015'),'真实 Ctrl+W 再点侧栏恢复，卡片直接问答成功');
  once('BACKGROUND-GUI-RESUME-1015',first.nativeId,'GUI 恢复后的正文实际仅提交一次');await screenshot('gui-resume-answered');
  }
  check(!events().some(e=>e.event==='menu-open'),'整轮没有自动 /model 调用');
  check(!events().some(e=>e.event==='fatal'),'受控 CLI 无内部异常');
  result.passed=true;
}catch(error){result.error=error.stack;log('FAIL '+error.message);if(c&&sid)try{await observe('failure');await screenshot('failure');}catch(e){result.captureError=e.message;}}
finally{
  result.events=events();result.productHashesAfter=hashes();result.productUnchanged=j(result.productHashes)===j(result.productHashesAfter);if(!result.productUnchanged)result.passed=false;
  result.nativeEvidence=[];for(const file of [...new Set(events().filter(e=>e.event==='start').map(e=>e.nativeFile))])if(file&&fs.existsSync(file)){const target=path.join(out,'20261015-background-resume-native-'+path.basename(file,'.jsonl')+'-codex2.jsonl');fs.copyFileSync(file,target);result.nativeEvidence.push({path:target,sha256:hash(target)});}
  if(c)try{result.rendererTrace=await c.eval('({activeSessionId,currentView,cacheIds:[...terminalCache.keys()]})');}catch(e){result.traceError=e.message;}
  try{await stop();}catch(e){result.cleanupError=e.message;result.passed=false;}
  result.processAudit=[...new Set([...result.launches.map(e=>e.pid),...events().filter(e=>e.event==='start').map(e=>e.pid)])].map(pid=>{let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}return{pid,alive};});
  if(result.processAudit.some(e=>e.alive))result.passed=false;result.assertionCount=result.checks.length;result.passedAssertionCount=result.checks.filter(e=>e.ok).length;result.finishedAt=new Date().toISOString();save();
  console.log(j({passed:result.passed,redReproduced:result.redReproduced,sha:result.sha,checks:result.checks.length,out,receiptFile,error:result.error,cleanups:result.cleanups,processAudit:result.processAudit},null,2));if(!result.passed)process.exitCode=1;
}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
