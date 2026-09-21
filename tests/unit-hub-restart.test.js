'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HubRestart,classify,restartToken}=require('../core/hub-restart');
function session(id,state='running',extra={}) {return {id,hubId:id,kind:'codex',title:id,status:'idle',codexSid:'native-'+id,
  runtimeBackend:'codex-app-server',nativeRuntime:{connection:'connected',state,turnId:'turn-'+id,requests:[],submission:{id:'original-'+id,status:'accepted'}},...extra};}
async function harness(t,rows,overrides={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'restart-unit-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const calls=[];
  const deps={directory,pid:100,isAlive:()=>false,sessions:()=>rows,loadSession:id=>rows.find(s=>s.id===id),
    restoreSession:async meta=>{calls.push(['restore',meta.id]);return meta;},prepareContinuation:async()=>({completed:false}),
    sendContinuation:async(row,text,id)=>{calls.push(['send',row.id,id]);return {ok:true,sendStatus:'submitted'};},
    shutdown:async()=>({safeToQuit:true,cleanup:{clean:true}}),...overrides};
  const old=new HubRestart(deps);await old.request({activeSessionId:rows[0]?.id});old.ready();
  const current=new HubRestart({...deps,pid:200});return {old,current,calls,deps,token:old.plan.token};
}
test('restores exact open set and continues only working sessions once',async t=>{
  const rows=[session('work'),session('idle','idle'),session('wait','waiting'),session('sleep','idle',{status:'dormant'})];
  const h=await harness(t,rows);const result=await h.current.restore(h.token);await h.current.restore(h.token);
  assert.deepEqual(h.calls.filter(c=>c[0]==='restore').map(c=>c[1]),['work','idle','wait']);
  assert.deepEqual(h.calls.filter(c=>c[0]==='send').map(c=>c[1]),['work']);
  assert.equal(result.sessions.find(s=>s.id==='wait').status,'waiting');
});
test('provider completion after snapshot skips continuation',async t=>{
  const h=await harness(t,[session('a')],{prepareContinuation:async()=>({completed:true})});
  const result=await h.current.restore(h.token);assert.equal(result.sessions[0].status,'completed');assert.equal(h.calls.filter(c=>c[0]==='send').length,0);
});
test('dispatch checkpoint prevents replay after crash or response loss',async t=>{
  const h=await harness(t,[session('a')]);h.old.plan.phase='restoring';h.old.plan.sessions[0].status='dispatching';h.old.save();
  const result=await h.current.restore(h.token);assert.equal(result.sessions[0].status,'uncertain');assert.deepEqual(h.calls,[['restore','a']]);
});
test('unconfirmed send remains uncertain across reload',async t=>{
  let sends=0;const h=await harness(t,[session('a')],{sendContinuation:async()=>{sends++;return {ok:true,sendStatus:'unknown'};}});
  assert.equal((await h.current.restore(h.token)).sessions[0].status,'uncertain');await h.current.restore(h.token);assert.equal(sends,1);
});
test('identity changes do not spawn a replacement conversation',async t=>{
  const h=await harness(t,[session('a')],{loadSession:()=>session('different')});
  assert.equal((await h.current.restore(h.token)).sessions[0].status,'error');assert.equal(h.calls.length,0);
});
test('live old Hub and live second restorer cannot be taken over',async t=>{
  const h=await harness(t,[session('a')]);h.current.isAlive=()=>true;await assert.rejects(h.current.restore(h.token),/旧 Hub/);
  h.old.plan.restorerPid=300;h.old.save();h.current.isAlive=pid=>pid===300;await assert.rejects(h.current.restore(h.token),/另一 Hub/);
});
test('groups go through one coordinator and never individual continuation sends',async t=>{
  let groups=0;const rows=[session('a','running',{meetingId:'g'}),session('b','idle',{meetingId:'g'})];
  const h=await harness(t,rows,{captureGroups:()=>[{id:'g',sessionIds:['a','b'],status:'pending'}],resumeGroup:async()=>{groups++;}});
  await h.current.restore(h.token);assert.equal(groups,1);assert.equal(h.calls.filter(c=>c[0]==='send').length,0);
});
test('waiting group member blocks automatic group dispatch',async t=>{
  let groups=0;const h=await harness(t,[session('a'),session('b','waiting')],{captureGroups:()=>[{id:'g',sessionIds:['a','b'],status:'pending'}],resumeGroup:async()=>{groups++;}});
  const result=await h.current.restore(h.token);assert.equal(groups,0);assert.equal(result.groups[0].status,'waiting');
});
test('failed flush never reaches shutdown or marks plan ready',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'restart-save-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let exits=0;const h=new HubRestart({directory,sessions:()=>[],flush:async()=>{throw Error('disk full');},shutdown:async()=>{exits++;}});
  await assert.rejects(h.request(),/disk full/);assert.equal(exits,0);assert.equal(h.plan.phase,'failed');
});
test('unknown and nonblocking requests retain native semantics',()=>{
  assert.equal(classify(session('a','running',{nativeRuntime:{connection:'connected',state:'running',requests:[{params:{isBlocking:false}}]}})),'working');
  assert.equal(classify(session('a','running',{nativeRuntime:{connection:'disconnected',state:'running'}})),'unknown');
  assert.equal(classify(session('a','running',{nativeRuntime:{connection:'connected',state:'running',submission:{sendStatus:'queued'}}})),'unknown');
  assert.throws(()=>restartToken(['--hub-restart=../x']),/无效/);
});

