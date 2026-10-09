'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const S=require('../core/workflow-settings'),D=require('../core/delivery-workflow'),A=require('../core/group-answer-files');
const {createDevFileEngine}=require('../main/groupchat/dev-file-engine');
const {createLoopEngine}=require('../main/groupchat/loop-engine');
const Migration=require('../core/delivery-migration');
const people=['a','b','c'].map(memberId=>({memberId,title:memberId}));
const draft=rounds=>({enabled:true,kind:'serial',presetId:'custom',rounds});
const round=(members,i,total)=>({name:`第 ${i+1} 轮`,members,prompt:'',after:i===total-1?'end':'next'});
const data=fs.mkdtempSync(path.join(os.tmpdir(),'hub-conversation-unit-'));
function harness(config){
 const m={id:'conversation',groupChat:true,slotSpecs:people,subSessions:['sa','sb','sc'],serialWorkflow:config};
 const calls=[],handlers={},events=[],pending=[];
 const deps={meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:(_,p)=>m.participants=p},sessionManager:{getSession:()=>({status:'idle'})},getHubDataDir:()=>data,
  sendToRenderer:(channel,value)=>events.push({channel,value}),logger:{log(){},error(){}},getDispatcher:()=>({dispatchGroupChatTurn:(_,args)=>{calls.push(args);return new Promise(resolve=>pending.push(resolve));}})};
 const engine=createLoopEngine(deps),editor=createDevFileEngine({...deps,isWorkflowRunning:id=>engine.isRunning(id)});
 editor.registerIpc({handle:(name,fn)=>handlers[name]=fn},{});
 const settle=(i,status='completed')=>pending[i]({status:'completed',turnNum:i+1,results:calls[i].targetMemberIds.map(id=>({sid:'s'+id,status,text:status==='completed'?'自然回答':'',reason:status==='completed'?null:'submission_unknown',failure:status==='completed'?null:{category:'reconciliation',autoRetry:false}}))});
 return {m,calls,handlers,events,engine,editor,settle};
}
const flush=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const d=draft([round(['a'],0,2),round(['b'],1,2)]);
 const old={...S.toDeliveryConfig({},d,['a','b','c']),taskArmed:false};
 const h=harness(old);
 const saved=h.handlers['workflow:configure'](null,{meetingId:h.m.id,draft:d,expectedRevision:0});
 assert(saved.ok,saved.reason);
 assert.equal(saved.config.conversationVersion,1,'custom save must select ordered speech rather than delivery tasks');
 assert(!D.enabled(h.m));assert(A.enabled(h.m),'ordered speech keeps the normal group answer cards');
 assert(!('taskArmed' in saved.config));assert(!('deliveryStages' in saved.config));assert.deepEqual(h.m.participants,[0]);
 assert.equal(h.handlers['workflow:configure'](null,{meetingId:h.m.id,draft:d,expectedRevision:0}).ok,false,'stale editor cannot overwrite saved order');
 h.editor.dispose();
 let combinations=0;
 const subsets=[['a'],['b'],['c'],['a','b'],['a','c'],['b','c'],['a','b','c']];
 for(let n=1;n<=6;n++)for(let offset=0;offset<subsets.length;offset++){
  const rounds=Array.from({length:n},(_,i)=>round(subsets[(i+offset)%subsets.length],i,n));
  const x=harness(S.toWorkflowConfig({},draft(rounds),['a','b','c']));
  for(const question of ['第一条输入','第二条输入']){
   const base=x.calls.length,run=x.engine.runSerial(x.m.id,question,null);await flush();
   for(let i=0;i<n;i++){
    assert.equal(x.calls.length,base+i+1,'no later speaker before the current stage finishes');
    assert.deepEqual(x.calls[base+i].targetMemberIds,rounds[i].members);
    assert(x.calls[base+i].userInput.includes(question));
    assert(!x.calls[base+i].userInput.includes('交付'));assert(!x.calls[base+i].userInput.includes('评审'));
    assert.equal(x.calls[base+i].turnTimeoutMs,undefined,'ordinary conversation does not impose a task timeout');
    assert.equal(x.calls[base+i].reuseTurnNum,null,'each speech has its own answer card, including repeated members');
    x.settle(base+i);await flush();
   }
   assert.equal((await run).status,'done');assert(x.m.serialWorkflow.enabled,'the next input uses the same saved order');
  }
  assert(!fs.existsSync(D.directory(data,x.m.id)),'speech must never create delivery run files');x.editor.dispose();combinations++;
 }
 const failure=harness(S.toWorkflowConfig({},d,['a','b','c']));
 const run=failure.engine.runSerial(failure.m.id,'失败场景',null);await flush();failure.settle(0,'errored');assert.equal((await run).status,'paused');assert.equal(failure.calls.length,1,'unknown submission is never blindly repeated');failure.editor.dispose();
 const early={...d,rounds:d.rounds.map((r,i)=>({...r,after:i===0?'end':r.after}))};
 const end=harness(S.toWorkflowConfig({},early,['a','b','c']));const endRun=end.engine.runSerial(end.m.id,'提前结束',null);await flush();end.settle(0);assert.equal((await endRun).status,'done');assert.equal(end.calls.length,1);end.editor.dispose();
 const base=D.directory(data,'migration');fs.mkdirSync(base,{recursive:true});const historical=JSON.stringify({id:'old',status:'cancelled'});fs.writeFileSync(path.join(base,'run.json'),historical);
 const room={...h.m,id:'migration',serialWorkflow:old};
 const migrated=Migration.plan(room,data);assert.equal(migrated.action,'migrate');assert.equal(migrated.config.conversationVersion,1);assert.equal(fs.readFileSync(path.join(base,'run.json'),'utf8'),historical);
 fs.writeFileSync(path.join(base,'run.json'),JSON.stringify({id:'active',status:'paused'}));assert.equal(Migration.plan(room,data).action,'keep','unfinished delivery remains intact');
 fs.writeFileSync(path.join(base,'run.json'),'invalid JSON');assert.equal(Migration.plan(room,data).action,'keep','unreadable task state never triggers conversion');
 fs.writeFileSync(path.join(base,'run.json'),historical);
 assert.equal(Migration.plan({...room,orchestration:{enabled:true}},data).action,'keep','orchestrated work segments remain delivery tasks');
 const malformed=Migration.plan({...room,serialWorkflow:{...old,deliveryStages:undefined}},data);assert.equal(malformed.action,'keep','bad legacy settings must not abort Hub startup');assert(malformed.reason.startsWith('invalid:'));
 assert.equal(Migration.plan({...room,serialWorkflow:migrated.config},data).reason,'already','restart does not migrate conversations back into tasks');
 assert.equal(S.toWorkflowConfig({},S.createPreset('development',people),['a','b','c']).deliveryVersion,1);
 assert.equal(S.toWorkflowConfig({},S.createPreset('filework',people),['a','b','c']).deliveryVersion,1,'review/rework remains a delivery flow');
 for(const preset of ['roundtable','research'])assert.equal(S.toWorkflowConfig({},S.createPreset(preset,people),['a','b','c']).conversationVersion,1);
 console.log(`PASS: ${combinations} ordered-speech combinations with two successive inputs, normal cards, no task files, errors and safe migration`);
})().catch(e=>{console.error(e);process.exitCode=1;});
