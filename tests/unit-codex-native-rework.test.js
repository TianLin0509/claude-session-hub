'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {CodexNativeSession,pool}=require('../core/codex-native-session');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const watcher=require('../core/group-chat-watcher');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('condition timeout');await sleep(5);}}
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-rework-')),trace=path.join(root,'trace.jsonl');
  const make=id=>new CodexNativeSession({id,cwd:root,env:{CODEX_HOME:root,CLAUDE_HUB_DATA_DIR:path.join(root,'hub')},
    threadParams:{model:'fixture-model'},turnParams:{model:'fixture-model',effort:'max'},
    clientFactory:()=>new CodexAppServerClient({cwd:root,timeoutMs:1500,launch:{command:process.execPath,
      args:[path.join(__dirname,'fixtures/codex-app-server.js')],env:{...process.env,CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}}})});
  return {make,calls:()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse)};
}
async function close(s){const client=s.entry?.client;s.kill();await until(()=>!s.entry);if(client?.closed)await client.waitForExit();}
function stateSession(){
  const s=new CodexNativeSession({id:'request-regression',threadParams:{},turnParams:{}});s.threadId='t';
  s.apply({type:'snapshot',thread:{id:'t',status:{type:'idle'},turns:[]}});
  const event=(method,params)=>s.notification({method,params:{threadId:s.threadId,...params}});
  const request=(id,turnId)=>s.apply({type:'request',threadId:s.threadId,request:{id,method:'item/tool/requestUserInput',params:{threadId:'t',turnId,questions:[]}}});
  return {s,event,request};
}
for(const error of ['systemError','notLoaded','conflicting-turn'])test('R1: old and current resolutions preserve '+error,()=>{
  const {s,event,request}=stateSession();
  event('turn/started',{turn:{id:'old'}});request(123,'old');event('serverRequest/resolved',{requestId:123});
  event('turn/completed',{turn:{id:'old',status:'completed'}});event('turn/started',{turn:{id:'new'}});request(456,'new');
  if(error==='conflicting-turn')event('turn/started',{turn:{id:'another'}});
  else event('thread/status/changed',{status:{type:error}});
  assert.equal(s.runtime.state,'unknown');const before=s.runtime;
  for(const id of [123,999,'456']) {event('serverRequest/resolved',{requestId:id});assert.equal(s.runtime,before,'unowned ID is a no-op including revision');}
  s.apply({type:'resolved',epoch:s.runtime.epoch-1,threadId:'t',requestId:456});assert.equal(s.runtime,before);
  event('serverRequest/resolved',{threadId:'other',requestId:456});assert.equal(s.runtime,before);
  event('serverRequest/resolved',{requestId:456});
  assert.equal(s.runtime.requests.length,0);assert.equal(s.runtime.state,'unknown');assert.equal(s.runtime.reason,before.reason);
  const resolved=s.runtime;event('serverRequest/resolved',{requestId:456});assert.equal(s.runtime,resolved);
  s.apply({type:'status',threadId:'t',status:{type:'active',activeFlags:[]}});
  assert.equal(s.runtime.state,'unknown','thread activity alone cannot reconcile the uncertain turn identity');
  request(789,'new');assert.equal(s.runtime.state,'unknown','new interaction is not execution reconciliation');
  event('serverRequest/resolved',{requestId:789});assert.equal(s.runtime.state,'unknown');
  s.apply({type:'snapshot',thread:{id:'t',status:{type:'active',activeFlags:[]},turns:[{id:'new',status:'inProgress'}]}});
  assert.equal(s.runtime.state,'running');assert.equal(s.runtime.reason,null);
});
test('R1: current concurrent requests clear normally, duplicate resolution changes nothing',()=>{
  const {s,event,request}=stateSession();event('turn/started',{turn:{id:'turn'}});
  request(1,'turn');request(2,'turn');event('serverRequest/resolved',{requestId:1});assert.equal(s.runtime.state,'waiting');
  const before=s.runtime;event('serverRequest/resolved',{requestId:1});assert.equal(s.runtime,before);
  event('serverRequest/resolved',{requestId:2});assert.equal(s.runtime.state,'running');
});
for(const route of ['ordinary','groupchat','compact','review'])test('R2: close cancels '+route+' queued work before interrupt completes',async()=>{
  const f=fixture(),s=f.make('closing'),other=f.make('other');
  try{
    await Promise.all([s.start(),other.start()]);assert.equal(s.pid,other.pid);
    await s.send('fixture:stop-delayed');const baseline=s.listenerCount('state');
    watcher.init({sessionManager:{getNativeCodex:()=>s}});
    const send=text=>route==='groupchat'?watcher.sendToPty('closing',text,'codex'):s.send(text);
    const pending=send(route==='compact'?'/compact':route==='review'?'/review':'queued-'+route).then(()=>({ok:true}),error=>({error}));
    const behind=s.send('queued-steer',{requireReady:false}).then(()=>({ok:true}),error=>({error}));
    await until(()=>s.listenerCount('state')>baseline);
    s.kill();
    const result=await Promise.race([Promise.all([pending,behind]),sleep(100).then(()=>null)]);
    assert.ok(result,'queued promises reject before the delayed interrupt terminal');
    for(const r of result)assert.match(r.error?.message||'',/关闭|取消/);
    // Only close's own native outcome waiter may remain until termination.
    await until(()=>!s.entry);assert.equal(s.listenerCount('state'),baseline);
    const forbidden=f.calls().filter(c=>['turn/start','turn/steer','thread/compact/start','review/start'].includes(c.method)&&c.params.threadId===s.threadId);
    assert.equal(forbidden.length,1,JSON.stringify(forbidden));
    await other.send('fixture:empty');assert.equal(other.runtime.state,'completed');
    assert.equal(other.entry.client.pending.size,0);
  }finally{await close(s);await close(other);}
  assert.equal(pool.size,0);
});
test('R2: stop retains queue semantics and sends exactly one next turn',async()=>{
  const f=fixture(),s=f.make('stop');try{
    await s.send('fixture:stop-delayed');const baseline=s.listenerCount('state');
    const next=s.send('fixture:empty',{clientSubmissionId:'next'});
    await until(()=>s.listenerCount('state')>baseline);await s.interrupt();await next;
    assert.equal(s.runtime.state,'completed');assert.equal(f.calls().filter(c=>c.method==='turn/start').length,2);
    assert.equal(s.listenerCount('state'),baseline);
  }finally{await close(s);}
});

