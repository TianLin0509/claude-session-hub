'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('path');
const {CodexNativeSession,pool}=require('../core/codex-native-session');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const {createNativeRuntime,reduceNativeRuntime}=require('../core/codex-native-runtime');
const fs=require('fs'),os=require('os');
const testHome=fs.mkdtempSync(path.join(os.tmpdir(),'native-unit-home-'));
function fixtureClient(options) {
  const client = new CodexAppServerClient(options);
  const request = client.request.bind(client);
  // initialize includes spawning a real Node process. Keep the 1.5s timeout
  // used by lost-response tests, but do not use it as a process-start budget.
  client.request = (method, params, timeoutMs, writeOptions) => request(method, params,
    timeoutMs ?? (method === 'initialize' ? 10_000 : 1500), writeOptions);
  return client;
}
function make(id='hub-1') {
  return new CodexNativeSession({id,cwd:__dirname,env:{case:'native-tests',CODEX_HOME:testHome,CLAUDE_HUB_DATA_DIR:path.join(testHome,'hub')},threadParams:{model:'fixture-model'},turnParams:{model:'fixture-model',effort:'max'},
    clientFactory:()=>fixtureClient({cwd:__dirname,timeoutMs:1500,
      launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/codex-app-server.js')],env:process.env}})});
}
async function until(check) {
  const end=Date.now()+3000;
  while(!check()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,10));}
}
async function close(s){s.kill();await until(()=>!s.entry);}
test('web configure validates bridge aliases without requiring them in the ordinary native catalog',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-web-options-'));
  fs.mkdirSync(path.join(root,'runtime'));fs.mkdirSync(path.join(root,'codex-home'));
  fs.writeFileSync(path.join(root,'isolation.json'),JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:17861}));
  const config=path.join(root,'runtime','config.json');
  fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:17861,mode:'full',proAvailable:true}));
  const s=make('web-configure');
  s.options.env={...s.options.env,CODEX_HOME:path.join(root,'codex-home'),AI_HUB_CHATGPT_ROOT:root};
  s.options.threadParams.model='chatgpt-web/high';s.options.turnParams={model:'chatgpt-web/high',effort:'high'};
  try{
    await s.start();
    const result=await s.configure({model:'chatgpt-web/medium',effort:'medium'});
    assert.equal(result.appliesOn,'next-turn');assert.equal(s.options.turnParams.model,'chatgpt-web/medium');
    assert.equal(s.options.turnParams.effort,'medium');
    await assert.rejects(s.configure({model:'chatgpt-web/pro',effort:'high'}),/不能单独修改/);
    await assert.rejects(s.configure({model:'fixture-model',effort:'max'}),/不同连接配置/);
    fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:17861,mode:'full',proAvailable:false}));
    await assert.rejects(s.configure({model:'chatgpt-web/pro',effort:'ultra'}),/不可用/);
  }finally{await close(s);}
});
test('speed selection preserves model, effort and history, rejects unsupported Fast',async()=>{
  const s=make();try{
    await s.start();const id=s.threadId,count=s.history.size;
    await s.configure({codexSpeedTier:'standard'});
    assert.equal(s.options.turnParams.serviceTier,'default');
    await s.configure({codexSpeedTier:'fast'});
    assert.equal(s.options.turnParams.serviceTier,'fast');
    assert.equal(s.options.turnParams.model,'fixture-model');assert.equal(s.options.turnParams.effort,'max');
    assert.equal(s.threadId,id);assert.equal(s.history.size,count);
    await assert.rejects(s.configure({codexSpeedTier:'invalid'}),/无效/);
    await assert.rejects(s.configure({model:'fixture-model-2',codexSpeedTier:'fast'}),/不支持 Fast/);
    assert.equal(s.options.turnParams.model,'fixture-model');
  }finally{await close(s);}
});
test('inherited disabled Fast capability cannot report a successful speed switch',async()=>{
  const s=make('speed-disabled');
  s.options.clientFactory=()=>fixtureClient({cwd:__dirname,timeoutMs:1500,
    launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/codex-app-server.js')],env:{...process.env,CLAUDE_HUB_NATIVE_FIXTURE_FAST_DISABLED:'1'}}});
  try {
    await s.configure({codexSpeedTier:'standard'});
    await assert.rejects(s.configure({codexSpeedTier:'fast'}),/禁用了 Fast/);
    assert.equal(s.options.turnParams.serviceTier,'default');
    assert.equal(s.history.size,0);
  }finally{await close(s);}
});
test('real stdio framing: one complete multi-line prompt, unicode output and identity receipt',async()=>{
  const s=make();try{
    await s.start();
    assert.equal(s.runtime.state,'idle');
    const result=await s.send('第一行\n— 一整条\n1. 编号 😀',{clientSubmissionId:'message-1'});
    await until(()=>s.runtime.state==='completed');
    assert.equal(result.turnId,s.runtime.turnId);
    assert.equal(s.finalText(),'原生回答 ✅');
    const duplicate=await s.send('第一行\n— 一整条\n1. 编号 😀',{clientSubmissionId:'message-1'});
    assert.equal(duplicate.turnId,result.turnId);
    await assert.rejects(s.send('different',{clientSubmissionId:'message-1'}),/不匹配/);
  }finally{await close(s);}
});
test('empty completion before response cannot be resurrected; late old turns cannot end the next',async()=>{
  const s=make();try{
    let completed=0;s.on('lifecycle',e=>{if(e.type==='turn-complete')completed++;});
    await s.send('fixture:empty');
    assert.equal(s.runtime.state,'completed');assert.equal(completed,1);
    const old=s.runtime.turnId;
    await s.send('fixture:hold');
    s.notification({method:'turn/completed',params:{threadId:s.threadId,turn:{id:old,status:'completed'}}});
    assert.equal(s.runtime.state,'running');
    await s.interrupt();await until(()=>s.runtime.state==='interrupted');
  }finally{await close(s);}
});
test('native waiting request is actionable; stop waits for a native outcome',async()=>{
  const s=make();try{
    await s.send('fixture:wait');await until(()=>s.runtime.requests.length===1);
    assert.equal(s.runtime.state,'waiting');
    const req=s.runtime.requests[0];
    await s.reply(req.id,{answers:{q:{answers:['A']}}},s.runtime.epoch);
    await until(()=>s.runtime.state==='completed');
    await assert.rejects(s.reply(req.id,{},s.runtime.epoch),/失效/);
    await s.send('fixture:hold');
    await s.interrupt();await until(()=>s.runtime.state==='interrupted');
  }finally{await close(s);}
});
test('shared scope has one process, independent threads and independent closure',async()=>{
  const a=make('a'),b=make('b');try{
    await Promise.all([a.start(),b.start()]);
    assert.equal(a.pid,b.pid);assert.notEqual(a.threadId,b.threadId);
    await a.send('fixture:hold');await b.send('fixture:empty');
    assert.equal(a.runtime.state,'running');assert.equal(b.runtime.state,'completed');
    await close(b);
    assert.equal(a.runtime.connection,'connected');
    await a.interrupt();await until(()=>a.runtime.state==='interrupted');
  }finally{await close(a);await close(b);}
  assert.equal(pool.size,0);
});
test('connection failure during submission is unknown, and the same request is never replayed',async()=>{
  const s=make();try{
    await assert.rejects(s.send('fixture:crash',{clientSubmissionId:'crash'}));
    await until(()=>s.runtime.connection==='disconnected');
    assert.equal(s.runtime.state,'unknown');
    assert.equal(s.runtime.submission.status,'unknown');
    await assert.rejects(s.send('fixture:crash',{clientSubmissionId:'crash'}));
  }finally{await close(s);}
});
test('malformed protocol does not silently settle a turn or swallow pending errors',async()=>{
  const s=make();try{
    await assert.rejects(s.send('fixture:broken'));
    assert.equal(s.runtime.connection,'disconnected');assert.equal(s.runtime.state,'unknown');
  }finally{await close(s);}
});
test('reducer rejects old connection events, ignores idle as success, and keeps multiple requests',()=>{
  let s=createNativeRuntime();
  const apply=e=>{s=reduceNativeRuntime(s,e);};
  apply({type:'snapshot',thread:{id:'t',status:{type:'idle'},turns:[]}});
  apply({type:'started',threadId:'t',turn:{id:'a'}});
  apply({type:'status',threadId:'t',status:{type:'idle'}});
  assert.equal(s.state,'running');
  for(const id of [1,2])apply({type:'request',threadId:'t',request:{id,params:{turnId:'a'}}});
  apply({type:'resolved',threadId:'t',requestId:1});assert.equal(s.state,'waiting');
  apply({type:'connect',epoch:2});
  apply({type:'completed',epoch:1,threadId:'t',turn:{id:'a',status:'completed'}});
  assert.equal(s.state,'unknown');
});


// Submission recovery must bind exact native user message identity AND content.
test('lost submission response can be reconciled without opening another turn',async()=>{
  const s=make();try{
    await assert.rejects(s.send('fixture:no-ack',{clientSubmissionId:'lost-ack'}),/超时/);
    assert.equal(s.runtime.submission.status,'unknown');
    const id=s.runtime.turnId;
    await s.reconcile();assert.equal(s.runtime.submission.status,'accepted');
    const receipt=await s.send('fixture:no-ack',{clientSubmissionId:'lost-ack'});
    assert.equal(receipt.turnId,id);
    const read=await s.entry.client.request('thread/read',{threadId:s.threadId,includeTurns:true});
    assert.equal(read.thread.turns.length,1);
  }finally{await close(s);}
});
test('content mismatch cannot claim an unknown submission; attachment identity is protected',async()=>{
  const s=make();try{
    await assert.rejects(s.send('fixture:no-ack',{clientSubmissionId:'mismatch',attachments:[{type:'localImage',path:'first.png'}]}));
    const read=await s.entry.client.request('thread/read',{threadId:s.threadId,includeTurns:true});
    read.thread.turns[0].items[0].content[1].path='other.png';
    assert.equal(s.recoverSubmission(read.thread),null);
    assert.equal(s.runtime.submission.status,'unknown');
    await s.reconcile();assert.equal(s.runtime.submission.status,'accepted');
    await assert.rejects(s.send('fixture:no-ack',{clientSubmissionId:'mismatch',attachments:[{type:'localImage',path:'other.png'}]}),/不匹配/);
  }finally{await close(s);}
});
test('one resolved request does not clear another; optional questions do not stop execution',async()=>{
  const s=make();try{
    await s.send('fixture:multi');await until(()=>s.runtime.requests.length===2);
    const [a,b]=s.runtime.requests;
    await s.reply(a.id,{answers:{q:{answers:['A']}}},s.runtime.epoch);
    await until(()=>s.runtime.requests.length===1);assert.equal(s.runtime.state,'waiting');
    await s.reply(b.id,{answers:{q2:{answers:['B']}}},s.runtime.epoch);
    await until(()=>s.runtime.state==='completed');
    await s.send('fixture:optional');await until(()=>s.runtime.requests.length===1);
    assert.equal(s.runtime.state,'running');
    const optional=s.runtime.requests[0];
    await s.reply(optional.id,{answers:{q:{answers:['A']}}},s.runtime.epoch);
    await until(()=>s.runtime.state==='completed');
  }finally{await close(s);}
});
test('file changes, permission requests and MCP elicitation keep exact details and responses',async()=>{
  const s=make();try{
    for(const mode of ['approval','file-approval','permissions','mcp']){
      await s.send('fixture:'+mode);await until(()=>s.runtime.requests.length===1);
      const req=s.runtime.requests[0];
      if(mode==='file-approval')assert.equal(req.params.operation.changes[0].diff,'-old\n+new');
      await assert.rejects(s.reply(req.id,{decision:'accept'},s.runtime.epoch-1),/旧连接/);
      await s.reply(req.id,mode==='mcp'?{action:'accept',content:{color:'blue'}}:{decision:'decline'},s.runtime.epoch);
      await until(()=>s.runtime.state==='completed');
    }
  }finally{await close(s);}
});
test('tool error is not a failed turn; a native failed turn settles even without text',async()=>{
  const s=make();try{
    await s.send('fixture:tool-error');assert.equal(s.runtime.state,'running');
    await s.idle();assert.equal(s.runtime.state,'completed');
    await s.send('fixture:failed');await s.idle();assert.equal(s.runtime.state,'failed');
    const outcome=await s.readOutcome(s.runtime.turnId);
    assert.equal(outcome.text,'');assert.equal(outcome.status,'failed');
  }finally{await close(s);}
});
test('active steer keeps the same turn and both exact user messages; model changes require idle',async()=>{
  const s=make();try{
    const first=await s.send('fixture:hold');
    await assert.rejects(s.configure({model:'fixture-model-2',effort:'xhigh'}),/轮次结束/);
    const second=await s.send('追加\n整条消息',{requireReady:false,clientSubmissionId:'steer'});
    assert.equal(second.turnId,first.turnId);
    const read=await s.entry.client.request('thread/read',{threadId:s.threadId,includeTurns:true});
    assert.equal(read.thread.turns.length,1);assert.equal(read.thread.turns[0].items.filter(i=>i.type==='userMessage').length,2);
    await s.interrupt();await s.idle();
    const configured=await s.configure({model:'fixture-model-2',effort:'xhigh'});
    assert.equal(configured.effort,'xhigh');assert.equal(configured.appliesOn,'next-turn');assert.equal(s.options.turnParams.model,'fixture-model-2');
    const before=(await s.entry.client.request('thread/resume',{threadId:s.threadId}));assert.equal(before.model,'fixture-model');
    await s.send('apply selected parameters');await s.idle();
    const after=(await s.entry.client.request('thread/resume',{threadId:s.threadId}));assert.equal(after.model,'fixture-model-2');assert.equal(after.reasoningEffort,'xhigh');
    await assert.rejects(s.configure({model:'fixture-model-2',effort:'invalid'}),/不支持/);
    await assert.rejects(s.send('/unsupported'),/未发送给模型/);
  }finally{await close(s);}
});
test('orphan server request is rejected explicitly and leaves no pending request',async()=>{
  const s=make();const diagnostics=[];s.on('diagnostic',e=>diagnostics.push(e));try{
    await s.send('fixture:orphan');await until(()=>diagnostics.some(x=>x.includes('无法匹配')));
    await until(()=>s.entry.client.serverRequests.size===0);
  }finally{await close(s);}
});
test('30 open-close cycles leave no process owner, pending request or subscription',async()=>{
  for(let i=0;i<30;i++){
    const s=make('cycle-'+i);await s.start();const client=s.entry.client;
    await close(s);await until(()=>client.proc.exitCode!==null);
    assert.equal(client.pending.size,0);assert.equal(client.serverRequests.size,0);
    for(const name of ['notification','server-request','disconnect','late-response'])assert.equal(client.listenerCount(name),0);
    assert.equal(pool.size,0);
  }
});
test('historical inProgress on an idle engine stays unknown after restart',()=>{
  const s=reduceNativeRuntime(createNativeRuntime(),{type:'snapshot',thread:{id:'t',status:{type:'idle'},turns:[{id:'old',status:'inProgress'}]}});
  assert.equal(s.state,'unknown');assert.equal(s.turnId,'old');
});
test('one native thread cannot be resumed by a different configuration scope',async()=>{
  const a=make('owner-a'),b=make('owner-b');try{
    await a.start();b.options.env={...b.options.env,profile:'different'};b.options.resumeId=a.threadId;
    await assert.rejects(b.start(),/另一个配置域/);
    assert.equal(a.runtime.connection,'connected');
    await a.send('still usable');await a.idle();assert.equal(a.runtime.state,'completed');
  }finally{await close(b);await close(a);}
});
test('bounded idle wait removes its listener and never manufactures a turn outcome',async()=>{
  const s=make();try{await s.send('fixture:hold');const before=s.listenerCount('state');
    await assert.rejects(s.idle(10),/尚未确认停止/);assert.equal(s.listenerCount('state'),before);assert.equal(s.runtime.state,'running');
  }finally{await close(s);}
});
test('slash model control is serialized without a self-deadlock',async()=>{
  const s=make();try{await s.start();await s.send('/model fixture-model-2');assert.equal(s.options.turnParams.model,'fixture-model-2');
    await s.send('after model switch');await s.idle();assert.equal(s.runtime.state,'completed');
  }finally{await close(s);}
});

test('native policy mismatch blocks its thread without changing another pooled session',async()=>{
  const a=make('config-a'),b=make('config-b');try{
    a.options.threadParams.approvalPolicy='on-request';a.options.threadParams.sandbox='read-only';
    await b.start();const client=b.entry.client,request=client.request.bind(client);
    client.request=async(method,params,...rest)=>{const result=await request(method,params,...rest);return method==='thread/start'?{...result,approvalPolicy:'never'}:result;};
    await a.start();assert(a.runtime.configurationError);assert.equal(client.closed,false);
    await assert.rejects(a.configure({model:'fixture-model-2',effort:'xhigh'}),/权限范围/);
    await assert.rejects(a.send('must not submit'),/发送已暂停/);
    await b.send('other thread remains usable');await b.idle();assert.equal(b.runtime.state,'completed');
  }finally{await close(a);await close(b);}
});

test('selection before the first turn needs no persisted rollout or resume mutation',async()=>{
  const s=make();try{
    await s.start();const client=s.entry.client,request=client.request.bind(client),calls=[];
    client.request=async(method,params,...rest)=>{calls.push({method,params});if(method==='thread/resume')throw Error('no rollout found');return request(method,params,...rest);};
    await s.configure({model:'fixture-model-2',effort:'xhigh'});
    assert.deepEqual(calls.map(x=>x.method),['model/list']);assert.equal(s.runtime.state,'idle');
    await s.send('first configured turn');await s.idle();
    const start=calls.find(x=>x.method==='turn/start');assert.equal(start.params.model,'fixture-model-2');assert.equal(start.params.effort,'xhigh');
  }finally{await close(s);}
});

test('cancel acknowledgement, failure and completion race never invent interruption',async()=>{
  const s=make();try{
    await s.send('fixture:stop-delayed');await s.interrupt();assert.equal(s.runtime.state,'running');await s.idle();assert.equal(s.runtime.state,'interrupted');
    await s.send('fixture:stop-race');await s.interrupt();assert.equal(s.runtime.state,'completed');
    await s.send('fixture:stop-failed');await assert.rejects(s.interrupt(),/controlled interrupt failure/);assert.equal(s.runtime.state,'running');
    s.entry.client.close();await until(()=>s.entry.client.proc.exitCode!==null);
  }finally{await close(s);}
});
test('tool-only completed turn is terminal, and obsolete requests cannot restore waiting',async()=>{
  const s=make();try{await s.send('fixture:tool-only');await s.idle();assert.equal(s.runtime.state,'completed');assert.equal(s.finalText(),'');
    const old=s.runtime.turnId;await s.send('fixture:hold');
    s.notification({method:'turn/started',params:{threadId:s.threadId,turn:{id:old,status:'inProgress'}}});
    s.onRequest({id:999999,method:'item/tool/requestUserInput',params:{threadId:s.threadId,turnId:old}});
    assert.equal(s.runtime.state,'running');assert.equal(s.runtime.requests.length,0);assert.notEqual(s.runtime.turnId,old);
  }finally{await close(s);}
});
test('distinct account/MCP environment scopes never share a process or route output across threads',async()=>{
  const a=make('scope-a'),b=make('scope-b');b.options.env={...b.options.env,account:'isolated-b',MCP_SCOPE:'separate'};
  try{await Promise.all([a.start(),b.start()]);assert.notEqual(a.pid,b.pid);
    await a.send('fixture:hold');await b.send('fixture:empty');assert.equal(a.runtime.state,'running');assert.equal(b.runtime.state,'completed');
    await close(b);assert.equal(a.runtime.connection,'connected');await a.interrupt();await a.idle();
  }finally{await close(a);await close(b);}
});

test('history picker follows every native cursor and rejects an incomplete repeated page',async()=>{
  const s=make();try{await s.start();const request=s.entry.client.request.bind(s.entry.client),calls=[];
    s.entry.client.request=async(method,p,...rest)=>{if(method!=='thread/list')return request(method,p,...rest);calls.push(p);return p.cursor?{data:[{id:'older'}],nextCursor:null}:{data:[{id:'recent'}],nextCursor:'page2'};};
    assert.deepEqual((await s.listThreads()).map(x=>x.id),['recent','older']);assert.equal(calls[1].cursor,'page2');
    s.entry.client.request=async(method,p,...rest)=>method==='thread/list'?{data:[],nextCursor:'same'}:request(method,p,...rest);
    await assert.rejects(s.listThreads(),/分页游标重复/);
  }finally{await close(s);}
});

test('native command output returns to card UI and logout is rejected without a model turn',async()=>{
  const s=make();try {
    await s.start();
    const help=await s.send('/help');
    assert.equal(help.mode,'native-command');assert.match(help.commandOutput,/codex logout/);
    const status=await s.send('/status');assert.equal(JSON.parse(status.commandOutput).state,'idle');
    await assert.rejects(s.send('/logout'),/未执行.*PowerShell.*CODEX_HOME/);
    await assert.rejects(s.send('/unknown-command'),/未发送给模型.*\/help/);
    assert.equal(s.runtime.turnId,null);assert.equal(s.runtime.state,'idle');
    await s.send('ordinary prompt after commands');await s.idle();assert.equal(s.runtime.state,'completed');
  }finally{await close(s);}
});
