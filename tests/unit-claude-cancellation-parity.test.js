'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ClaudeNativeSession}=require('../core/claude-native-session');
const {claudeRuntimeTruth}=require('../core/claude-native-runtime');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate) {const until=Date.now()+5000;while(!predicate()){if(Date.now()>until)throw Error('condition timed out');await sleep(10);}}
for(const mode of ['late-requests','queued-permission','queued-question','no-confirmation'])test('Claude Stop revokes '+mode,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-claude-cancel-parity-'));
  const session=new ClaudeNativeSession({cwd:root,executable:process.execPath,
    commandArgs:[path.join(__dirname,'fixtures/claude-cancel-race.js')],cancelTimeoutMs:mode==='no-confirmation'?100:3000});
  t.after(()=>session.close());await session.start();await session.submit(mode,{clientSubmissionId:mode});
  let release,reply,old;
  if(mode.startsWith('queued-')) {
    await until(()=>session.runtime.requests.length);old=session.runtime.requests[0];
    session.client.writeQueue=session.client.writeQueue.then(()=>new Promise(resolve=>{release=resolve;}));
    reply=assert.rejects(session.respond(old.id,{behavior:'allow',updatedInput:old.raw.input},old),/已失效/);
    await until(()=>release);
  }
  const stopped=session.interrupt();
  assert.equal(session.runtime.cancellation?.status,'pending','Stop latches before any transport await');
  const cancellation=session.cancellation;
  await session.interrupt();assert.equal(session.cancellation,cancellation,'double Stop keeps one request and deadline');
  assert.equal(session.runtime.requests.length,0);
  assert.equal(claudeRuntimeTruth({nativeRuntime:session.runtime}).cancellation.status,'pending');
  await assert.rejects(session.submit('must not send'),/正在停止/);
  if(old)await assert.rejects(session.respond(old.id,{behavior:'allow'},old),/已失效/);
  release?.();await stopped;await reply;
  await until(()=>['interrupted','unknown'].includes(session.runtime.state));
  assert.equal(fs.existsSync(path.join(root,'side-effect.txt')),false);
  const responses=fs.readFileSync(path.join(root,'responses.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert(responses.every(response=>response.response.behavior==='deny'));
  if(mode==='no-confirmation') {
    assert.equal(session.runtime.state,'unknown');assert.equal(session.runtime.cancellation.status,'unknown');
    assert.match(session.runtime.reason,/停止未在期限/);await assert.rejects(session.submit('never replay'),/正在停止/);
    assert.equal(session.client.failure,null,'a missing receipt must not kill the live writer');
    assert.equal(session.client.closed,false);
    // An exact late terminal receipt still settles the original cancellation.
    session.client.receive({type:'result',session_id:session.sessionId,uuid:'late-stop-result',subtype:'success',
      is_error:false,result:'',terminal_reason:'aborted_streaming',origin:{kind:'human'}});
    assert.equal(session.runtime.state,'interrupted');assert.equal(session.runtime.cancellation,null);
  } else {assert.equal(session.runtime.state,'interrupted');assert.equal(session.runtime.cancellation,null);}
});
