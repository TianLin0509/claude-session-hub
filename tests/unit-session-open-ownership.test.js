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

for (const legacy of [false,true]) test(`synchronized ${legacy ? 'legacy migration' : 'first WAL initialization'} preserves exactly one session owner`, async () => {
  const root=directory(), gate=path.join(root,'go'), count=8;
  if(legacy){
    const {DatabaseSync}=require('node:sqlite');
    const seed=new DatabaseSync(path.join(root,'session-open-owners.sqlite'));
    seed.exec('CREATE TABLE open_owners (key TEXT PRIMARY KEY, session TEXT NOT NULL, pid INTEGER NOT NULL, version TEXT, nonce TEXT NOT NULL, server_pid INTEGER)');
    seed.close();
  }
  const codes=Array.from({length:count},(_,index)=>`
    const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
    const original=DatabaseSync.prototype.exec;let gated=false;
    DatabaseSync.prototype.exec=function(sql){
      if(!gated && sql.includes('PRAGMA journal_mode=WAL')){
        gated=true;fs.writeFileSync(${JSON.stringify(path.join(root,'ready-'))}+${index},'ready');
        const deadline=Date.now()+10000;
        while(!fs.existsSync(${JSON.stringify(gate)})){
          if(Date.now()>deadline)throw Error('WAL barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
        }
      }
      return original.call(this,sql);
    };
    const {SessionOpenOwnership}=require(${JSON.stringify(path.resolve(__dirname,'../core/session-open-ownership'))});
    const store=new SessionOpenOwnership({directory:${JSON.stringify(root)},isAlive:()=>true});
    process.stdin.once('data',()=>{try{store.claim('race');console.log('won');}catch(error){console.log(error.code);}});
    process.stdin.resume();
  `);
  const release=async()=>{
    const deadline=Date.now()+10000;
    while(!Array.from({length:count},(_,index)=>fs.existsSync(path.join(root,'ready-'+index))).every(Boolean)){
      if(Date.now()>deadline)throw Error('children did not reach WAL barrier');
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    fs.writeFileSync(gate,'go');
  };
  const [replies]=await Promise.all([childReplies(codes),release()]);
  assert.equal(replies.filter(reply=>reply==='won').length,1);
  assert.equal(replies.filter(reply=>reply==='SESSION_OCCUPIED').length,count-1);
});

test('WAL initialization does not swallow permanent errors and closes failed connections', () => {
  const {DatabaseSync}=require('node:sqlite');
  const originalExec=DatabaseSync.prototype.exec,originalClose=DatabaseSync.prototype.close;
  const failure=Object.assign(new Error('disk I/O error'),{code:'ERR_SQLITE_ERROR',errcode:10});
  let closed=0;
  DatabaseSync.prototype.exec=function(sql){if(sql.includes('PRAGMA journal_mode=WAL'))throw failure;return originalExec.call(this,sql);};
  DatabaseSync.prototype.close=function(){closed++;return originalClose.call(this);};
  try {assert.throws(()=>new SessionOpenOwnership({directory:directory()}),error=>error===failure);assert.equal(closed,1);}
  finally {DatabaseSync.prototype.exec=originalExec;DatabaseSync.prototype.close=originalClose;}
});

test('persistent initialization contention is bounded and every failed connection closes', () => {
  const {DatabaseSync}=require('node:sqlite');
  const originalExec=DatabaseSync.prototype.exec,originalClose=DatabaseSync.prototype.close;
  const failure=Object.assign(new Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5});
  let attempts=0,closed=0;
  DatabaseSync.prototype.exec=function(sql){if(sql.includes('PRAGMA journal_mode=WAL')){attempts++;throw failure;}return originalExec.call(this,sql);};
  DatabaseSync.prototype.close=function(){closed++;return originalClose.call(this);};
  try {
    const started=performance.now();
    assert.throws(()=>new SessionOpenOwnership({directory:directory()}),error=>error===failure);
    assert.ok(attempts>1);assert.equal(closed,attempts);
    assert.ok(performance.now()-started<5000,'initialization retry must terminate');
  } finally {DatabaseSync.prototype.exec=originalExec;DatabaseSync.prototype.close=originalClose;}
});
