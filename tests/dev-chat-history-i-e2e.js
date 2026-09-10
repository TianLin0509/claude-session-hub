'use strict';
// Real isolated Electron + IPC + JSONL reader + persistence + UI. The seeded
// history is a controlled fixture; live provider verification uses the L test.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {GroupChatOrchestrator}=require('../core/group-chat-orchestrator')._private;
const {rememberPrompt}=require('../core/dev-chat-history');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-chat-history-i-')),data=path.join(root,'data');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function run(){
  let hub,cdp,id,sid;const checks=[];
  const script=path.join(root,'stub.js');fs.writeFileSync(script,"module.exports=()=>({text:'fixture'});");
  async function start(){hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'hidden',extraEnv:{CLAUDE_HUB_TEST_DISPATCH_SCRIPT:script}});cdp=await connectFirstPage(hub,t=>/index\.html/.test(t.url));await until(()=>cdp.eval('!!window.MeetingRoom && !!window.WorkflowTemplates'));}
  async function stop(){if(cdp){await cdp.close();cdp=null;}if(hub){await gracefulQuit(hub);hub=null;}}
  const invoke=(channel,args)=>cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args || {})})`);
  async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await sleep(100);}throw Error('condition timed out');}
  const ok=(name,v)=>{assert.ok(v,name);checks.push(name);console.log('PASS '+name);};
  try{
    await start();
    const m=await invoke('create-meeting',{mode:'dev',groupChat:true,title:'消息留存验收',workspace:root,slotSpecs:[{kind:'codex',memberId:'m1'},{kind:'codex',memberId:'m2'}]});id=m.id;
    const seeded=await invoke('test:seed-groupchat-members',{meetingId:id,count:2});sid=seeded.sids[0];
    const config=await cdp.eval("window.WorkflowTemplates.createTemplateConfig('dev-task',[{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'codex'}])");
    await invoke('update-meeting-sync',{meetingId:id,fields:{serialWorkflow:{...config,fileFlow:{paused:true}}}});
    await stop();
    // Seed only while this test's Hub is stopped. No concurrent state writer.
    const orch=new GroupChatOrchestrator(data,id);const {turnNum,runId}=orch.beginTurn('fixture prompt');
    const pending=orch.recordTurnPrompt(turnNum,sid,'fixture prompt',{runId,memberId:'m1',kind:'codex'});
    const receipt=rememberPrompt(orch,sid,pending),source=path.join(root,'source.jsonl');receipt.sourcePath=source;
    orch.completeTurn(turnNum,'fixture prompt',[{sid,attemptId:pending.attemptId,status:'superseded',text:''}], {[sid]:{sid,memberId:'m1',kind:'codex'}},{}, {runId});
    for(const status of ['running','handed_off','errored','superseded','completed']) {
      orch._appendMessage({id:`state-${status}`,role:'assistant',sid:`fixture-${status}`,turnNum,
        speaker:`状态验收 ${status}`,status,content:status==='completed'?'已完成状态验收':'',
        ...(status==='errored'?{failure:{code:'quota_exceeded'}}:{})});
    }
    orch._saveState();
    const records=[{type:'task_started',turn_id:'fixture-turn'},{type:'user_message',message:'fixture prompt'}];
    for(let i=1;i<=45;i++)records.push({type:'item_completed',turn_id:'fixture-turn',item:{id:`m${i}`,type:'AgentMessage',phase:'commentary',text:`进展 ${i}：保留原文与路径 C:\\fixture\\test.js`}});
    const final={type:'item_completed',turn_id:'fixture-turn',item:{id:'final',type:'AgentMessage',phase:'final_answer',text:'最终验证结果：消息已保留。'}};
    fs.writeFileSync(source,records.map(payload=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})).join('\n')+'\n');
    await start();await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    const before=await invoke('test:dispatch-stats');
    const recovered=await invoke('groupchat-manual-extract',{meetingId:id,sid,turnNum});ok('原始转录通过真实 IPC 补收',recovered.ok);
    const state=await invoke('groupchat:get-state',{meetingId:id});ok('最终答复到来前已保存 45 条进展',state.messages.filter(m=>m.sourceMessage).length===45);
    await until(()=>cdp.eval("document.body.innerText.includes('进展 45')"));
    ok('开发卡片无重试按钮',await cdp.eval("document.querySelectorAll('[data-gc-retry-answer]').length===0"));
    ok('失败说明引导继续当前阶段',await cdp.eval("document.body.innerText.includes('额度已用尽；已有发言保留，处理后发送“继续”接续当前阶段') && !document.body.innerText.includes('只重试本家')"));
    ok('中间进展在真实界面可见',await cdp.eval("document.body.innerText.includes('进展 1：') && document.body.innerText.includes('进展 23：')"));
    await invoke('groupchat-manual-extract',{meetingId:id,sid,turnNum});
    ok('重复补收不造重复卡', (await invoke('groupchat:get-state',{meetingId:id})).messages.filter(m=>m.sourceMessage).length===45);
    ok('补收没有重新派发任务',(await invoke('test:dispatch-stats')).callIndex===before.callIndex);
    const retry=await invoke('groupchat-resend-participant',{meetingId:id,sid,turnNum});ok('后端拒绝重发旧开发阶段',!retry.ok && retry.reason==='dev_workflow_uses_continue');
    await cdp.send('Page.reload');await until(()=>cdp.eval('!!window.MeetingRoom'));await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    await until(()=>cdp.eval("document.body.innerText.includes('进展 45')"));ok('刷新后正文仍在',true);
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'history-ui.png'),Buffer.from(shot.data,'base64'));
    await stop();
    // The final arrives while the collector is offline, after the old stage
    // has already handed off. Recover it using the actual history IPC.
    fs.appendFileSync(source,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:final})+'\n');
    await start();await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    await until(()=>cdp.eval("document.body.innerText.includes('进展 45')"));ok('重启后正文仍在',true);
    const late=await invoke('groupchat-manual-extract',{meetingId:id,sid,turnNum});ok('重启后可补收离线期间到达的最终答复',late.ok);
    await until(()=>cdp.eval("document.body.innerText.includes('最终验证结果：消息已保留。')"));
    ok('最终答复在进展之后显示且无镜像重复',await cdp.eval("document.body.innerText.indexOf('最终验证结果：消息已保留。') > document.body.innerText.indexOf('进展 45：') && document.body.innerText.split('最终验证结果：消息已保留。').length===2"));
    ok('离线最终答复不会清除暂停或重新派工',(await invoke('dev-file:status',{meetingId:id})).paused && (await invoke('test:dispatch-stats')).callIndex===0);
    const finalShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'history-final-ui.png'),Buffer.from(finalShot.data,'base64'));
    const restored=await invoke('groupchat:get-state',{meetingId:id});ok('重启未重复收录',restored.messages.filter(m=>m.sourceMessage).length===46);
    fs.writeFileSync(path.join(root,'checks.json'),JSON.stringify({root,checks,fixture:true},null,2));
    fs.writeFileSync(path.join(root,'groupchat.json'),JSON.stringify(restored,null,2));
  }finally{await stop();console.log('ARTIFACT_ROOT '+root);}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
