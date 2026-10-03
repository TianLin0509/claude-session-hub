'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const profiles=require('../core/hub-assistant/profiles');
const {AssistantService}=require('../core/hub-assistant/service');
const HUB_DEFAULTS={codex:{model:'gpt-6.1-sol',effort:'high',mcpProfile:'none',codexSpeedTier:'standard'},claude:{model:'claude-opus-5-5[1m]',effort:'high',mcpProfile:'none'}};
function setup(t,{legacy}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-profiles-')),sessions=new Map(),created=[],restarts=[],sent=[];
  const deps={dataDir:dir,getSession:id=>sessions.get(id),getSessionMetadata:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],getDefaults:kind=>({...(HUB_DEFAULTS[kind]||{model:kind+'-model',effort:'max'}),cwd:dir}),
    createSession:async(kind,opts)=>{created.push({kind,opts});const session={...opts,kind,status:'idle'};sessions.set(opts.id,session);return session;},
    sendPrompt:async(id,text,requestId)=>{sent.push({id,text,requestId});return{ok:true,receipt:{status:'confirmed'}};},
    restartSession:async(id,overrides)=>{restarts.push({id,overrides});const s=sessions.get(id);Object.assign(s,overrides);return s;}};
  const service=new AssistantService(deps);
  if(legacy){service.store.set('backendKind','codex');}
  t.after(()=>{if(service.store.db.isOpen)service.close();});
  return{service,deps,sessions,created,restarts,sent};
}
test('task tiers: fast/standard follow the agreed table, deep is the Hub default, named values win',()=>{
  const r=req=>profiles.resolveTask(req,HUB_DEFAULTS[profiles.taskKind(req)]);
  assert.deepEqual([r({tier:'fast'}).kind,r({tier:'fast'}).model,r({tier:'fast'}).effort],['claude','claude-sonnet-5-5','low']);
  assert.deepEqual([r({tier:'fast',kind:'codex'}).model,r({tier:'fast',kind:'codex'}).effort],['gpt-6-luna','low']);
  assert.deepEqual([r({tier:'standard'}).kind,r({tier:'standard'}).model,r({tier:'standard'}).effort],['codex','gpt-6.1-sol','medium']);
  assert.deepEqual([r({tier:'standard',kind:'claude'}).model,r({tier:'standard',kind:'claude'}).effort],['claude-opus-5-5','medium']);
  assert.deepEqual([r({}).kind,r({}).model,r({}).effort],['codex','gpt-6.1-sol','high']);
  assert.deepEqual([r({kind:'claude',effort:'high'}).model,r({kind:'claude',effort:'high'}).effort],['claude-opus-5-5[1m]','high']);
  assert.match(r({tier:'standard'}).label,/GPT-6.1 Sol · 中思考/);
  assert.throws(()=>r({kind:'claude',model:'gpt-6-luna'}),/没有模型/);
  assert.throws(()=>r({kind:'claude',model:'claude-sonnet-5-5',effort:'ultra'}),/不支持思考深度/);
  assert.throws(()=>profiles.taskKind({tier:'turbo'}),/档位/);
});
test('existing assistant users migrate once to the fast default and later choices are kept',async t=>{
  const x=setup(t,{legacy:true});
  const first=await x.service.ensureSession();
  assert.equal(first.backendKind,'claude');assert.equal(first.session.model,'claude-sonnet-5-5');assert.equal(first.session.effort,'low');
  const codex=await x.service.setProfile({kind:'codex'});
  assert.equal(codex.ok,true);assert.equal(codex.profile.kind,'codex');assert.equal(codex.profile.model,'gpt-6-luna');assert.equal(codex.profile.effort,'low');
  assert.equal((await x.service.ensureSession()).backendKind,'codex');
  assert.deepEqual(x.created.map(c=>[c.kind,c.opts.model,c.opts.effort]),[['claude','claude-sonnet-5-5','low'],['codex','gpt-6-luna','low']]);
});
test('changing model restarts an idle assistant on the same session; a busy one waits',async t=>{
  const x=setup(t),a=await x.service.ensureSession();
  const r=await x.service.setProfile({kind:'claude',model:'claude-opus-5-5',effort:'medium'});
  assert.equal(r.ok,true);assert.deepEqual(x.restarts,[{id:a.sessionId,overrides:{model:'claude-opus-5-5',effort:'medium'}}]);
  assert.equal(r.profile.model,'claude-opus-5-5');assert.equal(r.profile.pending,false);
  x.sessions.get(a.sessionId).status='running';
  const busy=await x.service.setProfile({kind:'claude',model:'claude-sonnet-5-5',effort:'low'});
  assert.equal(busy.ok,true);assert.equal(busy.profile.pending,true);assert.equal(x.restarts.length,1);
  x.sessions.get(a.sessionId).status='idle';await x.service.ensureSession();
  assert.equal(x.restarts.length,2);assert.equal(x.service.currentProfile().pending,false);
  await assert.rejects(x.service.setProfile({kind:'claude',model:'not-a-model'}),/没有模型/);
});
test('assistant-created task uses the requested tier and reports who got it',async t=>{
  const x=setup(t),a=await x.service.ensureSession();
  x.service.preparePrompt({sessionId:a.sessionId,text:'帮我写一份调度算法对比报告',clientSubmissionId:'route-request'});
  const token=x.service.currentRequest.token;
  await assert.rejects(x.service.invokeTool({name:'create_session',callerSessionId:a.sessionId,arguments:{title:'错型号',text:'写',operationKey:'op-bad',requestToken:token,kind:'claude',model:'gpt-6-luna'}}),/没有模型/);
  assert.equal(x.service.store.has('op-bad'),false);
  const result=await x.service.invokeTool({name:'create_session',callerSessionId:a.sessionId,arguments:{title:'调度对比',text:'写报告',operationKey:'op-standard',requestToken:token,tier:'standard'}});
  assert.equal(result.ok,true);assert.equal(result.route.kind,'codex');assert.equal(result.route.model,'gpt-6.1-sol');assert.equal(result.route.effort,'medium');
  const made=x.created.at(-1);assert.equal(made.kind,'codex');assert.equal(made.opts.model,'gpt-6.1-sol');assert.equal(made.opts.effort,'medium');assert.equal(made.opts.codexSpeedTier,'standard');assert.equal(made.opts.noInheritCursor,true,'background task must not wait for a renderer cursor reply');
});
test('voice requests tell the assistant the text is a transcript; typed requests do not',async t=>{
  const x=setup(t),a=await x.service.ensureSession();
  let frame='';x.deps.sendPrompt=async(id,text,requestId)=>{frame=x.service.preparePrompt({sessionId:id,text,clientSubmissionId:requestId}).text;return{ok:true,receipt:{status:'confirmed'}};};
  await x.service.send({text:'仿真跑完没有',requestId:'voice-request-1',inputMode:'voice'});
  assert.match(frame,/"userInputMode":"voice"/);assert.match(frame,/语音转写/);
  await x.service.send({text:'仿真跑完没有',requestId:'typed-request-1'});
  assert.doesNotMatch(frame,/userInputMode/);assert.doesNotMatch(frame,/语音转写/);
  assert.match(frame,/create_session/);assert.match(frame,/tier=standard/);
});
test('phone catalog lists every backend with models from the Hub, not from the phone',()=>{
  const kinds=profiles.phoneCatalog(require('../core/ai-kinds').ALL_AI_KINDS,k=>HUB_DEFAULTS[k]||{});
  const claude=kinds.find(k=>k.kind==='claude'),codex=kinds.find(k=>k.kind==='codex');
  assert.equal(claude.defaultModel,'claude-sonnet-5-5');assert.equal(claude.defaultEffort,'low');assert.ok(claude.models.some(m=>m.id==='claude-opus-5-5'));
  assert.ok(claude.models.every(m=>m.id.startsWith('claude-')));
  assert.equal(codex.defaultModel,'gpt-6-luna');assert.ok(codex.models.some(m=>m.id==='gpt-6.1-sol'));
  assert.equal(kinds.length,require('../core/ai-kinds').ALL_AI_KINDS.length);
});
test('a failed switch is rolled back and a failed restart is reported without blocking later requests',async t=>{
  const x=setup(t),a=await x.service.ensureSession();
  x.sessions.get(a.sessionId).status='running';
  await assert.rejects(x.service.setProfile({kind:'codex'}),/先结束/);
  assert.equal(x.service.store.get('profile:codex'),null);assert.equal(x.service.store.get('profilePending:codex'),false);
  x.sessions.get(a.sessionId).status='idle';
  x.deps.restartSession=async()=>({ok:false,message:'当前会话尚未绑定原生会话 ID'});
  const r=await x.service.setProfile({kind:'claude',model:'claude-opus-5-5',effort:'medium'});
  assert.equal(r.ok,false);assert.match(r.error,/重启失败.*原生会话/);assert.equal(r.profile.model,'claude-sonnet-5-5');
  assert.equal((await x.service.ensureSession()).ok,true);assert.equal(x.service.currentProfile().pending,false);
});
test('default migration of a live Codex assistant waits while it is busy, then switches through the normal path',async t=>{
  const x=setup(t);x.service.store.set('assistantDefaultsVersion',2);x.service.store.set('backendKind','codex');
  const codex=await x.service.ensureSession();assert.equal(codex.backendKind,'codex');
  x.service.store.set('assistantDefaultsVersion',null);x.sessions.get(codex.sessionId).status='running';
  assert.equal((await x.service.ensureSession()).backendKind,'codex','busy: keep the Codex assistant');
  assert.notEqual(x.service.store.get('assistantDefaultsVersion'),2);
  x.sessions.get(codex.sessionId).status='idle';
  const moved=await x.service.ensureSession();assert.equal(moved.backendKind,'claude');assert.equal(moved.session.model,'claude-sonnet-5-5');
  assert.equal(x.service.store.get('assistantDefaultsVersion'),2);assert.equal(x.service.store.get('backendSessions').codex,codex.sessionId);
});
test('an explicit phone choice made before migration is never overridden by the default',async t=>{
  const x=setup(t,{legacy:true});const r=await x.service.setProfile({kind:'codex',model:'gpt-6-luna',effort:'low'});
  assert.equal(r.ok,true);assert.equal((await x.service.ensureSession()).backendKind,'codex');
});
test('a long-lived assistant rotates to a fresh session at the next idle moment once its context is large',async t=>{
  const x=setup(t),retired=[],rotated=[];x.deps.retireSession=async id=>retired.push(id);x.deps.onAssistantRotated=e=>rotated.push(e);
  const a=await x.service.ensureSession();
  assert.equal(x.service.observeUsage(a.sessionId,{input_tokens:2000,cache_read_input_tokens:90000,cache_creation_input_tokens:1000}),93000);
  assert.equal(x.service.store.get('rotateDue:claude'),null);
  x.service.observeUsage(a.sessionId,{input_tokens:3000,cache_read_input_tokens:150000});
  x.sessions.get(a.sessionId).status='running';
  assert.equal((await x.service.ensureSession()).sessionId,a.sessionId,'busy: never rotate mid-turn');
  x.sessions.get(a.sessionId).status='idle';
  const b=await x.service.ensureSession();
  assert.notEqual(b.sessionId,a.sessionId);assert.equal(b.session.model,'claude-sonnet-5-5');assert.equal(b.session.effort,'low');
  assert.deepEqual(retired,[a.sessionId]);assert.equal(rotated[0].sessionId,b.sessionId);
  assert.equal(x.service.isAssistantSession(a.sessionId),false);assert.equal(x.service.isAssistantSession(b.sessionId),true);
  assert.doesNotThrow(()=>x.service.requireAssistantResume({hubId:a.sessionId,kind:'claude'}),'retired history can be opened');
  assert.equal((await x.service.ensureSession()).sessionId,b.sessionId,'rotates once');
  assert.equal(x.service.observeUsage('not-an-assistant',{input_tokens:999999}),null);
});
test('codex usage counts cached tokens once; a failed rotation keeps the old assistant bound',async t=>{
  const x=setup(t);x.service.store.set('assistantDefaultsVersion',2);x.service.store.set('backendKind','codex');
  const a=await x.service.ensureSession();
  assert.equal(x.service.observeUsage(a.sessionId,{input_tokens:160000,cache_read_input_tokens:150000}),160000);
  x.deps.createSession=async()=>{throw new Error('CLI 未登录');};
  await assert.rejects(x.service.ensureSession(),/未登录/);
  assert.equal(x.service.store.get('sessionId'),a.sessionId);assert.equal(x.service.isAssistantSession(a.sessionId),true);
});
test('assistant instructions put fast self-answers first and keep bulky reading out of its context',()=>{
  const frame=require('../core/hub-assistant/context').buildBootstrapPrompt('今天天气怎么样',{},0,'claude');
  assert.match(frame,/尽快答复/);assert.match(frame,/直接完成/);assert.match(frame,/大量文件和长文/);assert.match(frame,/fast 只在田哥要求单独开会话/);assert.match(frame,/闲聊、常识/);
});
