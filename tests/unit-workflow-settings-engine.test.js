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
   // Kickoff and builds are free: every build, including the third, is reviewed.
   const mi=calls.length-1;assert.deepEqual(calls[mi].targetMemberIds,['b'],`build ${n} is reviewed`);
   write(`${n<=failures?'需返工':'已完成'}-合并手册-轮次${n}.md`);await settle(mi);e.tick();await flush();
   if(n>failures){assert(e.status(m.id).done);assert.equal(calls.length,1+2*n);break;}
   if(n===3){
    const st=e.status(m.id);assert.equal(calls.length,7,'third rework waits for the user');
    assert(st.limitReached);assert(st.paused);assert(!st.done);assert.equal(st.reviews,3);assert.deepEqual(st.next.memberIds,['a','c']);
   }
  }
  if(failures===3){
   const count=calls.length;e.dispose();e=createDevFileEngine(deps);e.tick();await flush();assert.equal(calls.length,count,'restart retains budget');
   // Typed continue while the composer still lights the reviewer: the Hub routes by task files.
   m.participants=[1];
   const resumed=e.userTurn(m.id,{userInput:'继续',recipientSids:['s2']});await flush();
   assert.equal(calls.length,8,'explicit continue grants new budget');
   assert.deepEqual(calls[7].targetMemberIds,['a','c']);assert.equal(calls[7].recipientSids,undefined,'composer selection must not override the phase owner');
   assert.match(calls[7].userInput,/实现 · 第 4 轮/);assert.equal(m.serialWorkflow.fileFlow.reviewBudgetStart,3);
   await settle(7);await resumed;
  }
 } finally{e.dispose();fs.rmSync(dir,{recursive:true,force:true});}
}
async function continueButton() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-continue-'));
 const members=['a','b'].map((memberId,i)=>({memberId,title:memberId,displayName:memberId.toUpperCase()}));
 const draft=S.createPreset('development',members);
 const m={id:'cont',groupChat:true,subSessions:['s1','s2'],slotSpecs:members,participants:[0],serialWorkflow:S.toConfig({},draft,['a','b'])};
 const calls=[],pending=[],handlers={},live={};
 const e=createDevFileEngine({getHubDataDir:()=>dir,getMembers:()=>members,
  sessionManager:{getSession:sid=>live[sid]?{agentRuntime:'pty',status:'running',cliRuntime:{state:'running',connection:'connected'}}:null},
  meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:(_,p)=>m.participants=p},ensureMemberReady:async()=>{},
  getDispatcher:()=>({dispatchGroupChatTurn:(_,args)=>{calls.push(args);return new Promise(resolve=>pending.push(resolve));}})});
 e.registerIpc({handle:(name,fn)=>handlers[name]=fn},{});
 const docs=F.directory(dir,m.id);fs.mkdirSync(docs,{recursive:true});
 const write=name=>fs.writeFileSync(path.join(docs,name),'delivery','utf8');
 const done=i=>{pending[i]({status:'completed',results:calls[i].targetMemberIds.map(id=>({sid:m.subSessions[members.findIndex(p=>p.memberId===id)],status:'completed',text:'done'}))});return flush();};
 try{
  assert.equal((await handlers['dev-file:continue'](null,{meetingId:m.id})).ok,false,'nothing to continue before kickoff');
  write('已完成-开题报告.md');write('已完成-实现手册-轮次1.md');
  e.tick();await flush();assert.equal(calls.length,1);assert.deepEqual(calls[0].targetMemberIds,['b']);
  // User stops the review; the reviewer's turn ends without a handoff file.
  e.stop(m.id);await done(0);
  let st=e.status(m.id);assert(st.paused);assert.deepEqual(st.next.memberIds,['b']);assert.match(st.next.label,/B · 审查与合并 · 第 1 轮/);
  m.participants=[0];
  live.s2=true;const refused=await handlers['dev-file:continue'](null,{meetingId:m.id});
  assert.equal(refused.ok,false);assert.match(refused.error,/B 仍在运行/);assert.equal(calls.length,1,'never stack onto a running member');
  live.s2=false;const r=await handlers['dev-file:continue'](null,{meetingId:m.id});
  assert.equal(r.ok,true,r.error);assert.equal(calls.length,2);assert.deepEqual(calls[1].targetMemberIds,['b'],'continue follows the phase, not the lit avatar');
  assert.match(calls[1].userInput,/^继续：接续当前阶段/);assert.match(calls[1].userInput,/执行合并 · 第 1 轮/);
  const twice=await handlers['dev-file:continue'](null,{meetingId:m.id});assert.equal(twice.ok,false);assert.equal(calls.length,2,'no duplicate while running');
  write('已完成-合并手册-轮次1.md');await done(1);e.tick();await flush();
  assert(e.status(m.id).done);assert.equal(e.status(m.id).next,null);
  assert.match((await handlers['dev-file:continue'](null,{meetingId:m.id})).error,/已完成/);
 }finally{e.dispose();fs.rmSync(dir,{recursive:true,force:true});}
}
async function legacyBudgetMigration() {
 // Before 2026-09-28 budgetStart counted execution rounds; 6 = kickoff + three builds + two reviews.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-legacy-'));
 const members=['a','b'].map(memberId=>({memberId})),draft=S.createPreset('development',members);
 const m={id:'old',groupChat:true,subSessions:['s1','s2'],slotSpecs:members,serialWorkflow:S.toConfig({},draft,['a','b'])};
 m.serialWorkflow.fileFlow={executedRounds:8,budgetStart:6,lastDispatch:{key:'merge:3',token:'t',memberId:'b'}};
 const e=createDevFileEngine({getHubDataDir:()=>dir,meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m],updateMeeting:(_,p)=>Object.assign(m,p),setParticipants:()=>{}},ensureMemberReady:async()=>{},getDispatcher:()=>({})});
 const docs=F.directory(dir,m.id);fs.mkdirSync(docs,{recursive:true});
 for(const name of ['已完成-开题报告.md',...[1,2,3].flatMap(n=>[`已完成-实现手册-轮次${n}.md`,`需返工-合并手册-轮次${n}.md`])])fs.writeFileSync(path.join(docs,name),'x');
 try{const st=e.status(m.id);assert.equal(st.phase,'build');assert.equal(st.reviewBudgetStart,2);assert.equal(st.limitReached,false,'one review spent in the granted budget');}
 finally{e.dispose();fs.rmSync(dir,{recursive:true,force:true});}
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
(async()=>{await scenario(0);await scenario(1);await scenario(2);await scenario(3);await continueButton();await legacyBudgetMigration();await preparationRace();console.log('workflow A engine: every build reviewed, 3-review budget, Hub-routed continue, legacy budget, restart/resume, concurrent kickoff and unreadable directory passed');})().catch(e=>{console.error(e);process.exitCode=1});
