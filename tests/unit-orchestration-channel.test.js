'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createChannel}=require('../main/orchestration/channel');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(dispatch,{busy=()=>false,inject=null}={}){
  const ledger={status:'running'};const roster=[{memberId:'m1',sid:'s1',name:'lead',orchestrator:true},{memberId:'m2',sid:'s2',name:'worker'},{memberId:'m3',sid:'s3',name:'other'}];
  const notices=[];
  const c=createChannel({ledgerFor:()=>ledger,members:()=>roster,persist(){},notify:(...a)=>notices.push(a),dispatch,inject,ensureReady:async()=>{},busy,now:Date.now,isFrozen:()=>false,logger:console});
  return {c,ledger,roster,notices};
}
test('a busy member can still reach the lead; member messages become lead notices',async()=>{
  const calls=[],release=[];const x=fixture((id,a)=>{calls.push(a);return new Promise(r=>release.push(r));});
  x.c.send('r',x.roster[0],{to:'m2',message:'work'});await tick();await tick();
  assert.equal(calls.length,1);
  const r=x.c.send('r',x.roster[1],{to:'m1',message:'question while working'});await tick();await tick();
  assert.equal(calls.length,1,'member → lead no longer starts its own lead turn');
  assert.equal(r.status,'lead_notified');
  assert.match(x.notices[0][2],/question while working/);assert.deepEqual(x.notices[0][3],{quiet:false});
  release.forEach(r=>r({status:'completed'}));await tick();
});
test('wake=false leaves a quiet note; approved peer copies never wake the lead',async()=>{
  const x=fixture(async()=>({status:'completed'}));
  const r=x.c.send('r',x.roster[1],{to:'m1',message:'minor progress',wake:false});
  assert.equal(r.status,'left_for_lead');assert.deepEqual(x.notices.at(-1)[3],{quiet:true});
  assert.throws(()=>x.c.allow('r',x.roster[1],{memberA:'m2',memberB:'m3',allow:true}),/负责人/);
  const g=x.c.allow('r',x.roster[0],{memberA:'m2',memberB:'m3',allow:true,reason:'debate'});
  assert.deepEqual(g.grants,['m2:m3']);
  assert.equal(x.c.state('r').messages.filter(m=>m.type==='decision').length,2,'both members are told');
  x.c.send('r',x.roster[1],{to:'m3',message:'my argument'});
  assert.deepEqual(x.notices.at(-1)[3],{quiet:true});
  x.c.allow('r',x.roster[0],{memberA:'m3',memberB:'m2',allow:false});
  assert.throws(()=>x.c.send('r',x.roster[1],{to:'m3',message:'again'}),/申请/);
});
test('lead interrupt goes into a busy member turn; a definite failure falls back to the queue',async()=>{
  const injected=[];let answer={accepted:true};
  const calls=[];const x=fixture(async(id,a)=>{calls.push(a);return {status:'completed'};},{busy:sid=>sid==='s2',inject:async(id,t,text)=>{injected.push([t.memberId,text]);return answer;}});
  x.c.send('r',x.roster[0],{to:'m2',message:'requirement changed',interrupt:true});
  await tick();await tick();await tick();
  assert.equal(injected.length,1);assert.match(injected[0][1],/负责人追加指示/);assert.match(injected[0][1],/requirement changed/);
  assert.equal(x.c.state('r').messages[0].state,'sent');assert.equal(calls.length,0);
  answer={accepted:false,notSent:true,reason:'cli-busy-rejected'};
  x.c.send('r',x.roster[0],{to:'m2',message:'second',interrupt:true});
  await tick();await tick();await tick();
  const second=x.c.state('r').messages[1];
  assert.equal(second.state,'queued');assert.equal(second.interrupt,false,'falls back to normal delivery when idle');
  assert.ok(x.notices.some(n=>/没能插进/.test(n[2])));
  answer={accepted:false,uncertain:true,reason:'stuck'};
  x.c.send('r',x.roster[0],{to:'m3',message:'idle target',interrupt:true});await tick();await tick();
  assert.equal(calls.length,1,'an idle recipient simply starts a new turn');
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
