'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
async function until(label,read,timeout=40000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(v)return v;await sleep(100);}throw Error('Timeout: '+label);}
async function click(c,selector){
  const point=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing element');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-restart-e2e-')),dataDir=path.join(root,'data'),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  const out=path.resolve('artifacts/hub-restart/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const evidence={root,out,checks:[],passed:false};let hub,c,newPid;
  const env={CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
    CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'gated',CLAUDE_HUB_FIXTURE_GATE_DIR:path.join(root,'gates'),
    CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(root,'threads'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl'),
    CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers'),CLAUDE_HUB_FIXTURE_CONFIG_DIR:path.join(root,'configs')};
  try{
    hub=await launchIsolatedHub({dataDir,port:await port(),label:'restart-origin',extraEnv:env,windowMode:'hidden'});
    c=await connectFirstPage(hub);await until('renderer ready',()=>c.eval('typeof restartController!=="undefined"'));
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    async function create(kind,title){
      const s=await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({kind,opts:{cwd,title,mcpProfile:'none',...(kind==='codex'?{model:'gpt-6-astra',effort:'xhigh'}:{})}})})`);
      assert(s.id,JSON.stringify(s));await until(title+' ready',()=>c.eval(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.connection==='connected'`));return s.id;
    }
    const codex=await create('codex','Codex 工作中'),claude=await create('claude','Claude 工作中'),idle=await create('codex','空闲'),waiting=await create('codex','待审批'),dormant=await create('codex','历史休眠');
    await c.eval(`ipcRenderer.invoke('suspend-session',${JSON.stringify(dormant)})`);
    await until('dormant',()=>c.eval(`sessions.get(${JSON.stringify(dormant)})?.status==='dormant'`));
    for(const [id,text] of [[codex,'fixture:working-tail'],[claude,'正在执行的原任务'],[waiting,'fixture:approval']]){
      const result=await c.eval(`ipcRenderer.invoke('session:send-prompt',${JSON.stringify({sessionId:id,text,clientSubmissionId:'original-'+id})})`);assert(result.ok,JSON.stringify(result));
    }
    await until('original tasks active',()=>c.eval(`sessions.get(${JSON.stringify(codex)}).nativeRuntime.state==='running' && sessions.get(${JSON.stringify(claude)}).nativeRuntime.state==='running' && sessions.get(${JSON.stringify(waiting)}).nativeRuntime.state==='waiting'`));
    const slot={kind:'codex',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'};
    const group=await c.eval(`ipcRenderer.invoke('create-meeting',${JSON.stringify({title:'重启群聊',scene:'general',workspace:cwd,slots:[slot,slot,slot]})})`);
    assert.equal(group.subSessions.length,3);
    await until('group members ready',()=>c.eval(`${JSON.stringify(group.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.connection==='connected')`));
    await c.eval(`void ipcRenderer.invoke('groupchat:turn',${JSON.stringify({meetingId:group.id,userInput:'fixture:working-tail',targetMemberIds:['m1','m2']})})`);
    await until('group tasks active',()=>c.eval(`${JSON.stringify(group.subSessions.slice(0,2))}.every(id=>sessions.get(id)?.nativeRuntime?.state==='running')`));
    const fileGroup=await c.eval(`ipcRenderer.invoke('create-meeting',${JSON.stringify({title:'文件交接重启',mode:'dev',scene:'dev',groupChat:true,workspace:cwd,slots:[0,1].map(i=>({kind:'claude',memberId:'m'+(i+1),mcpProfile:'none'}))})})`);
    const config=await c.eval("window.WorkflowTemplates.createTemplateConfig('dev-task',[{memberId:'m1',kind:'claude'},{memberId:'m2',kind:'claude'}])");
    await c.eval(`ipcRenderer.invoke('update-meeting-sync',${JSON.stringify({meetingId:fileGroup.id,fields:{serialWorkflow:config}})})`);
    await c.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(fileGroup.id)},meetings[${JSON.stringify(fileGroup.id)}])`);
    await until('file kickoff control',()=>c.eval('!!document.querySelector("[data-file-kickoff]")'));
    await click(c,'#mr-input-box');await c.send('Input.insertText',{text:'验证重启后根据交付文件继续当前阶段。'});
    await click(c,'[data-file-kickoff]');await click(c,'#mr-input-box');
    for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until('file author working',()=>c.eval(`sessions.get(${JSON.stringify(fileGroup.subSessions[0])})?.nativeRuntime?.state==='running'`));
    const docs=path.join(dataDir,'task-docs',fileGroup.id);fs.mkdirSync(docs,{recursive:true});
    fs.writeFileSync(path.join(docs,'已完成-开题报告.md'),'controlled kickoff');
    fs.writeFileSync(path.join(docs,'已完成-实现手册-轮次1.md'),'controlled implementation');
    await until('file stage advanced',()=>c.eval(`ipcRenderer.invoke('dev-file:status',{meetingId:${JSON.stringify(fileGroup.id)}}).then(s=>s.phase==='merge')`));
    assert.notEqual(await c.eval(`sessions.get(${JSON.stringify(fileGroup.subSessions[1])})?.nativeRuntime?.state`),'running');
    await c.eval(`selectSession(${JSON.stringify(codex)})`);
    await until('composer',()=>c.eval('!!document.querySelector(".floating-input-box")'));
    await c.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='未发送草稿：重启保留';box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const openIds=[codex,claude,idle,waiting,...group.subSessions,...fileGroup.subSessions];
    const before=await c.eval(`[...sessions.values()].filter(s=>${JSON.stringify(openIds)}.includes(s.id)).map(s=>({id:s.id,codexSid:s.codexSid||null,ccSessionId:s.ccSessionId||null,currentModel:s.currentModel,effort:s.effort||null}))`);
    evidence.before=before;evidence.oldPid=hub.pid;
    await click(c,'#btn-hub-restart');
    await until('old Hub exits',()=>!hub.isAlive(),65000);
    assert.equal(hub.exitCode(),0);fs.writeFileSync(path.join(out,'old-hub.log'),hub.log().join('\n'));
    await c.close();c=null;
    const control=await until('replacement control file',()=>{
      const dir=path.join(dataDir,'control');if(!fs.existsSync(dir))return null;
      for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){
        const row=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
        if(row.pid!==hub.pid && row.cdpPort && alive(row.pid))return row;
      }return null;
    },65000);
    newPid=control.pid;evidence.newPid=newPid;
    c=await connectFirstPage({cdpHttpBase:'http://127.0.0.1:'+control.cdpPort,label:'restart-replacement'});
    await until('restoration settles',()=>c.eval('typeof restartController!=="undefined" && restartController.current?.phase==="done"'),90000);
    const plan=await c.eval('restartController.current');evidence.plan=plan;
    assert.equal(plan.sessions.length,9,JSON.stringify(plan));
    assert.equal(plan.sessions.find(s=>s.id===codex).status,'continued',JSON.stringify(plan));
    assert.equal(plan.sessions.find(s=>s.id===claude).status,'continued',JSON.stringify(plan));
    assert.equal(plan.sessions.find(s=>s.id===idle).status,'restored');
    assert.equal(plan.sessions.find(s=>s.id===waiting).status,'waiting');
    assert(['continued','completed'].includes(plan.groups.find(g=>g.id===group.id)?.status),JSON.stringify(plan));
    assert.equal(plan.groups.find(g=>g.id===fileGroup.id)?.status,'continued',JSON.stringify(plan));
    const after=await c.eval(`JSON.stringify([...sessions.values()].filter(s=>${JSON.stringify(openIds)}.includes(s.id)).map(s=>({id:s.id,codexSid:s.codexSid||null,ccSessionId:s.ccSessionId||null,currentModel:s.currentModel,effort:s.effort||null})))`);
    assert.deepEqual(JSON.parse(after).sort((a,b)=>a.id.localeCompare(b.id)),before.sort((a,b)=>a.id.localeCompare(b.id)));
    assert.equal(await c.eval(`sessions.get(${JSON.stringify(dormant)}).status`),'dormant');
    await until('draft restored',()=>c.eval('document.querySelector(".floating-input-box")?.innerText==="未发送草稿：重启保留"'));
    evidence.checks.push('real button restarts the Electron process; Codex and Claude resume exact native identities; only working sessions continue; waiting and dormant preserved; draft and settings survive');
    await c.eval("ipcRenderer.invoke('hub-restart:restore')");
    const trace=fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(trace.filter(x=>x.method==='turn/start' && x.params?.clientUserMessageId==='restart:'+plan.token+':'+codex).length,1);
    assert.equal(trace.filter(x=>x.method==='turn/start' && x.params?.clientUserMessageId==='original-'+codex).length,1);
    const continuations=trace.filter(x=>x.method==='turn/start' && x.params?.input?.some(block=>block.text?.includes('刚才因 AI Hub 重启中断')));
    for(const id of group.subSessions.slice(0,2))assert.equal(continuations.filter(x=>x.params.threadId===before.find(s=>s.id===id).codexSid).length,1);
    assert.equal(continuations.filter(x=>x.params.threadId===before.find(s=>s.id===group.subSessions[2]).codexSid).length,0);
    const claudeMessages=fs.readFileSync(path.join(root,'gates','received.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(claudeMessages.filter(m=>m.text.startsWith('刚才因 AI Hub 重启中断')).length,1);
    const fileContinuation=claudeMessages.filter(m=>m.text.includes('刚才因 AI Hub 重启中断') && m.sessionId===before.find(s=>s.id===fileGroup.subSessions[1]).ccSessionId);
    assert.equal(fileContinuation.length,1);assert(fileContinuation[0].text.includes('合并手册-轮次1.md'));
    assert.equal(claudeMessages.filter(m=>m.sessionId===before.find(s=>s.id===fileGroup.subSessions[0]).ccSessionId).length,1,'completed file stages never restart the old author');
    evidence.checks.push('file workflow re-scans actual handoff files and continues the merger, without repeating the completed author stage');
    evidence.checks.push('group dispatcher continues only the two interrupted members; idle third member receives no prompt; Claude continuation also received exactly once');
    evidence.checks.push('repeated restore never replays the original prompt or duplicates the continuation');
    const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'restored.png'),Buffer.from(shot.data,'base64'));
    evidence.passed=true;
  }catch(error){evidence.error=error.stack;throw error;}
  finally{
    if(c){try{evidence.final=await c.eval('({plan:restartController.current,sessions:[...sessions.values()].map(s=>({id:s.id,title:s.title,runtime:s.nativeRuntime})),text:document.body.innerText.slice(-3500)})');}catch(error){evidence.captureError=error.message;}}
    if(newPid && c && alive(newPid)){
      try {
        await until('replacement ready for cleanup',()=>c.eval('typeof ipcRenderer!=="undefined"'));
        await c.eval("ipcRenderer.invoke('debug:agent-league-close-window')");await until('replacement exit',()=>!alive(newPid),30000);
      }catch(error){evidence.cleanupError=error.message;evidence.passed=false;}
    }
    if(c)await c.close();
    if(hub){fs.writeFileSync(path.join(out,'old-hub.log'),hub.log().join('\n'));await gracefulQuit(hub,{allowAlreadyExited:true});}
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({out,passed:evidence.passed,checks:evidence.checks,error:evidence.error}));
    if(evidence.cleanupError)throw Error('Isolated cleanup failed: '+evidence.cleanupError);
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
