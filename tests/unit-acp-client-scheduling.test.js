'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AcpClient}=require('../main/acp-client');

test('busy ACP output yields to other work without dropping or reordering frames',async()=>{
  const client=new AcpClient(),seen=[];let pauses=0,resumes=0;
  client.proc={stdout:{pause(){pauses++;},resume(){resumes++;}}};
  const frames=Array.from({length:20},(_,i)=>JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{i,text:'中文🧪'}})+'\n').join('');
  const done=new Promise(resolve=>client.on('notification',message=>{
    seen.push(message.params);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
    if(seen.length===20)resolve();
  }));
  client.feed(Buffer.from(frames));
  assert(seen.length>0 && seen.length<20,'a single pipe callback monopolized all frames');
  assert(pauses>0);
  const interleaved=await new Promise(resolve=>setImmediate(()=>resolve(seen.length)));
  assert(interleaved<20,'other Main callbacks never got a chance');
  await done;
  assert.deepEqual(seen,Array.from({length:20},(_,i)=>({i,text:'中文🧪'})));
  assert(resumes>0);assert.equal(client.buffer,'');assert.equal(client.feedContinuation,null);
});

test('failure during a notification stops the remaining buffered events',()=>{
  const client=new AcpClient();let seen=0;
  client.on('notification',()=>{seen++;client.fail(new Error('fixture failure'));});
  const frame=JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{}})+'\n';
  client.feed(Buffer.from(frame.repeat(5)));
  assert.equal(seen,1);assert.equal(client.closed,true);assert.equal(client.feedContinuation,null);
});
