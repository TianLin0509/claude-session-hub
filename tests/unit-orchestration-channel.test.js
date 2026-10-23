'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createChannel}=require('../main/orchestration/channel');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(dispatch){
  const ledger={status:'running'};const roster=[{memberId:'m1',sid:'s1',name:'lead',orchestrator:true},{memberId:'m2',sid:'s2',name:'worker'},{memberId:'m3',sid:'s3',name:'other'}];
  const notices=[];
  const c=createChannel({ledgerFor:()=>ledger,members:()=>roster,persist(){},notify:(...a)=>notices.push(a),dispatch,ensureReady:async()=>{},busy:()=>false,now:Date.now,isFrozen:()=>false,logger:console});
  return {c,ledger,roster,notices};
}
test('a busy member turn does not prevent communication with another recipient',async()=>{
  const calls=[],release=[];const x=fixture((id,a)=>{calls.push(a);return new Promise(r=>release.push(r));});
  x.c.send('r',x.roster[0],{to:'m2',message:'work'});await tick();await tick();
  assert.equal(calls.length,1);
  x.c.send('r',x.roster[1],{to:'m1',message:'question while working'});await tick();await tick();
  assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.targetMemberIds[0]),['m2','m1']);
  release.forEach(r=>r({status:'completed'}));await tick();
});
test('dispatcher rechecks pause after enqueue and retains message for resume',async()=>{
  let queued,release;const x=fixture((id,a)=>{queued=a;return new Promise(r=>release=r);});
  x.c.send('r',x.roster[0],{to:'m2',message:'work'});await tick();await tick();
  assert.equal(queued.shouldDispatch(),true);x.ledger.status='halted';assert.equal(queued.shouldDispatch(),false);
  release({status:'error',cancelledBeforeDispatch:true,turnNum:null});await tick();assert.equal(x.c.state('r').messages[0].state,'queued');
});
test('missing recipient and uncertain restart remain visible without automatic duplicate sends',()=>{
  const x=fixture(async()=>({status:'completed'}));
  x.ledger.channel={messages:[{id:'a',from:'m1',to:'removed',state:'queued'},{id:'b',from:'m1',to:'m2',state:'sending'}],requests:[],grants:[]};
  x.c.recover('r');assert.equal(x.ledger.channel.messages[1].state,'failed');
  return x.c.flush('r').then(()=>{assert.equal(x.ledger.channel.messages[0].state,'failed');assert.equal(x.notices.length,2);});
});
