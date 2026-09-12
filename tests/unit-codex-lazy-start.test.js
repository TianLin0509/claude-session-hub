'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CodexNativeSession } = require('../core/codex-native-session');
const { nativeRuntimeTruth, persistNativeRuntime } = require('../core/codex-native-runtime');
const fs=require('fs'),path=require('path'),os=require('os');
const { CodexAppServerClient } = require('../main/codex-app-server-client');
const journal=require('../core/codex-start-journal');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function harness() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-lazy-unit-'));
  const trace=path.join(dir,'trace.jsonl'), store=path.join(dir,'threads.json');
  const opts={id:'seat-1',lazyStart:true,cwd:dir,
    env:{CODEX_HOME:path.join(dir,'codex'),CLAUDE_HUB_DATA_DIR:path.join(dir,'hub')},
    threadParams:{cwd:dir,model:'fixture-model',approvalPolicy:'never',sandbox:'danger-full-access',config:{model_reasoning_effort:'max'}},
    turnParams:{model:'fixture-model',effort:'max'},
    clientFactory:()=>new CodexAppServerClient({cwd:dir,timeoutMs:1500,launch:{command:process.execPath,
      args:[path.join(__dirname,'fixtures/codex-app-server.js')],env:{...process.env,
        CLAUDE_HUB_NATIVE_FIXTURE_STORE:store,CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace,CLAUDE_HUB_NATIVE_FIXTURE_VOLATILE_EMPTY:'1'}}})};
  return {dir,opts,store,make:(extra={})=>new CodexNativeSession({...opts,...extra}),
    calls:()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
async function close(s) {
  const client=s.entry?.client;
  s.kill();
  for(let i=0;i<100 && s.entry;i++)await delay(10);
  assert.equal(s.entry,null);
  if(client)await client.waitForExit();
}

test('an unused development seat survives persistence without becoming a resume request', () => {
  const session = new CodexNativeSession({ id: 'unused-seat', lazyStart: true });
  assert.equal(session.entry, null);
  assert.equal(session.runtime.connection, 'unstarted');
  session.kill(); // Hub shutdown must not turn an unused seat into a broken connection.
  const stored = persistNativeRuntime({ kind: 'codex', nativeRuntime: session.runtime });
  assert.equal(stored.connection, 'unstarted');
  assert.equal(nativeRuntimeTruth({ kind: 'codex', nativeRuntime: stored }).state, 'idle');
  assert.equal(stored.threadId, null);
});
test('explicit Fast on an unused seat enables the capability without launching',async()=>{
  const h=harness();fs.mkdirSync(h.opts.env.CODEX_HOME,{recursive:true});
  fs.writeFileSync(path.join(h.opts.env.CODEX_HOME,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',additional_speed_tiers:['fast']}]}));
  const s=h.make({processArgs:['-c','features.fast_mode=false']});
  try {
    await s.configure({codexSpeedTier:'fast'});
    assert.deepEqual(s.options.processArgs,['-c','features.fast_mode=true']);
    assert.equal(s.options.turnParams.serviceTier,'fast');
    assert.equal(s.pid,null);assert.equal(h.calls().length,0);
  }finally{await close(s);}
});

test('configuration and reading do not start a seat; first send starts exactly one thread',async()=>{
  const h=harness(),s=h.make();
  try {
    await s.configure({model:'fixture-model-2',effort:'xhigh'});
    await s.configure({codexSpeedTier:'standard'});
    assert.equal(s.options.turnParams.serviceTier,'default');
    await assert.rejects(s.configure({codexSpeedTier:'fast'}),/尚未确认 Fast/);
    await s.reconcile();await s.reconnect();assert.deepEqual(s.readTranscript(),[]);
    assert.equal(h.calls().length,0);assert.equal(s.pid,null);
    await Promise.all([s.start(),s.start(),s.start()]);
    const [a,b]=await Promise.all([s.send('one',{clientSubmissionId:'same'}),s.send('one',{clientSubmissionId:'same'})]);
    assert.equal(a.turnId,b.turnId);
    assert.equal(h.calls().filter(x=>x.method==='thread/start').length,1);
    assert.equal(h.calls().filter(x=>x.method==='turn/start').length,1);
    assert.equal(h.calls().find(x=>x.method==='turn/start').params.model,'fixture-model-2');
    assert.equal(h.calls().find(x=>x.method==='turn/start').params.effort,'xhigh');
    assert.equal(journal.read(s.options,s.threadId).submissionAttempted,true);
  } finally {await close(s);}
});

test('unused seat survives backend restart; safe empty thread gets one replacement',async()=>{
  const h=harness();let s=h.make();
  try {
    const untouched=persistNativeRuntime({kind:'codex',nativeRuntime:s.runtime});await close(s);
    s=h.make({restoredRuntime:untouched});assert.equal(s.runtime.connection,'unstarted');assert.equal(h.calls().length,0);
    await s.start();const old=s.threadId,stored=persistNativeRuntime({kind:'codex',nativeRuntime:s.runtime});
    assert.equal(journal.provesUnsubmitted(s.options,old),true);await close(s);
    s=h.make({resumeId:old,restoredRuntime:stored});await s.start();
    assert.notEqual(s.threadId,old);assert.equal(s.runtime.replacedThreadId,old);
    assert.equal(h.calls().filter(x=>x.method==='thread/resume').length,1);
    assert.equal(h.calls().filter(x=>x.method==='thread/start').length,2);
    await s.send('first after restart',{clientSubmissionId:'after-restart'});
    assert.equal(h.calls().filter(x=>x.method==='turn/start').length,1);
  } finally {await close(s);}
});

test('submitted history resumes exact identity and missing history never becomes a fresh task',async()=>{
  const h=harness();let s=h.make();
  try {
    await s.send('already used',{clientSubmissionId:'old'});await s.idle();
    const id=s.threadId,stored=persistNativeRuntime({kind:'codex',nativeRuntime:s.runtime});await close(s);
    s=h.make({resumeId:id,restoredRuntime:stored});await s.start();assert.equal(s.threadId,id);await close(s);
    fs.writeFileSync(h.store,'[]');s=h.make({resumeId:id,restoredRuntime:stored});
    await assert.rejects(s.start(),/no rollout/);
    assert.equal(s.runtime.emptyRecovery,undefined);
    assert.equal(h.calls().filter(x=>x.method==='thread/start').length,1);
  } finally {await close(s);}
});

test('a legacy missing empty thread requires explicit bound confirmation; no resend',async()=>{
  const h=harness();let s=h.make();
  try {
    await s.start();const id=s.threadId,stored=persistNativeRuntime({kind:'codex',nativeRuntime:s.runtime});
    const file=journal.identity(s.options,id).file;await close(s);fs.unlinkSync(file);
    s=h.make({resumeId:id,restoredRuntime:stored});await assert.rejects(s.start(),/no rollout/);
    const recovery=s.runtime.emptyRecovery;assert.equal(recovery.threadId,id);
    await assert.rejects(s.restartEmpty({...recovery,confirmed:false}),/条件/);
    assert.equal(h.calls().filter(x=>x.method==='thread/start').length,1);
    await s.restartEmpty({...recovery,confirmed:true});assert.notEqual(s.threadId,id);
    assert.equal(h.calls().filter(x=>x.method==='turn/start').length,0);
    await assert.rejects(s.restartEmpty({...recovery,confirmed:true}),/条件/);
  } finally {await close(s);}
});

test('write failure prevents network submission and proof corruption cannot authorize replacement',async()=>{
  const h=harness(),s=h.make();
  try {
    await s.start();const file=journal.identity(s.options,s.threadId).file;
    fs.writeFileSync(file,'{broken');
    await assert.rejects(s.send('must never execute'),/凭证/);
    assert.equal(h.calls().filter(x=>x.method==='turn/start').length,0);
  } finally {await close(s);}
});

test('stop cancels queued first messages without starting an unused seat',async()=>{
  const h=harness(),s=h.make();
  try {
    const pending=s.send('cancel this');const rejected=assert.rejects(pending,/停止/);
    await s.interrupt();await rejected;
    assert.equal(h.calls().length,0);
  } finally {await close(s);}
});

test('submission proof stays true even when the local snapshot lost the acceptance',async()=>{
  const h=harness();let s=h.make();
  try {
    await s.start();const id=s.threadId,old=persistNativeRuntime({kind:'codex',nativeRuntime:s.runtime});
    journal.write(s.options,id,true,{submissionId:'receipt-not-yet-saved'});await close(s);
    s=h.make({resumeId:id,restoredRuntime:old});await assert.rejects(s.start(),/no rollout/);
    assert.equal(s.runtime.emptyRecovery,undefined);
    assert.equal(h.calls().filter(x=>x.method==='thread/start').length,1);
  } finally {await close(s);}
});

test('the start journal rejects damaged identity and cannot borrow proof from another profile',async()=>{
  const h=harness(),id='missing-thread';
  journal.write(h.opts,id,false);
  const other={...h.opts,env:{...h.opts.env,CODEX_HOME:path.join(h.dir,'another-profile')}};
  assert.equal(journal.provesUnsubmitted(other,id),false);
  assert.throws(()=>journal.read({...h.opts,id:'different-seat'},id),/身份/);
  fs.writeFileSync(journal.identity(h.opts,id).file,'{}');
  const s=h.make({resumeId:id});
  try {await assert.rejects(s.start(),/凭证/);assert.equal(h.calls().filter(x=>x.method==='thread/start').length,0);}
  finally {await close(s);}
});
