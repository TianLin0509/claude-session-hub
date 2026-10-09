'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const S=require('../core/workflow-settings'),D=require('../core/delivery-workflow');
const {createDeliveryEngine}=require('../main/groupchat/delivery-engine');
const {createDevFileEngine}=require('../main/groupchat/dev-file-engine');
const flush=()=>new Promise(r=>setImmediate(r));
async function scenario(outcome){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-save-routing-'));
 const people=['codex','claude'].map(memberId=>({memberId,displayName:memberId}));
 // Review/rework intentionally keeps the delivery lifecycle. Plain custom
 // speech is covered by unit-conversation-workflow instead.
 const draft={kind:'serial',presetId:'filework',enabled:true,rounds:[{name:'先实现',members:['codex'],prompt:'实现',after:'next'},{name:'再审核',members:['claude'],prompt:'审核',after:'review'}]};
 const m={id:'save-routing',groupChat:true,slotSpecs:people,subSessions:['sc','sa'],serialWorkflow:S.toDeliveryConfig({},draft,['codex','claude'])};
 const calls=[],handlers={},events=[];
 const deps={meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:(_,p)=>m.participants=p},sessionManager:{getSession:()=>({status:'idle'})},getHubDataDir:()=>dir,getMembers:()=>people,ensureMemberReady:async()=>{},sendToRenderer:(name,state)=>events.push({name,state}),getDispatcher:()=>({dispatchGroupChatTurn:(_,args)=>{calls.push(args);args.targetMemberIds.forEach(memberId=>args.onSubmission({memberId,ok:true}));return Promise.resolve({status:'completed'});}})};
 let engine=createDeliveryEngine(deps);const editor=createDevFileEngine({...deps,deliveryEngine:engine});editor.registerIpc({handle:(name,fn)=>handlers[name]=fn},{});
 const read=()=>JSON.parse(fs.readFileSync(path.join(D.directory(dir,m.id),'run.json'),'utf8'));
 const advance=async()=>{engine.tick(m.id);await flush();await flush();};
 const deliver=member=>{const r=read(),s=r.steps.at(-1),p=D.paths(D.directory(dir,m.id),r,s,member);fs.writeFileSync(p.ready,D.header(r,s,member)+'\n\n已实际核对结果。','utf8');};
 try{
  await engine.start(m.id,'旧任务');await flush();
  const locked=handlers['workflow:configure'](null,{meetingId:m.id,draft,expectedRevision:0});assert.equal(locked.ok,false,'active task cannot be overwritten');
  if(outcome==='done'){deliver('codex');await advance();deliver('claude');await advance();assert(engine.status(m.id).done);}else engine.cancel(m.id);
  const old=fs.readFileSync(path.join(D.directory(dir,m.id),'run.json'),'utf8');
  assert.equal(engine.status(m.id).armed,false,'task end retains ordinary-chat behavior');
  const result=handlers['workflow:configure'](null,{meetingId:m.id,draft,expectedRevision:0});
  assert.equal(result.ok,true,result.reason);assert.equal(result.config.enabled,true,'saving activates the workflow');
  assert.equal(engine.status(m.id).armed,true,'saving after a terminal task arms the next message');
  assert.deepEqual(m.participants,[0]);assert.equal(fs.readFileSync(path.join(D.directory(dir,m.id),'run.json'),'utf8'),old,'saving never rewrites historical task');
  assert.equal(handlers['workflow:configure'](null,{meetingId:m.id,draft,expectedRevision:0}).ok,false,'stale revision cannot overwrite settings');
  const empty={...draft,enabled:false,rounds:draft.rounds.map(r=>({...r,prompt:''}))};
  const saved=handlers['workflow:configure'](null,{meetingId:m.id,draft:empty,expectedRevision:1});assert(saved.ok,saved.reason);assert(saved.config.deliveryStages.every(r=>r.prompt===''));
  engine.dispose();engine=createDeliveryEngine(deps);assert(engine.status(m.id).armed,'saved routing survives engine restart');
  const before=calls.length;await engine.start(m.id,'新输入框中的完整职责：Codex 先实现，Claude 再审核');await flush();
  assert.deepEqual(calls[before].targetMemberIds,['codex']);assert(calls[before].userInput.includes('新输入框中的完整职责'));assert(calls[before].userInput.includes('hub-delivery:'));
  deliver('codex');await advance();assert.deepEqual(calls[before+1].targetMemberIds,['claude']);assert(calls[before+1].userInput.includes('前序输入'));
  await advance();assert.equal(calls.length,before+2,'scanning does not duplicate the handoff');deliver('claude');await advance();assert(engine.status(m.id).done);
 }finally{engine.dispose();editor.dispose();}
}
(async()=>{await scenario('cancelled');await scenario('done');console.log('PASS: save after cancel/completion, activation, empty prompts, persistence, serial handoff and revision guards');})().catch(e=>{console.error(e);process.exitCode=1;});