test('normalized native receipts require native acknowledgement for ok',async t=>{
  for (const source of ['codex-app-server','claude-stream-json','acp','kimi_wire_turn_prompt','gemini_user_message',null]) {
    const h=await harness(t,[session('a')],{sendContinuation:async()=>({ok:true,sendStatus:'ok',acknowledgementSource:source})});
    assert.equal((await h.current.restore(h.token)).sessions[0].status,source?'continued':'uncertain');
  }
});

test('new restorer reopens completed recovery without replaying continuation',async t=>{
  const h=await harness(t,[session('work'),session('idle','idle')]);await h.current.restore(h.token);
  const next=new HubRestart({...h.deps,pid:300});await next.restore(h.token);
  assert.deepEqual(h.calls.filter(c=>c[0]==='restore').map(c=>c[1]),['work','idle','work','idle']);
  assert.equal(h.calls.filter(c=>c[0]==='send').length,1);
  assert.equal(next.plan.sessions[0].status,'uncertain');
});

test('failed reopening of a previously continued session never enables replay on retry',async t=>{
  const h=await harness(t,[session('work')]);await h.current.restore(h.token);
  let fail=true;
  const next=new HubRestart({...h.deps,pid:300,restoreSession:async meta=>{if(fail)throw Error('locked');return meta;}});
  await next.restore(h.token);assert.equal(next.plan.sessions[0].status,'error');
  fail=false;next.plan.sessions[0].status='pending';next.plan.phase='restoring';next.save();await next.restore(h.token);
  assert.equal(h.calls.filter(c=>c[0]==='send').length,1);assert.equal(next.plan.sessions[0].status,'uncertain');
});

test('retry after interrupted shutdown preserves original open work set',async t=>{
  let rows=[session('work')],fail=true;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'restart-retry-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const h=new HubRestart({directory,sessions:()=>rows,shutdown:async()=>{rows=[];if(fail)throw Error('worker still exiting');return {safeToQuit:true};}});
  await assert.rejects(h.request(),/worker still exiting/);const token=h.plan.token;fail=false;
  await h.request();assert.equal(h.plan.token,token);assert.deepEqual(h.plan.sessions.map(s=>s.id),['work']);
});

test('workflow acceptance follows current stage after a completed-step handoff',()=>{
  const {restartGroupTargets}=require('../main/ipc/hub-restart-handlers');
  const meeting={subSessions:['s1','s2'],serialWorkflow:{steps:[['m1'],['m2']],serialRunState:{currentStepIndex:1},loopState:{currentStep:'reviewer'},fileFlow:{lastDispatch:{memberIds:['m2']}}}};
  for(const kind of ['serial','loop','file'])assert.deepEqual(restartGroupTargets({kind,memberIds:['m1']},meeting),['s2']);
});
