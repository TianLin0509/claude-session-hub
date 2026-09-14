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
test('simultaneous processes cannot both open the same session', async () => {
  const root=directory();
  const code=`const {SessionOpenOwnership}=require(${JSON.stringify(path.resolve(__dirname,'../core/session-open-ownership'))});const s=new SessionOpenOwnership({directory:${JSON.stringify(root)}});process.stdin.once('data',()=>{try{s.claim('race');console.log('won');}catch(e){console.log(e.code);} });process.stdin.resume();`;
  const children=[0,1].map(()=>spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe'],windowsHide:true}));
  try {
    const replies=children.map(child=>new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',data=>resolve(String(data).trim()));child.once('exit',code=>reject(Error('unexpected exit '+code)));}));
    for(const child of children)child.stdin.write('open');
    assert.deepEqual((await Promise.all(replies)).sort(),['SESSION_OCCUPIED','won']);
  } finally {await Promise.all(children.map(child=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end();})));}
  const store=new SessionOpenOwnership({directory:root});try{store.release(store.claim('race'));}finally{store.close();}
});
