'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {readOtherHubSessions}=require('../core/native-session-ownership');
test('concurrent ownership checks share one authenticated Main request and recheck on the next wave',async t=>{
  let calls=0,fail=false;
  const rows=[{id:'c',kind:'claude',ccSessionId:'uuid'},{id:'x',kind:'codex',codexSid:'thread'}];
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      calls++;assert.equal(req.url,'/api/native-ownership');assert.equal(JSON.parse(body).token,'secret');
      setTimeout(()=>{res.writeHead(fail?503:200);res.end(JSON.stringify({pid:process.pid,sessions:rows}));},10);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const control={nativeOwnershipVersion:1,pid:process.pid,hookPort:server.address().port,token:'secret'};
  const results=await Promise.all(Array.from({length:30},()=>readOtherHubSessions(control)));
  assert.equal(calls,1);assert(results.every(r=>JSON.stringify(r)===JSON.stringify(rows)));
  rows.push({id:'new',kind:'claude',ccSessionId:'new-uuid'});
  assert.equal((await readOtherHubSessions(control)).length,3);assert.equal(calls,2);
  fail=true;await assert.rejects(readOtherHubSessions(control),/503/);
  fail=false;assert.equal((await readOtherHubSessions(control)).length,3);
  await assert.rejects(readOtherHubSessions({...control,pid:process.pid+1}),/身份不匹配/);
});
