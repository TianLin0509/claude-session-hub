'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ClaudeStreamClient}=require('../main/claude-stream-client');
test('Claude output yields fairly and consumes complete buffered messages before EOF',async()=>{
  const client=new ClaudeStreamClient(),seen=[];let paused=0;
  client.proc={stdout:{pause(){paused++;},resume(){}}};
  client.on('message',message=>{seen.push(message.i);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);});
  const ended=new Promise(resolve=>client.once('disconnect',resolve));
  let exitSeen;client.on('exit',()=>{exitSeen=seen.length;});
  const frames=Array.from({length:20},(_,i)=>JSON.stringify({type:'assistant',i})+'\n').join('');
  client.consume(frames);assert(seen.length>0 && seen.length<20);assert(paused>0);
  // EOF arrives while a continuation still owns buffered complete messages.
  client.inputEnded=true;client.consume('');
  client.processExit={code:0,signal:null};client.finishProcessExit();
  assert.equal(exitSeen,undefined,'process close waits for buffered receipts');
  assert(await new Promise(resolve=>setImmediate(()=>resolve(seen.length<20))));
  const error=await ended;assert.match(error.message,/stdout ended/);
  assert.deepEqual(seen,Array.from({length:20},(_,i)=>i));assert.equal(client.consumeContinuation,null);
  assert.equal(exitSeen,20);
});
test('deferred malformed frames still produce an explicit protocol error',async()=>{
  const client=new ClaudeStreamClient();client.proc={stdout:{pause(){},resume(){}}};
  client.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10));
  const failed=new Promise(resolve=>client.once('disconnect',resolve));
  client.consume('{"type":"assistant"}\ninvalid-json\n');
  assert.match((await failed).message,/Invalid Claude stream/);assert.equal(client.consumeContinuation,null);
});
