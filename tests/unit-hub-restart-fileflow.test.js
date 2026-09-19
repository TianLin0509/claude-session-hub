'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDevFileEngine}=require('../main/groupchat/dev-file-engine');
const F=require('../core/dev-file-workflow');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restart-files-')),calls=[];
  const create=id=>({id,scene:'dev',groupChat:true,subSessions:['s1','s2'],participants:[0],slotSpecs:[{memberId:'m1'},{memberId:'m2'}],
    serialWorkflow:{fileFlowVersion:2,settingsVersion:1,steps:[['m1'],['m2']],fileFlow:{paused:true,executedRounds:6,lastDispatch:{key:'build:1',memberIds:['m1'],settled:false}}}});
  const meetings=[create('active'),create('dormant')];meetings[1].serialWorkflow.fileFlow={};
  for(const m of meetings){fs.mkdirSync(F.directory(dir,m.id),{recursive:true});fs.writeFileSync(path.join(F.directory(dir,m.id),'已完成-开题报告.md'),'');}
  const e=createDevFileEngine({getHubDataDir:()=>dir,meetingManager:{getMeeting:id=>meetings.find(m=>m.id===id),getAllMeetings:()=>meetings,
    updateMeeting:(id,fields)=>Object.assign(meetings.find(m=>m.id===id),fields),setParticipants:(id,value)=>{meetings.find(m=>m.id===id).participants=value;}},
    ensureMemberReady:async()=>{},getDispatcher:()=>({dispatchGroupChatTurn:async(id,args)=>{calls.push({id,args});return {status:'completed',results:args.targetMemberIds.map(mid=>({sid:mid==='m1'?'s1':'s2',status:'completed'}))};}})});
  t.after(()=>{e.dispose();fs.rmSync(dir,{recursive:true,force:true});});return {dir,e,calls,m:meetings[0]};
}
test('interrupted file stage resumes within existing round budget and scanner stays scoped',async t=>{
  const h=fixture(t);
  const result=await h.e.resumeAfterRestart('active','重启后继续');
  assert.equal(result.status,'completed');assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].args.targetMemberIds,['m1']);
  assert.equal(h.m.serialWorkflow.fileFlow.executedRounds,6,'continuation is not an additional workflow stage');
  h.e.tick();await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1,'dormant historical groups must stay dormant');
});
test('handoff during shutdown resumes actual new owner and counts only that stage',async t=>{
  const h=fixture(t);h.m.serialWorkflow.fileFlow.executedRounds=2;
  fs.writeFileSync(path.join(F.directory(h.dir,'active'),'已完成-实现手册-轮次1.md'),'');
  await h.e.resumeAfterRestart('active','重启后继续');
  assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].args.targetMemberIds,['m2']);assert(h.calls[0].args.userInput.includes('重启后继续'));
  assert.equal(h.m.serialWorkflow.fileFlow.executedRounds,3);
});
test('completed workflow never dispatches again',async t=>{
  const h=fixture(t);fs.writeFileSync(path.join(F.directory(h.dir,'active'),'已完成-实现手册-轮次1.md'),'');
  fs.writeFileSync(path.join(F.directory(h.dir,'active'),'已完成-合并手册-轮次1.md'),'');
  assert.equal((await h.e.resumeAfterRestart('active','继续')).status,'completed');assert.equal(h.calls.length,0);
});

test('restart with no active workflows still allows later user-started handoffs',async t=>{
  const h=fixture(t);h.m.serialWorkflow.fileFlow.executedRounds=1;
  h.e.start({onlyIds:[]});h.e.tick();assert.equal(h.calls.length,0);
  await h.e.userTurn('active',{userInput:'继续'});assert.equal(h.calls.length,1);
  fs.writeFileSync(path.join(F.directory(h.dir,'active'),'已完成-实现手册-轮次1.md'),'');
  h.e.tick();await new Promise(r=>setImmediate(r));
  assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].args.targetMemberIds,['m2']);
  assert(h.calls.every(c=>c.id==='active'));
});
