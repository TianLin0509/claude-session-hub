'use strict';
// Real isolated Hub/IPC/dispatcher with controlled App Server and delayed history.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-native-handoff-gui-'));
const data=path.join(root,'data'),workspace=path.join(root,'workspace'),codex=path.join(root,'codex');
for(const dir of [workspace,codex])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(codex,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  let hub,cdp,meetingId;
  const until=async(fn,label,timeout=20000)=>{const untilAt=Date.now()+timeout;while(Date.now()<untilAt){if(await fn())return;await sleep(100);}throw Error('timeout: '+label);};
  let invoke;
  try{
    hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'hidden',extraEnv:{CODEX_HOME:codex,CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve(__dirname,'./fixtures/codex-app-server.js')}});
    cdp=await connectFirstPage(hub,t=>/index\.html/.test(t.url));
    invoke=(channel,args={})=>cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
    await until(()=>cdp.eval('!!window.WorkflowTemplates && typeof sessions !== "undefined"'),'renderer');
    const meeting=await invoke('create-meeting',{mode:'dev',scene:'dev',groupChat:true,title:'原生结束后交接等待反例',workspace,
      slots:[{kind:'codex',memberId:'m1',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'},{kind:'codex',memberId:'m2',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'}]});
    meetingId=meeting.id;const sid=meeting.subSessions[0];
    const snapshot=()=>cdp.eval(`sessions.get(${JSON.stringify(sid)})`);
    await until(async()=>meeting.subSessions.every(s=>s) && (await snapshot())?.nativeRuntime?.state==='idle','native idle');
    const workflow=await cdp.eval('window.WorkflowTemplates.createTemplateConfig("dev-task",[{kind:"codex",memberId:"m1"},{kind:"codex",memberId:"m2"}])');
    await invoke('update-meeting-sync',{meetingId,fields:{serialWorkflow:workflow}});
    await invoke('groupchat:set-participants',{meetingId,participants:[0]});
    await cdp.eval(`selectMeeting(${JSON.stringify(meetingId)})`);
    const preset=await invoke('dev-file:kickoff-preset',{meetingId});
    await cdp.eval(`void require('electron').ipcRenderer.invoke('groupchat:turn',${JSON.stringify({meetingId,userInput:'fixture:wait\n'+preset.prompt})})`);
    await until(async()=>(await snapshot())?.nativeRuntime?.state==='waiting','native waiting');
    const state=()=>invoke('groupchat:get-state',{meetingId});
    await until(async()=>Object.keys((await state()).attempts).length===1,'first attempt');
    const docs=path.join(data,'task-docs',meetingId);fs.mkdirSync(docs,{recursive:true});
    fs.writeFileSync(path.join(docs,'开题报告.md'),'Controlled file handoff; no real author/model.');
    fs.renameSync(path.join(docs,'开题报告.md'),path.join(docs,'已完成-开题报告.md'));
    await until(async()=>Object.values((await state()).devChatHistory?.receipts || {}).some(r=>r.handedOffAt),'actual file handoff');
    assert.equal(Object.keys((await state()).attempts).length,1,'waiting native turn must hold next stage');
    const before=await snapshot();const request=before.nativeRuntime.requests[0];
    const response=await invoke('codex:native-action',{sessionId:sid,action:'reply',requestId:request.id,epoch:before.nativeRuntime.epoch,result:{answers:{q:{answers:['A']}}}});
    assert(response.ok,'native server accepts the test response');
    await until(async()=>(await snapshot()).nativeRuntime.state==='completed','native completed');
    await sleep(1500);
    const after=await snapshot(),group=await state(),file=await invoke('dev-file:status',{meetingId});
    const evidence={root,pid:hub.child.pid,port:hub.port,meetingId,sid,nativeRuntime:after.nativeRuntime,
      receipt:Object.values(group.devChatHistory.receipts)[0],attemptCount:Object.keys(group.attempts).length,file,fixture:true};
    fs.writeFileSync(path.join(root,'native-handoff-evidence.json'),JSON.stringify(evidence,null,2));
    fs.writeFileSync(path.join(root,'groupchat.json'),JSON.stringify(group,null,2));
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'native-completed-next-stage.png'),Buffer.from(shot.data,'base64'));
    console.log(JSON.stringify(evidence,null,2));
    assert(!evidence.receipt.sourceCompletedAt,'no synthetic history completion');
    assert.equal(await cdp.eval("document.querySelectorAll('[data-gc-retry-answer]').length"),0,'no development retry buttons');
    assert.equal(evidence.receipt.attemptId,before.nativeRuntime.submission.id,'same submission owns file handoff');
    assert.equal(evidence.attemptCount,2,'matching native completion must release the second stage despite unavailable history');
  }finally{
    if(invoke && meetingId)await invoke('groupchat:interrupt',{meetingId}).catch(error=>console.error('cleanup interrupt failed',error.message));
    if(cdp)await cdp.close();if(hub){fs.writeFileSync(path.join(root,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}
    console.log('ARTIFACT_ROOT '+root);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
