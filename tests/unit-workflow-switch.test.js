'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const S=require('../core/workflow-settings'),D=require('../core/delivery-workflow');
const {createLoopEngine}=require('../main/groupchat/loop-engine'),{createDevFileEngine}=require('../main/groupchat/dev-file-engine'),{createDeliveryEngine}=require('../main/groupchat/delivery-engine');
const flush=()=>new Promise(r=>setImmediate(r));
const draft={kind:'serial',presetId:'custom',enabled:true,rounds:[{name:'先说',members:['a'],prompt:'',after:'next'},{name:'接着说',members:['b'],prompt:'',after:'end'}]};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-workflow-switch-'));
(async()=>{
 const m={id:'switch',groupChat:true,slotSpecs:[{memberId:'a'},{memberId:'b'}],subSessions:['sa','sb'],serialWorkflow:S.toWorkflowConfig({},draft,['a','b'])};
 const handlers={},calls=[],waiting=[],progress=[];let interrupts=0;
 const deps={meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:()=>{}},sessionManager:{getSession:()=>({status:'idle'})},getHubDataDir:()=>dir,sendToRenderer:(channel,value)=>{if(channel==='workflow:progress')progress.push(value);},logger:{log(){},error(){}},getDispatcher:()=>({dispatchGroupChatTurn:(_,a)=>{calls.push(a);return new Promise(r=>waiting.push(()=>r({status:'completed',turnNum:calls.length,results:a.targetMemberIds.map(id=>({sid:'s'+id,status:'completed',text:'回答'}))})));},interruptMeetingTurn:()=>interrupts++})};
 const loop=createLoopEngine(deps),editor=createDevFileEngine({...deps,isWorkflowRunning:id=>loop.isRunning(id),stopWorkflow:id=>loop.stopLoop(id,{interrupt:false})});editor.registerIpc({handle:(k,f)=>handlers[k]=f},{});
 const toggle=(enabled,revision=m.serialWorkflow.settingsRevision||0)=>handlers['workflow:set-enabled'](null,{meetingId:m.id,enabled,expectedRevision:revision});
 const order=JSON.stringify(m.serialWorkflow.steps),prompts=JSON.stringify(m.serialWorkflow.stepConfigs);
 const run=loop.runSerial(m.id,'当前问题',null);await flush();assert.equal(calls.length,1);
 assert(toggle(false).ok);assert.equal(m.serialWorkflow.enabled,false);assert.equal(interrupts,0,'switching off does not interrupt the current answer');
 waiting[0]();await run;assert.equal(calls.length,1,'off prevents the following speaker');
 assert.equal(progress.at(-1).completedStepCount,1,'finished speech must not restore the old question to the composer');
 assert(!loop.validateSerial(m.id).ok);assert.equal(JSON.stringify(m.serialWorkflow.steps),order);assert.equal(JSON.stringify(m.serialWorkflow.stepConfigs),prompts);
 assert(!toggle(true,0).ok,'stale settings cannot change the switch');assert(!toggle('true').ok,'string values cannot silently enable workflows');
 assert(toggle(true).ok);assert.equal(calls.length,1,'on never resends the old question');
 loop.clearStopIntent(m.id); // The real serial:start IPC clears intent for a new user input.
 const next=loop.runSerial(m.id,'新问题',null);await flush();assert.deepEqual(calls[1].targetMemberIds,['a']);waiting[1]();await flush();assert.deepEqual(calls[2].targetMemberIds,['b']);waiting[2]();assert.equal((await next).status,'done');
 assert(toggle(false).ok);const saved=handlers['workflow:configure'](null,{meetingId:m.id,draft,expectedRevision:m.serialWorkflow.settingsRevision});assert(saved.ok);assert(saved.config.enabled,'saving still activates the latest workflow');
 editor.dispose();
 // Delivery mode must pause on off, retain the current run, and resist a late file.
 const taskDraft={...draft,presetId:'filework',rounds:draft.rounds.map((r,i)=>({...r,after:i?'review':'next'}))};
 m.id='delivery-switch';m.serialWorkflow=S.toDeliveryConfig({},taskDraft,['a','b']);
 const deliveryCalls=[];const dd={...deps,getMembers:()=>[{memberId:'a'},{memberId:'b'}],ensureMemberReady:async()=>{},getDispatcher:()=>({dispatchGroupChatTurn:(_,a)=>{deliveryCalls.push(a);return Promise.resolve({status:'completed'});}})};
 const engine=createDeliveryEngine(dd),ed=createDevFileEngine({...dd,deliveryEngine:engine});ed.registerIpc({handle:(k,f)=>handlers[k]=f},{});
 try{
  await engine.start(m.id,'保留交付任务');await flush();const base=D.directory(dir,m.id),before=JSON.parse(fs.readFileSync(path.join(base,'run.json'),'utf8'));
  assert(toggle(false).ok);const paused=JSON.parse(fs.readFileSync(path.join(base,'run.json'),'utf8'));assert.equal(paused.id,before.id);assert.equal(paused.status,'paused');
  const step=paused.steps.at(-1),p=D.paths(base,paused,step,'a');fs.writeFileSync(p.ready,D.header(paused,step,'a')+'\n已核对。');engine.tick(m.id);await flush();assert.equal(deliveryCalls.length,1,'late delivery does not advance while disabled');
  assert(toggle(true).ok);assert(m.serialWorkflow.taskArmed);assert.equal(deliveryCalls.length,1,'reenabling does not replay or automatically resume a paused delivery');
 }finally{engine.dispose();ed.dispose();}
 console.log('PASS workflow switch: retained settings, stopped handoff, next input, revision guards, save activation and safe delivery pause');
})().catch(e=>{console.error(e);process.exitCode=1;});
