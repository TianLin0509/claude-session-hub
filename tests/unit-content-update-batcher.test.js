'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createContentUpdateBatcher}=require('../core/content-update-batcher');
test('one content notification per submission, with final content flushed before completion',()=>{
  const updates=[],batch=createContentUpdateBatcher();
  for(let i=0;i<500;i++)batch.schedule('claude','user-1',()=>updates.push(i));
  batch.schedule('codex','turn-1',()=>updates.push('codex'));
  batch.schedule('claude','user-2',()=>updates.push('second'));
  batch.flush('claude');updates.push('complete');
  assert.deepEqual(updates,[499,'second','complete']);
  batch.dispose();assert.deepEqual(updates,[499,'second','complete','codex']);
});
test('a failed consumer is visible and does not swallow another session update',()=>{
  const errors=[],updates=[],batch=createContentUpdateBatcher({onError:e=>errors.push(e.message)});
  batch.schedule('a','1',()=>{throw Error('failed write');});batch.schedule('b','2',()=>updates.push('b'));
  batch.flush();assert.deepEqual(errors,['failed write']);assert.deepEqual(updates,['b']);batch.dispose();
});
test('finishing another session repeatedly cannot postpone a live stream deadline',async()=>{
  const updates=[],batch=createContentUpdateBatcher({delayMs:30});
  const timer=setInterval(()=>{batch.schedule('finished','1',()=>{});batch.flush('finished');},5);
  try {batch.schedule('live','1',()=>updates.push('live'));await new Promise(resolve=>setTimeout(resolve,90));assert.deepEqual(updates,['live']);}
  finally {clearInterval(timer);batch.dispose();}
});
