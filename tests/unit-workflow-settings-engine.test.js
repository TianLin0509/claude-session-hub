'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const S=require('../core/workflow-settings'), F=require('../core/dev-file-workflow');
const {createDevFileEngine}=require('../main/groupchat/dev-file-engine');
const flush=()=>new Promise(r=>setImmediate(r));
async function scenario(failures) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-a-'));
 const members=['a','b','c'].map((memberId,i)=>({memberId,title:memberId}));
 const draft=S.createPreset('development',members);draft.rounds[1].members.push('c');
 const m={id:'task',groupChat:true,subSessions:['s1','s2','s3'],slotSpecs:members,serialWorkflow:S.toConfig({},draft,['a','b','c'])};
 const pending=[],calls=[],handlers={};
 const deps={getHubDataDir:()=>dir,meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:(_,p)=>m.participants=p},ensureMemberReady:async()=>{},getDispatcher:()=>({dispatchGroupChatTurn:(_,args)=>{calls.push(args);return new Promise(resolve=>pending.push(resolve));}})};
 let e=createDevFileEngine(deps);e.registerIpc({handle:(name,fn)=>handlers[name]=fn},{});
 const docs=F.directory(dir,m.id);fs.mkdirSync(docs,{recursive:true});
 const write=name=>fs.writeFileSync(path.join(docs,name),'delivery','utf8');
 const settle=async i=>{pending[i]({status:'completed',results:calls[i].targetMemberIds.map(id=>({sid:m.subSessions[m.slotSpecs.findIndex(p=>p.memberId===id)],status:'completed',text:'done'}))});await flush();};
 try {
  const kickoff=e.userTurn(m.id,{userInput:F.appendKickoff('task',e.kickoffPreset(m.id).prompt)});await flush();assert.equal(calls.length,1);
  write('已完成-开题报告.md');e.tick();await flush();assert.equal(calls.length,1,'must wait for same-round replies');
  await settle(0);await kickoff;
  for(let n=1;n<=3;n++){
   e.tick();await flush();const bi=calls.length-1;assert.deepEqual(calls[bi].targetMemberIds,['a','c']);
   assert(calls[bi].userInput.includes(draft.rounds[1].prompt));
   write(`已完成-实现手册-轮次${n}.md`);e.tick();await flush();assert.equal(calls.length,bi+1,'helper barrier');
   const locked=handlers['workflow:configure'](null,{meetingId:m.id,draft,expectedRevision:0});assert.equal(locked.ok,false);
   await settle(bi);e.tick();await flush();
   if(n===3){assert.equal(calls.length,6);assert(e.status(m.id).limitReached);assert(e.status(m.id).paused);assert(!e.status(m.id).done);break;}
   const mi=calls.length-1;assert.deepEqual(calls[mi].targetMemberIds,['b']);
   write(`${n<=failures?'需返工':'已完成'}-合并手册-轮次${n}.md`);await settle(mi);e.tick();await flush();
   if(n>failures){assert(e.status(m.id).done);assert.equal(calls.length,n===1?3:5);break;}
  }
  if(failures===2){
   const count=calls.length;e.dispose();e=createDevFileEngine(deps);e.tick();await flush();assert.equal(calls.length,count,'restart retains budget');
   const resumed=e.userTurn(m.id,{userInput:'继续'});await flush();assert.equal(calls.length,7,'explicit continue grants new budget');await settle(6);await resumed;
  }
 } finally{e.dispose();fs.rmSync(dir,{recursive:true,force:true});}
}
async function preparationRace() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-a-race-'));
 const people=['a','b'].map(memberId=>({memberId})),draft=S.createPreset('development',people);
 const m={id:'race',groupChat:true,slotSpecs:people,subSessions:['s1','s2'],serialWorkflow:S.toConfig({},draft,['a','b'])};
 let release,reservation=new Promise(r=>release=r),calls=0;const handlers={};
 const e=createDevFileEngine({getHubDataDir:()=>dir,meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:()=>{}},sessionManager:{getNativeSession:()=>({reserveWorkflow:()=>reservation,releaseWorkflow:async()=>{}})},getDispatcher:()=>({dispatchGroupChatTurn:async()=>{calls++;return {status:'completed',results:[{sid:'s1',status:'completed',text:'done'}]};}}),ensureMemberReady:async()=>{}});
 e.registerIpc({handle:(name,fn)=>handlers[name]=fn},{});
 try{
  const args={userInput:F.appendKickoff('goal','kickoff')},first=e.userTurn(m.id,args),second=await e.userTurn(m.id,args);
  assert.equal(second.status,'error');assert.equal(handlers['workflow:configure'](null,{meetingId:m.id,draft,expectedRevision:0}).ok,false);
  release();await first;assert.equal(calls,1);assert.equal(m.serialWorkflow.fileFlow.executedRounds,1);
  const real=fs.readdirSync;
  try{fs.readdirSync=()=>{throw Object.assign(new Error('EACCES task directory'),{code:'EACCES'});};const r=handlers['workflow:configure'](null,{meetingId:m.id,draft:S.createPreset('research',people),expectedRevision:0});assert.equal(r.ok,false);assert.match(r.reason,/EACCES/);assert.equal(m.serialWorkflow.fileFlowVersion,2);}finally{fs.readdirSync=real;}
 }finally{release();e.dispose();fs.rmSync(dir,{recursive:true,force:true});}
}
(async()=>{await scenario(0);await scenario(1);await scenario(2);await preparationRace();console.log('workflow A engine: 3/5/6 rounds, helper barrier, restart/resume, concurrent kickoff and unreadable directory passed');})().catch(e=>{console.error(e);process.exitCode=1});
