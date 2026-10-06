'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-backends-')),sessions=new Map(),created=[];
  const deps={dataDir:dir,getSession:id=>sessions.get(id),getSessionMetadata:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],getDefaults:kind=>({model:kind+'-chosen-model',cwd:dir}),
    createSession:async(kind,opts)=>{created.push(kind);const session={...opts,kind,status:'idle'};sessions.set(opts.id,session);return session;},sendPrompt:async()=>({ok:true,receipt:{status:'confirmed'}})};
  const service=new AssistantService(deps);
  // 这些用例验证切换身份；按「已完成快速档迁移、当前选 Codex」的老用户状态起步。默认档位见 unit-assistant-profiles。
  service.store.set('assistantDefaultsVersion',2);service.store.set('backendKind','codex');t.after(()=>{if(service.store.db.isOpen)service.close();});return{service,deps,sessions,created};
}
test('switch round trip retains two native identities and provider defaults',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),claude=await x.service.switchBackend({kind:'claude'});
  assert.notEqual(claude.sessionId,codex.sessionId);assert.equal(claude.session.model,'claude-sonnet-5-5');assert.equal(claude.session.effort,'low');assert.equal(claude.session.autonomous,true);
  const config=JSON.parse(fs.readFileSync(claude.session.mcpConfigFile,'utf8'));
  assert.equal(config.mcpServers.hub_assistant.env.HUB_ASSISTANT_SESSION_ID,claude.sessionId);
  assert.equal((await x.service.switchBackend({kind:'codex'})).sessionId,codex.sessionId);
  assert.deepEqual(x.created,['codex','claude']);assert.deepEqual(x.service.sessions(),[]);
  await assert.rejects(x.service.execute({requestId:'recursive-task',type:'send',targetSessionId:claude.sessionId,text:'再派工'}),/自身循环/);
});
test('inactive backend cannot read or manage; current Claude has manager tools',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),claude=await x.service.switchBackend({kind:'claude'});
  const frame=x.service.preparePrompt({sessionId:claude.sessionId,text:'查看进展',clientSubmissionId:'claude-request'});
  assert.match(frame.text,/使用原生列出的 hub_assistant 工具/);assert.doesNotMatch(frame.text,/functions.exec/);
  await assert.rejects(x.service.invokeTool({name:'list_sessions',callerSessionId:codex.sessionId}),/未授予/);
  const packet=await x.service.invokeTool({name:'history_context',callerSessionId:claude.sessionId,arguments:{requestToken:x.service.currentRequest.token}});
  assert.ok(packet.snapshotReceipt);assert.throws(()=>x.service.preparePrompt({sessionId:codex.sessionId,text:'继续'}),/不是固定助理/);
});
test('busy assistant blocks switching without changing identity or request',async t=>{
  const x=setup(t),codex=await x.service.ensureSession();x.sessions.get(codex.sessionId).status='running';
  await assert.rejects(x.service.switchBackend({kind:'claude'}),/先结束/);assert.equal(x.service.store.get('sessionId'),codex.sessionId);assert.deepEqual(x.created,['codex']);
});

test('an existing assistant entity is not described as a connected provider',async t=>{
  const x=setup(t),manager=await x.service.ensureSession();
  assert.doesNotMatch(x.service.overview().connectionSummary,/已连接/);
  x.sessions.get(manager.sessionId).cliRuntime={connection:'disconnected',reason:'套餐无访问权限'};
  const overview=x.service.overview();assert.equal(overview.available,true);
  assert.match(overview.connectionSummary,/未连接.*套餐无访问权限/);assert.deepEqual(overview.needsAttention,['套餐无访问权限']);
});

