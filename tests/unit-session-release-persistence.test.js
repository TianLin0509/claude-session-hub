'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
process.env.CLAUDE_HUB_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hub-release-write-'));
const store=require('../core/session-store');
test('release freezes late writes, waits for in-flight rename and durably preserves the final snapshot',async()=>{
  const original=fs.promises.rename;
  let unblock,entered;
  const waiting=new Promise(resolve=>entered=resolve), gate=new Promise(resolve=>unblock=resolve);
  fs.promises.rename=async(...args)=>{entered();await gate;return original(...args);};
  try {
    const first=store.markDirtyImmediate('session',{kind:'codex',codexSid:'old',title:'old'});
    await waiting;
    const final=store.flushSessionForRelease('session',{kind:'codex',codexSid:'latest',title:'final'});
    const late=store.markDirtyImmediate('session',{kind:'codex',codexSid:'stale',title:'late'});
    store.markDirty('session',{codexSid:'stale-debounce'});
    unblock();await Promise.all([first,final,late]);
    store.flushAll();
    assert.equal(store.loadSessionFile('session').codexSid,'latest');
    store.resumeSessionWrites('session');
    await store.markDirtyImmediate('session',{kind:'codex',codexSid:'next-owner'});
    assert.equal(store.loadSessionFile('session').codexSid,'next-owner');
  } finally {unblock?.();fs.promises.rename=original;}
});
test('corrupt persisted identity is a recovery error, not an empty session',()=>{
  fs.writeFileSync(path.join(process.env.CLAUDE_HUB_DATA_DIR,'sessions','broken.json'),'{broken');
  assert.throws(()=>store.loadSessionFile('broken',{strict:true}));
});
test('a reused PID is not the recorded owner; uncertain process identity is an explicit error',()=>{
  const {matches}=require('../core/owned-process');
  assert.equal(matches(process.pid,1000,()=>900),true);
  assert.equal(matches(process.pid,1000,()=>1100),false);
  assert.throws(()=>matches(process.pid,1000,()=>{throw Error('unreadable');}),/无法核对/);
});
