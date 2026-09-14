'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {spawn} = require('child_process');
const {SessionOpenOwnership, nativeKeys} = require('../core/session-open-ownership');
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(),'hub-open-owner-'));

test('one open owner, different sessions coexist, stale releases cannot unlock the new owner', () => {
  const root=directory(), living=new Set([10,20]);
  const a=new SessionOpenOwnership({directory:root,pid:10,isAlive:id=>living.has(id)});
  const b=new SessionOpenOwnership({directory:root,pid:20,isAlive:id=>living.has(id)});
  try {
    const first=a.claim('A');
    assert.throws(()=>b.claim('A'),e=>e.code==='SESSION_OCCUPIED' && e.owner.pid===10);
    let edits = 0;
    assert.throws(()=>b.editSessions(['B','A'],()=>edits++,{allowOwn:true}),e=>e.code==='SESSION_OCCUPIED');
    assert.equal(edits,0,'all members are checked before any deletion');
    a.editSessions(['A'],()=>edits++,{allowOwn:true});
    assert.equal(edits,1);
    assert.throws(()=>a.editClosed('A',()=>edits++),e=>e.code==='SESSION_OCCUPIED');
    const other=b.claim('B'); b.release(other);
    a.release(first); const next=b.claim('A'); a.release(first);
    assert.equal(a.owner('A').pid,20);
    b.release(next); assert.equal(a.owner('A'),null);
  } finally {a.close();b.close();}
});
test('a dead Hub does not release a surviving engine; dead owners are recovered on click without a timer', () => {
  const living=new Set([10,30]), root=directory();
  const a=new SessionOpenOwnership({directory:root,pid:10,isAlive:id=>living.has(id)});
  const b=new SessionOpenOwnership({directory:root,pid:20,isAlive:id=>living.has(id)});
  try {
    const first=a.claim('A'); a.bindPid(first,30);living.delete(10);
    assert.throws(()=>b.claim('A'),/PID 10/);
    living.delete(30);living.add(20);const next=b.claim('A');b.release(next);
  } finally {a.close();b.close();}
});
test('native aliases prevent reopening through a different Hub card; forks have their own identity', () => {
  const root=directory(), store=new SessionOpenOwnership({directory:root});
  try {
    const keys=nativeKeys('codex',{codexSid:'thread'},{CODEX_HOME:root});
    const first=store.claim('card-a',keys);
    assert.throws(()=>store.claim('card-b',keys),/已在 AI HUB/);
    assert.equal(store.owner('card-b'),null,'failed multi-key claim rolls back the Hub ID');
    const fork=store.claim('fork',nativeKeys('codex',{codexSid:'thread',codexForkSid:'thread'},{CODEX_HOME:root}));
    store.release(fork);store.release(first);
  } finally {store.close();}
});
async function childReplies(codes) {
  const children=codes.map(code=>spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe'],windowsHide:true}));
  const records=children.map(child=>{
    const record={child,stderr:''};
    child.stderr.on('data',data=>{record.stderr+=String(data);});
    record.exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
    return record;
  });
  try {
    const replies=records.map(record=>new Promise((resolve,reject)=>{
      const {child}=record;
      const timeout=setTimeout(()=>reject(Error('claim child timed out: '+record.stderr)),15000);
      const fail=error=>{clearTimeout(timeout);reject(error);};
      child.once('error',fail);child.stdin.once('error',fail);
      child.stdout.once('data',data=>{clearTimeout(timeout);resolve(String(data).trim());});
      child.once('exit',code=>fail(Error('unexpected exit '+code+': '+record.stderr)));
    }));
    for(const child of children)child.stdin.write('open');
    return await Promise.all(replies);
  } finally {
    await Promise.all(records.map(async({child,exited})=>{
      child.stdin.end();
      // The exit listener was installed at spawn time: an early failure cannot
      // disappear while another child's result is being awaited.
      const timeout=setTimeout(()=>child.kill(),3000);
      try {await exited;} finally {clearTimeout(timeout);}
    }));
  }
}
test('early child failure preserves stderr and never hangs cleanup',async()=>{
  await assert.rejects(childReplies(["process.stdin.once('data',()=>{console.error('startup failed');process.exit(42);});"]),/unexpected exit 42: startup failed/);
});
test('simultaneous processes cannot both open the same session', async () => {
  const root=directory();
  const code=`const {SessionOpenOwnership}=require(${JSON.stringify(path.resolve(__dirname,'../core/session-open-ownership'))});const s=new SessionOpenOwnership({directory:${JSON.stringify(root)}});process.stdin.once('data',()=>{try{s.claim('race');console.log('won');}catch(e){console.log(e.code);} });process.stdin.resume();`;
  assert.deepEqual((await childReplies([code,code])).sort(),['SESSION_OCCUPIED','won']);
  const store=new SessionOpenOwnership({directory:root});try{store.release(store.claim('race'));}finally{store.close();}
});