test('current manager without retrieval arguments reads its frozen packet, explicit lookup remains dynamic',async t=>{
  const x=setup(t),manager=await x.service.ensureSession();
  x.service.preparePrompt({sessionId:manager.sessionId,text:'查进展'});
  const firstToken=x.service.currentRequest.token;
  const frozen=await x.service.invokeTool({name:'history_context',callerSessionId:manager.sessionId});
  assert.equal(frozen.snapshotReceipt.requestToken,firstToken);
  assert.equal(x.service.overview().contextCoverage.snapshotRead,true);
  x.service.preparePrompt({sessionId:manager.sessionId,text:'下一轮进展'});
  const dynamic=await x.service.invokeTool({name:'history_context',callerSessionId:manager.sessionId,arguments:{hours:3}});
  assert.equal(dynamic.snapshotReceipt,undefined);
  assert.equal(x.service.overview().contextCoverage.snapshotRead,false);
  await assert.rejects(x.service.invokeTool({name:'history_context',callerSessionId:manager.sessionId,arguments:{requestToken:firstToken}}),/不属于当前/);
});
test('pending submit receipt blocks switching even after a native final arrived',async t=>{
  const x=setup(t),codex=await x.service.ensureSession();x.deps.hasPendingPrompt=()=>true;
  await assert.rejects(x.service.switchBackend({kind:'claude'}),/提交仍在核对/);assert.equal(x.service.store.get('sessionId'),codex.sessionId);assert.equal(x.created.length,1);
});
test('new task reminder is registered before the target can answer',async t=>{
  const x=setup(t),assistant=await x.service.ensureSession();let watchedAtSend=false;
  x.deps.sendPrompt=async id=>{watchedAtSend=x.service.followedTasks().some(w=>w.sessionId===id);return{ok:true,receipt:{status:'confirmed'}};};
  x.service.preparePrompt({sessionId:assistant.sessionId,text:'新建任务，有新回复时提醒我'});
  const r=await x.service.invokeTool({name:'create_session',callerSessionId:assistant.sessionId,arguments:{title:'快速回复',text:'回复完成',operationKey:'quick-one',requestToken:x.service.currentRequest.token}});
  assert.equal(r.ok,true);assert.equal(r.followed,true);assert.equal(watchedAtSend,true);
});
test('lost switch receipt retains old backend and reconciles reserved new id',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),original=x.deps.createSession;
  x.deps.createSession=async(...args)=>{await original(...args);throw Error('lost launch response');};
  await assert.rejects(x.service.switchBackend({kind:'claude'}),/lost launch/);assert.equal(x.service.store.get('sessionId'),codex.sessionId);
  const pending=x.service.overview().backendSessions.claude;
  const recovered=await x.service.switchBackend({kind:'claude'});assert.equal(recovered.sessionId,pending);assert.deepEqual(x.created,['codex','claude']);
});
test('switch serialization blocks late old tools and input during creation',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),original=x.deps.createSession;let release;
  x.deps.createSession=async(...args)=>{await new Promise(r=>release=r);return original(...args);};
  const pending=x.service.switchBackend({kind:'claude'});await new Promise(r=>setImmediate(r));
  await assert.rejects(x.service.switchBackend({kind:'codex'}),/请稍候/);
  assert.throws(()=>x.service.preparePrompt({sessionId:codex.sessionId,text:'派工'}),/正在切换/);
  await assert.rejects(x.service.invokeTool({name:'list_sessions',callerSessionId:codex.sessionId}),/正在切换/);release();await pending;
});
test('confirmed user input and native final persist across backend change and service restart',async t=>{
  const x=setup(t),codex=await x.service.ensureSession();
  x.service.preparePrompt({sessionId:codex.sessionId,text:'交接暗号企鹅蓝桥',clientSubmissionId:'user-request-one'});
  x.service.observePromptReceipt({sessionId:codex.sessionId,clientSubmissionId:'user-request-one',status:'confirmed'});
  await x.service.switchBackend({kind:'claude'});
  assert.match(x.service.context().assistantContinuity.records[0].text,/企鹅蓝桥/);
  assert.match(fs.readFileSync(x.service.continuity.markdownPath,'utf8'),/企鹅蓝桥/);
  x.service.close();const reopened=new AssistantService(x.deps);t.after(()=>reopened.close());
  assert.equal((await reopened.ensureSession()).backendKind,'claude');assert.match(reopened.context().assistantContinuity.records[0].text,/企鹅蓝桥/);
});
test('legacy singleton migrates without replacement and registered inactive resume keeps its own tool identity',async t=>{
  const x=setup(t);x.service.store.set('sessionId','legacy-codex');x.sessions.set('legacy-codex',{id:'legacy-codex',kind:'codex',purpose:'hub-assistant',status:'idle'});
  assert.equal((await x.service.ensureSession()).sessionId,'legacy-codex');await x.service.switchBackend({kind:'claude'});
  assert.doesNotThrow(()=>x.service.requireAssistantResume({hubId:'legacy-codex',kind:'codex'}));
  assert.throws(()=>x.service.requireAssistantResume({hubId:'other',kind:'claude'}),/未授予/);
  assert.equal(x.service.getLaunchOptions('codex','legacy-codex').codexMcpEntries[0].env.HUB_ASSISTANT_SESSION_ID,'legacy-codex');
});
test('closed provider restores its registered entity with provider-specific tools',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),claude=await x.service.switchBackend({kind:'claude'});
  await x.service.switchBackend({kind:'codex'});const saved=x.sessions.get(claude.sessionId);x.sessions.delete(claude.sessionId);
  x.deps.resumeSession=async(id,options)=>{assert.equal(id,claude.sessionId);assert(options.mcpConfigFile);x.sessions.set(id,saved);return saved;};
  assert.equal((await x.service.switchBackend({kind:'claude'})).sessionId,claude.sessionId);assert.equal(x.created.length,2);
});
test('unknown failed provider switch never replaces the working backend or creates on retry',async t=>{
  const x=setup(t),codex=await x.service.ensureSession();let attempts=0;
  x.deps.createSession=async()=>{attempts++;throw Error('launch outcome unknown');};
  await assert.rejects(x.service.switchBackend({kind:'claude'}),/unknown/);
  const result=await x.service.switchBackend({kind:'claude'});assert.equal(result.ok,false);assert.equal(result.needsReconciliation,true);
  assert.equal(x.service.store.get('sessionId'),codex.sessionId);assert.equal(attempts,1);
});
