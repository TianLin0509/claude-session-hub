'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {sessionHistory}=require('../core/company-bridge/session-history');
const {recordsFromStatus,sessionBadge,createBridgeThreadController}=require('../renderer/bridge-thread-renderer');
test('session history includes older-than-60 records and both directions; SQL parameters isolate sessions',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    for(const table of ['bridge_threads','consult_threads','home_threads']){
      db.exec(`CREATE TABLE ${table}(payload TEXT,updated INTEGER)`);
      for(let i=0;i<70;i++)db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(JSON.stringify({id:table+i,sessionId:i===0?'old-session':'other',rounds:[{question:'完整提问',reply:'完整回答'}]}),i);
    }
    const home=sessionHistory(db,'home','old-session'), company=sessionHistory(db,'company','old-session');
    assert.equal(home.threads.length,1); assert.equal(home.consults.length,1);
    assert.equal(company.askHome.length,1); assert.equal(home.threads[0].rounds[0].reply,'完整回答');
    assert.throws(()=>sessionHistory(db,'home',"x' OR 1=1--"));
  } finally {db.close();}
});
test('older in-flight task takes badge precedence over newer completed task',()=>{
  const records=recordsFromStatus({role:'home',threads:[
    {id:'running',sessionId:'s',rounds:[{round:1,status:'running',sentAt:1000,startedAt:2000}]},
    {id:'done',sessionId:'s',rounds:[{round:1,reply:'已答',sentAt:3000,replyAt:4000}]}]});
  assert.equal(sessionBadge('s',records,5000).state,'running');
  records.running.rounds[0].reply='现在完成';
  assert.equal(sessionBadge('s',records,5000).state,'done');
});
test('history remains available when dashboard omits it or refresh fails; reads never send messages',async()=>{
  const calls=[];let fail=false;
  const controller=createBridgeThreadController({doc:{querySelectorAll:()=>[],dispatchEvent:()=>{}},deps:{},invoke:async channel=>{
    calls.push(channel);
    if(channel==='bridge:status')return {role:'home',threads:[]};
    if(fail)throw Error('temporary failure');
    return {role:'home',threads:[{id:'old',sessionId:'s',rounds:[{round:1,reply:'完成',replyAt:1000}]}]};
  }});
  await controller.ensureHistory('s');
  assert.equal(controller.badge('s').state,'done');
  await controller.load();fail=true;await controller.ensureHistory('s',true);
  assert.equal(controller.badge('s').state,'done');
  assert(calls.every(c=>['bridge:status','bridge:session-history'].includes(c)));
});
test('pending old history cannot roll a newer completion back to running',async()=>{
  let release, count=0;
  const st=reply=>({role:'home',threads:[{id:'q',sessionId:'s',rounds:[{round:1,status:'running',reply}]}]});
  const c=createBridgeThreadController({doc:{querySelectorAll:()=>[],dispatchEvent:()=>{}},deps:{},invoke:async channel=>{
    if(channel==='bridge:status')return st('完成');
    if(++count===1)return new Promise(resolve=>{release=resolve;});
    return st('完成');
  }});
  const old=c.ensureHistory('s');const updated=c.load();
  await new Promise(resolve=>setImmediate(resolve));
  release(st(''));await Promise.all([old,updated]);
  assert.equal(c.badge('s').state,'done');assert.equal(count,2);
});
test('archive-only session has a permanent history entry',async()=>{
  const c=createBridgeThreadController({doc:{querySelectorAll:()=>[],dispatchEvent:()=>{}},deps:{},invoke:async()=>({role:'company',threads:[{id:'q#123',sessionId:'old',rounds:[{round:1,reply:'旧回复'}]}]})});
  await c.ensureHistory('old');assert.equal(c.badge('old').state,'archived');
  assert.equal(c.badge('unrelated'),null);
});
