'use strict';
// Exercise user-defined member orders and barriers against the real engine.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const S=require('../core/workflow-settings'),D=require('../core/delivery-workflow');
const {createDeliveryEngine}=require('../main/groupchat/delivery-engine');
const flush=()=>new Promise(r=>setImmediate(r));
const selections=[['a'],['b'],['c'],['a','b'],['b','c'],['c','a'],['a','b','c']];
async function run(rounds,offset){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-flow-matrix-')),people=['a','b','c'].map(memberId=>({memberId,displayName:memberId}));
 const stages=Array.from({length:rounds},(_,i)=>({name:'stage '+i,members:[...selections[(offset+(offset%2?i:0))%selections.length]],prompt:i%2?'':'  ',after:i===rounds-1?'end':'next'}));
 const m={id:'matrix',groupChat:true,slotSpecs:people,subSessions:['sa','sb','sc'],serialWorkflow:S.toDeliveryConfig({},{kind:'serial',presetId:'custom',enabled:true,rounds:stages},['a','b','c'])},calls=[];
 const e=createDeliveryEngine({meetingManager:{getMeeting:()=>m,setParticipants:(_,p)=>m.participants=p,updateMeeting:(_,p)=>Object.assign(m,p)},sessionManager:{getSession:()=>({status:'idle'})},getHubDataDir:()=>dir,getMembers:()=>people,ensureMemberReady:async()=>{},getDispatcher:()=>({dispatchGroupChatTurn:(_,a)=>{calls.push(a);a.targetMemberIds.forEach(memberId=>a.onSubmission({memberId,ok:true}));return Promise.resolve({status:'completed'});}})});
 const read=()=>JSON.parse(fs.readFileSync(path.join(D.directory(dir,m.id),'run.json'),'utf8'));
 const scan=async()=>{e.tick(m.id);await flush();await flush();};
 try{
  await e.start(m.id,'shared goal '+rounds+' '+offset);await flush();
  for(let i=0;i<rounds;i++){
   assert.equal(calls.length,i+1);assert.deepEqual(calls[i].targetMemberIds,stages[i].members);assert(calls[i].userInput.includes('shared goal '+rounds+' '+offset));
   const step=read().steps.at(-1);assert.equal(step.index,i);assert.equal(step.inputs.length,stages.slice(0,i).reduce((n,s)=>n+s.members.length,0),'every prior result is handed off');
   for(const [j,member] of [...stages[i].members].reverse().entries()){
    const r=read(),s=r.steps.at(-1),p=D.paths(D.directory(dir,m.id),r,s,member);fs.writeFileSync(p.ready,D.header(r,s,member)+'\n\nverified '+i+' '+member,'utf8');await scan();
    if(j<stages[i].members.length-1)assert.equal(calls.length,i+1,'out-of-order partial delivery never releases the next stage');
   }
   await scan();assert.equal(calls.length,Math.min(i+2,rounds),'repeated scans never duplicate dispatch');
  }
  assert(e.status(m.id).done);assert.equal(read().steps.length,rounds);
 }finally{e.dispose();}
}
(async()=>{for(let rounds=1;rounds<=6;rounds++)for(let offset=0;offset<selections.length;offset++)await run(rounds,offset);console.log('PASS 42 workflows: 1-6 stages, all member subsets, same-seat repeats, changing order, reverse delivery and pinned prior inputs');})().catch(e=>{console.error(e);process.exitCode=1;});
