'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('../core/delivery-workflow'),S=require('../core/workflow-settings');
const {createDeliveryEngine}=require('../main/groupchat/delivery-engine');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(preset='custom',extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-delivery-unit-'));
  const people=['a','b','c'].map(memberId=>({memberId,title:memberId,displayName:memberId}));
  const draft=S.createPreset(preset,people);
  if(preset==='custom')draft.rounds=[{name:'first',members:['a','b'],prompt:'propose',after:'next'},{name:'second',members:['c'],prompt:'review',after:'end'}];
  const m={id:'meeting',groupChat:true,subSessions:['sa','sb','sc'],slotSpecs:people,serialWorkflow:S.toDeliveryConfig({},draft,['a','b','c'])};
  const calls=[],pending=[],events=[],errors=[];
  const deps={meetingManager:{getMeeting:()=>m},sessionManager:{getSession:()=>({status:'idle'})},getHubDataDir:()=>dir,getMembers:()=>people,
    ensureMemberReady:async()=>{},sendToRenderer:(name,state)=>events.push(state),logger:{error:(...args)=>errors.push(args)},
    getDispatcher:()=>({dispatchGroupChatTurn:(_id,args)=>{calls.push(args);args.targetMemberIds.forEach(memberId=>args.onSubmission({memberId,ok:true,sendStatus:'submitted'}));return new Promise(resolve=>pending.push(resolve));}}),...extra};
  let e=createDeliveryEngine(deps);
  const read=()=>JSON.parse(fs.readFileSync(path.join(D.directory(dir,m.id),'run.json'),'utf8'));
  function deliver(member,outcome='ready',body='Verified result') {
    const r=read(),step=r.steps.at(-1),p=D.paths(D.directory(dir,m.id),r,step,member);
    fs.writeFileSync(p.draft,D.header(r,step,member)+'\n\n'+body,'utf8');fs.renameSync(p.draft,p[outcome]);return p;
  }
  const advance=async()=>{e.tick(m.id);await flush();await flush();};
  return {dir,m,calls,pending,events,errors,read,deliver,advance,get e(){return e;},restart:()=>{e.dispose();e=createDeliveryEngine(deps);return e;},close:()=>e.dispose()};
}
async function filesDriveTheBarrier() {
  const f=fixture();try{
    await f.e.start(f.m.id,'goal');assert.equal(f.calls.length,1);assert.equal(f.calls[0].turnTimeoutMs,0);
    f.pending[0]({status:'completed',results:[{sid:'sa',status:'completed',text:'tests still running'}]});await flush();await f.advance();
    assert.equal(f.calls.length,1,'chat final never advances');
    f.deliver('a');await f.advance();assert.equal(f.calls.length,1,'must wait for b');
    f.deliver('b');await f.advance();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].targetMemberIds,['c']);
    await f.advance();assert.equal(f.calls.length,2,'scanner deduplicates');
    f.deliver('c');await f.advance();assert.equal(f.e.status(f.m.id).done,true);
    assert.equal(f.calls.length,2,'pending second chat did not block file completion');
    const previous=f.read().id;await f.e.start(f.m.id,'new goal');assert.notEqual(f.read().id,previous);
    assert.equal(f.calls.length,3,'new run does not consume old delivery');
  }finally{f.close();}
}
async function pauseAndRestart() {
  const f=fixture();try{
    await f.e.start(f.m.id,'goal');f.e.stop(f.m.id);f.deliver('a');f.deliver('b');await f.advance();assert.equal(f.calls.length,1);
    f.restart();assert.equal(f.e.status(f.m.id).recoveryPending,true);
    await f.e.resume(f.m.id);assert.equal(f.calls.length,2);assert.equal(f.read().steps.length,2);
    f.restart();await f.e.resume(f.m.id);assert.equal(f.calls.length,2,'unknown/recovered send intent never auto-replays');
  }finally{f.close();}
}
async function malformedAndEditedDeliveries() {
  const f=fixture();try{
    await f.e.start(f.m.id,'goal');const p=f.deliver('a');fs.writeFileSync(p.ready,'wrong task','utf8');await f.advance();
    assert.equal(f.e.status(f.m.id).paused,true);assert.match(f.e.status(f.m.id).error,/不属于本轮/);assert.equal(f.calls.length,1);
  }finally{f.close();}
  const g=fixture();try{
    await g.e.start(g.m.id,'goal');const p=g.deliver('a');await g.advance();fs.appendFileSync(p.ready,'edited');g.deliver('b');await g.advance();
    assert.match(g.e.status(g.m.id).error,/已接纳/);assert.equal(g.calls.length,1);
  }finally{g.close();}
}
async function developmentBudget() {
  const f=fixture('development');try{
    await f.e.start(f.m.id,'goal');f.deliver('a');await f.advance();
    for(let n=0;n<2;n++){f.deliver('a');await f.advance();f.deliver('b','rework');await f.advance();}
    assert.equal(f.calls.length,6);f.deliver('a');await f.advance();assert.equal(f.calls.length,6);assert.equal(f.e.status(f.m.id).paused,true);
    await f.e.continueWork(f.m.id,'继续');assert.equal(f.calls.length,7,'continuation advances once, never dispatches new step twice');
    assert.deepEqual(f.calls[6].targetMemberIds,['b']);f.deliver('b');await f.advance();assert(f.e.status(f.m.id).done);
  }finally{f.close();}
}
async function unknownAndWakeRace() {
  let wake;const f=fixture('custom',{ensureMemberReady:()=>new Promise(resolve=>wake=resolve)});
  try{const starting=f.e.start(f.m.id,'goal');await flush();f.e.stop(f.m.id);wake();await flush();wake();await starting;assert.equal(f.calls.length,0,'pause during wake prevents send');}
  finally{f.close();}
  const g=fixture('custom',{getDispatcher:()=>({dispatchGroupChatTurn:()=>{throw new Error('send uncertain');}})});
  try{await g.e.start(g.m.id,'goal');assert(g.e.status(g.m.id).paused);g.restart();await g.e.resume(g.m.id);assert.equal(g.read().steps[0].dispatches.length,1,'restart preserves uncertain send');}finally{g.close();}
}
async function ownerAndEmptyFile() {
  const f=fixture();try{
    await f.e.start(f.m.id,'goal');const dir=D.directory(f.dir,f.m.id),r=f.read(),step=r.steps[0],p=D.paths(dir,r,step,'a');
    fs.writeFileSync(p.draft,D.header(r,step,'a')+'\n','utf8');fs.renameSync(p.draft,p.ready);await f.advance();assert.match(f.e.status(f.m.id).error,/正文为空/);
    const other=createDeliveryEngine({meetingManager:{getMeeting:()=>f.m},getHubDataDir:()=>f.dir,getDispatcher:()=>({})});
    try{assert.throws(()=>other.stop(f.m.id),/已在 AI HUB/);}finally{other.dispose();}
  }finally{f.close();}
}
async function cancellationAndFailures(){
  const f=fixture();try{
    await f.e.start(f.m.id,'goal');f.deliver('a','blocked');await f.advance();assert(f.e.status(f.m.id).paused);
    await assert.rejects(f.e.resume(f.m.id),/阻塞/);const old=f.read().id;f.e.cancel(f.m.id);assert(f.e.status(f.m.id).finished);assert(!f.e.status(f.m.id).done);
    f.calls[0].onSubmission({memberId:'a',ok:false,reason:'late failure'});assert.equal(f.read().status,'cancelled');
    await f.e.start(f.m.id,'adjusted goal');assert.notEqual(f.read().id,old);
    assert(fs.existsSync(path.join(D.directory(f.dir,f.m.id),old,'已结束运行.json')));
  }finally{f.close();}
  const g=fixture('custom',{getDispatcher:()=>({dispatchGroupChatTurn:()=>Promise.resolve({status:'completed',results:[{status:'errored',reason:'send failed'}]})})});
  try{await g.e.start(g.m.id,'goal');await flush();assert(g.e.status(g.m.id).paused);assert.equal(g.e.status(g.m.id).error,'send failed');}finally{g.close();}
}
async function completionContinuationAndDormancy(){
  const f=fixture('custom',{sessionManager:{getSession:()=>({status:'idle',runStartedAt:123,lastCompletedAt:124})}});
  try{await f.e.start(f.m.id,'goal');await assert.rejects(f.e.continueWork(f.m.id,'continue'),/提交待核对/);assert.equal(f.calls.length,1);
    f.pending[0]({status:'completed'});await flush();await f.e.continueWork(f.m.id,'continue');assert.equal(f.calls.length,2,'historical startedAt must not prevent explicit continuation');
    f.m.status='dormant';f.deliver('a');f.deliver('b');await f.advance();assert(f.e.status(f.m.id).paused);assert.equal(f.calls.length,2);
  }finally{f.close();}
  let present=true;const g=fixture('custom',{sessionManager:{getSession:()=>present?{status:'idle'}:null}});
  try{await g.e.start(g.m.id,'goal');g.e.retire(g.m.id);present=false;await g.advance();assert(g.e.status(g.m.id).recoveryPending);
    const other=createDeliveryEngine({meetingManager:{getMeeting:()=>g.m},getHubDataDir:()=>g.dir,getDispatcher:()=>({})});try{assert.equal(other.stop(g.m.id),true,'writer drain releases workflow lease');}finally{other.dispose();}
  }finally{g.close();}
}
async function controlWinsOverResume(){
  for(const method of ['stop','cancel','retire']){
    const f=fixture();try{await f.e.start(f.m.id,'goal');f.e.stop(f.m.id);const resuming=f.e.resume(f.m.id);f.e[method](f.m.id);await resuming;
      assert.equal(f.read().status,method==='cancel'?'cancelled':'paused',method+' must win over an earlier resume');assert.equal(f.calls.length,1);
    }finally{f.close();}
  }
}
async function reconcileFinishedDispatchAfterRestart(){
  let proof=false,wrong=false;const f=fixture('custom',{getAttemptEvidence:(_id,_attemptId,expected)=>proof?{attempt:{attemptId:'saved-'+expected.memberId,sid:'s'+expected.memberId,memberId:expected.memberId,status:'completed',workflowRun:{...expected,kind:'delivery',runId:wrong?'other-run':expected.runId}}}:null});
  try{await f.e.start(f.m.id,'goal');f.restart();await f.e.resume(f.m.id);
    await assert.rejects(f.e.continueWork(f.m.id),/提交待核对/);assert.equal(f.calls.length,1,'idle alone never authorizes replay');
    proof=true;wrong=true;await assert.rejects(f.e.continueWork(f.m.id),/提交待核对/);assert.equal(f.calls.length,1,'other run evidence is rejected');
    wrong=false;await f.e.resume(f.m.id);assert.equal(f.calls.length,1,'matching ended attempts only reconcile, never auto-replay');
    assert.equal(f.read().steps[0].dispatches[0].chatStatus,'reconciled');await f.e.continueWork(f.m.id);assert.equal(f.calls.length,2,'explicit continuation can fill missing deliveries after restart');
    await assert.rejects(f.e.continueWork(f.m.id),/提交待核对/);assert.equal(f.calls.length,2,'live local Promise cannot be reconciled early');
  }finally{f.close();}
}
(async()=>{for(const fn of [filesDriveTheBarrier,pauseAndRestart,malformedAndEditedDeliveries,developmentBudget,unknownAndWakeRace,ownerAndEmptyFile,cancellationAndFailures,completionContinuationAndDormancy,controlWinsOverResume,reconcileFinishedDispatchAfterRestart]){await fn();console.log('PASS '+fn.name);}})().catch(error=>{console.error(error);process.exitCode=1;});