test('R2: cancellation at the stdio write boundary never breaks a pooled sibling',async()=>{
  const f=fixture(),s=f.make('blocked-write'),other=f.make('sibling');let release;
  try{
    await Promise.all([s.start(),other.start()]);const client=s.entry.client;
    client.writeTail=new Promise(r=>{release=r;});
    const pending=s.send('forbidden-at-write',{clientSubmissionId:'blocked-write'}).then(()=>({ok:true}),error=>({error}));
    await until(()=>[...client.pending.values()].some(p=>p.method==='turn/start'));
    s.kill();const cancelled=await pending;assert.match(cancelled.error.message,/取消/);release();
    await until(()=>!s.entry);await other.send('fixture:empty');
    assert.equal(f.calls().filter(c=>c.method==='turn/start'&&c.params.threadId===s.threadId).length,0);
    assert.equal(other.runtime.state,'completed');assert.equal(client.closed,false);assert.equal(client.pending.size,0);
    assert.equal(s.runtime.submission.status,'rejected','known unsent cancellation is not an ambiguous submission');
  }finally{release?.();await close(s);await close(other);}
});
test('R2: failed shared close never reactivates cancelled intentions',async()=>{
  const f=fixture(),s=f.make('close-fails'),other=f.make('sibling');
  try{
    await Promise.all([s.start(),other.start()]);await s.send('fixture:stop-failed');const baseline=s.listenerCount('state');
    const pending=s.send('must-stay-cancelled').then(()=>({ok:true}),error=>({error}));
    const steer=s.send('must-not-steer',{requireReady:false}).then(()=>({ok:true}),error=>({error}));
    await until(()=>s.listenerCount('state')>baseline);let closeError;s.once('action-error',e=>{closeError=e;});s.kill();
    assert.match((await pending).error.message,/取消/);assert.match((await steer).error.message,/取消/);
    await until(()=>closeError);assert.equal(s.closed,false);await s.queue;
    assert.equal(s.listenerCount('state'),baseline);
    assert.equal(f.calls().filter(c=>['turn/start','turn/steer'].includes(c.method)&&c.params.threadId===s.threadId).length,1);
    await other.send('fixture:empty');assert.equal(other.runtime.state,'completed');
    await s.send('new-explicit-steer',{requireReady:false});
    assert.equal(f.calls().filter(c=>c.method==='turn/steer').length,1,'only a fresh explicit intention may proceed');
  }finally{await close(other);await close(s);}
});
for(const change of ['epoch','thread','connection','configuration'])test('R2: recheck '+change+' after idle before submitting',async()=>{
  const f=fixture(),s=f.make('changed');let restore;
  try{
    await s.send('fixture:hold');const baseline=s.listenerCount('state');
    const pending=s.send('must-not-send-after-change').then(()=>({ok:true}),error=>({error}));
    await until(()=>s.listenerCount('state')>baseline);
    const listener=r=>{
      if(r.state!=='interrupted')return;s.off('state',listener);
      if(change==='epoch'){const epoch=r.epoch;s.apply({type:'connect',epoch:epoch+1});restore=()=>{s.runtime.epoch=epoch;};}
      if(change==='thread'){const id=s.threadId;s.threadId='different-thread';restore=()=>{s.threadId=id;};}
      if(change==='connection')s.apply({type:'disconnect',reason:'test EOF'});
      if(change==='configuration')s.apply({type:'configuration',error:'test policy mismatch'});
    };
    s.on('state',listener);await s.interrupt();assert.ok((await pending).error);
    assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);
    assert.equal(s.listenerCount('state'),baseline);
  }finally{restore?.();await close(s);}
});
const {SessionManager}=require('../core/session-manager');
function attach(manager,s){
  const info={id:s.options.id,kind:'codex',runtimeBackend:'codex-app-server',codexSid:s.threadId,nativeRuntime:s.runtime};
  manager.sessions.set(info.id,{info,pty:s,pendingTimers:[],startedAt:Date.now()});
  s.on('state',r=>{info.nativeRuntime=r;});s.onExit(e=>manager._handlePtyExit(info.id,s,e));
}
for(const action of ['close','suspend','shutdown'])test('R2: real SessionManager '+action+' cancels pending native work',async()=>{
  const f=fixture(),s=f.make('managed'),manager=new SessionManager();
  try{
    await s.send('fixture:hold');attach(manager,s);const baseline=s.listenerCount('state');
    const pending=s.send('forbidden-managed-'+action).then(()=>({ok:true}),error=>({error}));
    await until(()=>s.listenerCount('state')>baseline);
    if(action==='shutdown'){
      const result=await manager.disposeGracefully({warnAfterMs:0,drainTimeoutMs:4000});assert.equal(result.safeToQuit,true);
    }else if(action==='close')manager.closeSession(s.options.id);
    else {
      assert.equal(manager.suspendSession(s.options.id).error,'native-turn-unfinished');
      // Exercise the terminal notification/idle continuation race through the
      // real suspend gate. A live turn cannot be forced dormant.
      let suspended;
      const listener=r=>{if(r.state==='interrupted'){s.off('state',listener);suspended=manager.suspendSession(s.options.id);}};
      s.on('state',listener);await s.interrupt();await until(()=>suspended);assert.equal(suspended.ok,true,JSON.stringify(suspended));
    }
    assert.match((await pending).error.message,/取消/);await until(()=>!s.entry);
    assert.equal(manager.sessions.size,0);assert.equal(s.listenerCount('state'),baseline);
    assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);
  }finally{await close(s);}
});

for(const command of ['/compact','/review'])test('R2: '+command+' cannot start work if uncertainty arrives after idle',async()=>{
  const f=fixture(),s=f.make('command-error');try{
    await s.send('fixture:hold');const baseline=s.listenerCount('state');
    const pending=s.send(command).then(()=>({ok:true}),error=>({error}));await until(()=>s.listenerCount('state')>baseline);
    const listener=r=>{if(r.state==='interrupted'){s.off('state',listener);s.apply({type:'snapshot',thread:{id:s.threadId,status:{type:'systemError'},turns:[]}});}};
    s.on('state',listener);await s.interrupt();assert.ok((await pending).error);
    assert.equal(f.calls().filter(c=>['review/start','thread/compact/start'].includes(c.method)).length,0);
  }finally{await close(s);}
});
