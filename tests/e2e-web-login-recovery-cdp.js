'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const store=require('../core/web-roundtable/store'),recovery=require('../core/web-roundtable/recovery');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-login-recovery-')),data=path.join(root,'data'),home=path.join(root,'home'),empty=path.join(root,'empty');
  for(const p of [data,home,empty])fs.mkdirSync(p,{recursive:true});
  process.env.AI_HUB_WEB_DATA_DIR=data;
  const out=path.resolve('artifacts/web-login-recovery/gui');fs.mkdirSync(out,{recursive:true});
  const parent={id:'roundtable-recovery-gui',kind:'roundtable',state:'needs_attention',phase:'authentication',resumeRound:0,createdAt:new Date().toISOString(),input:{providers:['deepseek','kimi','qwen'],rounds:2,synthesizer:'qwen',prompt:'Recovery fixture question'},rounds:[{results:[]}],inFlight:{}};
  for(const provider of parent.input.providers){
    const requestId=parent.id+'-r1-'+provider,id=store.taskId('web',requestId),submitted=provider==='kimi',done=provider==='qwen';
    const input={provider,prompt:parent.input.prompt,reply_to:null};
    const job={id,kind:'web',requestId,input,fingerprint:store.digest(input),state:done?'succeeded':'needs_attention',updatedAt:new Date().toISOString(),submissionAttempted:submitted||done,
      url:provider==='deepseek'?'https://chat.deepseek.com/a/chat/s/fixture':provider==='kimi'?'https://www.kimi.com/chat/fixture':'https://www.qianwen.com/chat/fixture',
      baseline:{count:0,echo:0,last:null},...(done?{answer:'Original Qwen answer'}:{recovery:{reason:'login_required',accountId:'web-'+provider}})};
    store.write(id,job);recovery.track(job);recovery.link(id,parent.id);parent.rounds[0].results.push({...job,provider});parent.inFlight[provider]={task_id:id,state:job.state};
  }
  store.write(parent.id,parent);fs.writeFileSync(path.join(home,'fixture-login-web-qwen'),'1');
  const entry=path.join(root,'entry.cjs');fs.writeFileSync(entry,`require(${JSON.stringify(path.resolve('main-bootstrap.js'))});\nprocess.env.NODE_OPTIONS='--require '+${JSON.stringify(path.resolve('tests/fixtures/web-login-recovery-preload.cjs'))};\nconst {ipcMain}=require('electron');ipcMain.handle('test:recovery-capture',async e=>(await e.sender.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));\n`);
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  let hub,cdp;const result={passed:false,boundary:'Real isolated Electron UI/IPC, real parent and child MCPs and detached workers; website and login responses are fixtures, no real login or cloud questions',root,checks:[]};
  const sends=()=>{try{return fs.readFileSync(path.join(home,'web-sends.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  try{
    hub=await launchIsolatedHub({dataDir:data,port,windowMode:'hidden',entryPath:entry,label:'web-login-recovery',extraEnv:{AI_HUB_WEB_DATA_DIR:data,CLAUDE_HUB_HOME_DIR:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),AI_HUB_WORKSPACE_ROOT:root,
      CLAUDE_HUB_ACCOUNT_FIXTURE:path.resolve('tests/fixtures/account-center-cli.js'),HUB_SESSION_SEARCH_CODEX_ROOTS:empty,HUB_SESSION_SEARCH_CLAUDE_ROOTS:empty,HUB_SESSION_SEARCH_KIMI_ROOTS:empty,HUB_SESSION_SEARCH_GEMINI_ROOTS:empty}});
    result.pid=hub.pid;cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const until=async(expr)=>{for(const end=Date.now()+35000;Date.now()<end;){if(await cdp.eval(expr))return;await pause(120);}throw Error('timeout: '+expr);};
    const click=async selector=>{await until(`!!document.querySelector(${JSON.stringify(selector)})`);await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    await until('typeof accountCenterPanel!=="undefined"');await click('#btn-rail-accounts');
    await until('document.querySelector("[data-ac=attention][data-id=web-deepseek]")?.textContent.includes("恢复")');
    await click('[data-ac=attention][data-id=web-deepseek]');await until('!!document.querySelector(".ac-task-dialog[open]")');
    assert.match(await cdp.eval('document.querySelector(".ac-task-dialog").textContent'),/检查并继续任务/);
    await click('.ac-task-dialog [data-ac=check][data-id=web-deepseek]');await pause(800);assert.equal(sends().length,0);assert.equal(store.read(parent.id).state,'needs_attention');
    result.checks.push('Unknown login evidence never resumes or sends a task');
    await click('.ac-task-dialog [data-ac=open][data-id=web-deepseek]');await pause(400);
    fs.writeFileSync(path.join(home,'fixture-login-web-deepseek'),'1');
    fs.writeFileSync(path.join(out,'01-recovery-dialog.png'),Buffer.from(await cdp.eval('ipcRenderer.invoke("test:recovery-capture")'),'base64'));
    await click('.ac-task-dialog [data-ac=check][data-id=web-deepseek]');
    const ds=parent.inFlight.deepseek.task_id,ki=parent.inFlight.kimi.task_id;
    for(const end=Date.now()+20000;Date.now()<end&&store.read(ds).state!=='succeeded';)await pause(150);
    assert.equal(store.read(ds).state,'succeeded');assert.equal(sends().filter(s=>s.id===ds).length,1);
    result.checks.push('Fresh positive login proof resumes original unsent task once via child MCP');
    await click('[data-ab=close-attention]');await cdp.eval('accountCenterPanel.refresh()');await click('[data-ac=attention][data-id=web-kimi]');
    fs.writeFileSync(path.join(home,'fixture-login-web-kimi'),'1');await click('.ac-task-dialog [data-ac=check][data-id=web-kimi]');
    for(const end=Date.now()+45000;Date.now()<end&&store.read(parent.id).state!=='succeeded';)await pause(200);
    const final=store.read(parent.id);assert.equal(final.state,'succeeded',JSON.stringify(final));assert.equal(sends().filter(s=>s.id===ki).length,0);
    assert.equal(sends().length,5);assert.equal(final.rounds.length,2);assert.equal(final.rounds[0].results.find(r=>r.provider==='qwen').answer,'Original Qwen answer');assert.ok(fs.existsSync(final.reportPath));
    result.checks.push('Submitted task only collects; original parent automatically completes remaining debate and synthesis with peer answer preserved');
    result.sends=sends();result.roundtable=final.id;result.report=final.reportPath;
    for(const id of [final.id,...final.rounds.flatMap(r=>r.results.map(x=>x.id)),final.synthesis.id]){for(const end=Date.now()+10000;Date.now()<end&&store.alive(store.read(id).pid||2147483646);)await pause(100);}
    await click('[data-ab=close-attention]');await cdp.eval('accountCenterPanel.refresh()');
    assert.equal(recovery.list(data).length,0);result.passed=true;
    fs.writeFileSync(path.join(out,'02-recovered.png'),Buffer.from(await cdp.eval('ipcRenderer.invoke("test:recovery-capture")'),'base64'));
  }catch(e){result.error=e.stack;throw e;}
  finally{if(cdp)await cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'),'utf8');result.exit=await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2),'utf8');}
  console.log('PASS: permission UI -> fresh login proof -> child MCP resume/collect -> original roundtable debate/synthesis/HTML; no duplicate submissions');
}
main().catch(e=>{console.error(e.stack,e.logTail||'');process.exitCode=1;});
