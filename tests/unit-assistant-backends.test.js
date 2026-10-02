'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-backends-')),sessions=new Map(),created=[];
  const deps={dataDir:dir,getSession:id=>sessions.get(id),getSessionMetadata:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],getDefaults:kind=>({model:kind+'-chosen-model',cwd:dir}),
    createSession:async(kind,opts)=>{created.push(kind);const session={...opts,kind,status:'idle'};sessions.set(opts.id,session);return session;},sendPrompt:async()=>({ok:true,receipt:{status:'confirmed'}})};
  const service=new AssistantService(deps);t.after(()=>{if(service.store.db.isOpen)service.close();});return{service,deps,sessions,created};
}
test('switch round trip retains two native identities and provider defaults',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),claude=await x.service.switchBackend({kind:'claude'});
  assert.notEqual(claude.sessionId,codex.sessionId);assert.equal(claude.session.model,'claude-chosen-model');assert.equal(claude.session.autonomous,true);
  const config=JSON.parse(fs.readFileSync(claude.session.mcpConfigFile,'utf8'));
  assert.equal(config.mcpServers.hub_assistant.env.HUB_ASSISTANT_SESSION_ID,claude.sessionId);
  assert.equal((await x.service.switchBackend({kind:'codex'})).sessionId,codex.sessionId);
  assert.deepEqual(x.created,['codex','claude']);assert.deepEqual(x.service.sessions(),[]);
  await assert.rejects(x.service.execute({requestId:'recursive-task',type:'send',targetSessionId:claude.sessionId,text:'再派工'}),/自身循环/);
});
test('inactive backend cannot read or manage; current Claude has manager tools',async t=>{
  const x=setup(t),codex=await x.service.ensureSession(),claude=await x.service.switchBackend({kind:'claude'});
  const frame=x.service.preparePrompt({sessionId:claude.sessionId,text:'查看进展',clientSubmissionId:'claude-request'});
  assert.match(frame.text,/mcp__hub_assistant__history_context/);assert.doesNotMatch(frame.text,/functions.exec/);
  await assert.rejects(x.service.invokeTool({name:'list_sessions',callerSessionId:codex.sessionId}),/未授予/);
  const packet=await x.service.invokeTool({name:'history_context',callerSessionId:claude.sessionId,arguments:{requestToken:x.service.currentRequest.token}});
  assert.ok(packet.snapshotReceipt);assert.throws(()=>x.service.preparePrompt({sessionId:codex.sessionId,text:'继续'}),/不是固定助理/);
});
test('busy assistant blocks switching without changing identity or request',async t=>{
  const x=setup(t),codex=await x.service.ensureSession();x.sessions.get(codex.sessionId).status='running';
  await assert.rejects(x.service.switchBackend({kind:'claude'}),/先结束/);assert.equal(x.service.store.get('sessionId'),codex.sessionId);assert.deepEqual(x.created,['codex']);
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
