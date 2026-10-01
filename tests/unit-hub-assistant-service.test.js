'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');const {AssistantStore}=require('../core/hub-assistant/store');
function setup(t,send){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-assistant-'));const sessions=new Map();let created=0,sent=0;const service=new AssistantService({dataDir:dir,getSession:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],getDefaults:()=>({model:'test-model',cwd:dir}),createSession:async(kind,opts)=>{created++;const s={...opts,kind,status:'idle'};sessions.set(s.id,s);return s;},sendPrompt:async(...args)=>{sent++;return send?send(...args):{ok:true,receipt:{status:'confirmed'}};}});t.after(()=>service.close());return{service,sessions,count:()=>({created,sent})};}
test('opening overview does not create a session or consume a turn',t=>{const x=setup(t);assert.equal(x.service.overview().available,false);assert.deepEqual(x.count(),{created:0,sent:0});});
test('concurrent activation creates exactly one ordinary Codex entity',async t=>{const x=setup(t);const [a,b]=await Promise.all([x.service.ensureSession(),x.service.ensureSession()]);assert.equal(a.sessionId,b.sessionId);assert.equal(a.session.kind,'codex');assert.equal(a.session.purpose,'hub-assistant');assert.equal(a.session.codexMcpEntries[0].name,'hub_assistant');assert.deepEqual(x.count(),{created:1,sent:0});});
test('same operation does not dispatch twice; changed payload is rejected',async t=>{const x=setup(t);x.sessions.set('target',{id:'target',status:'idle'});const action={requestId:'request-123',type:'send',targetSessionId:'target',text:'继续研究'};assert.equal((await x.service.execute(action)).ok,true);assert.equal((await x.service.execute(action)).duplicate,true);assert.equal(x.count().sent,1);await assert.rejects(x.service.execute({...action,text:'改变任务'}),/不同任务/);});
test('unknown outcome is durable and is never automatically resent',async t=>{const x=setup(t,()=>{throw new Error('connection lost');});x.sessions.set('target',{id:'target',status:'idle'});const action={requestId:'request-124',type:'send',targetSessionId:'target',text:'继续研究'};assert.equal((await x.service.execute(action)).state,'unknown');assert.equal((await x.service.execute(action)).needsReconciliation,true);assert.equal(x.count().sent,1);});
test('a busy target cannot be mistaken for an approval prompt',async t=>{const x=setup(t);x.sessions.set('target',{id:'target',status:'waiting'});await assert.rejects(x.service.execute({requestId:'request-125',type:'send',targetSessionId:'target',text:'继续研究'}),/等待输入/);assert.equal(x.count().sent,0);});
test('missing historical assistant is not silently recreated',async t=>{const x=setup(t);x.service.store.set('sessionId','historical');assert.equal((await x.service.ensureSession()).ok,false);assert.equal(x.count().created,0);});
test('a progress-only turn cannot invoke mutation tools',async t=>{const x=setup(t);x.service.preparePrompt({text:'最近有什么进展',clientSubmissionId:'read-request'});await assert.rejects(x.service.invokeTool({name:'create_session',arguments:{title:'test',text:'do',operationKey:'one',requestToken:x.service.currentRequest.token}}),/未明确委托/);});
test('the reported spoken request creates and submits once through the bound tool',async t=>{
  const x=setup(t);
  x.service.preparePrompt({text:'在想新开一个codex session，然后因为我明天去南通旅游，对你帮我通过那个codex session让他帮我制作一个南通旅游的攻略。',clientSubmissionId:'spoken-create'});
  const args={title:'南通旅游攻略',text:'制作南通旅游攻略',operationKey:'trip',requestToken:x.service.currentRequest.token};
  const first=await x.service.invokeTool({name:'create_session',arguments:args});
  const retry=await x.service.invokeTool({name:'create_session',arguments:{...args,operationKey:'trip-retry'}});
  assert.equal(first.state,'acknowledged');assert.equal(retry.duplicate,true);assert.deepEqual(x.count(),{created:1,sent:1});
});
test('host grant rejects targets outside isolated scope',async t=>{const x=setup(t);x.sessions.set('production',{id:'production',title:'生产任务'});x.service.deps.authorizeAction=()=>false;x.service.preparePrompt({text:'请让生产任务继续研究',clientSubmissionId:'write-request'});await assert.rejects(x.service.invokeTool({name:'send_session',arguments:{sessionId:'production',text:'do',operationKey:'one',requestToken:x.service.currentRequest.token}}),/授权范围/);});
test('slash commands retain their native input contract',t=>{const x=setup(t),request={text:'/status'};assert.equal(x.service.preparePrompt(request),request);});
test('action records survive reopening the ledger',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-ledger-'));const a=new AssistantStore(dir);a.begin('durable-001',{text:'x'});a.close();const b=new AssistantStore(dir);assert.equal(b.begin('durable-001',{text:'x'}).duplicate,true);b.close();});
test('successful transport with an unconfirmed receipt remains unknown',async t=>{const x=setup(t,()=>({ok:true,receipt:{status:'unconfirmed'}}));x.sessions.set('target',{id:'target',status:'idle'});assert.equal((await x.service.execute({requestId:'unconfirmed-01',type:'send',targetSessionId:'target',text:'任务'})).state,'unknown');});
test('an obsolete user-request token cannot mutate a later turn',async t=>{const x=setup(t);x.service.preparePrompt({text:'创建会话研究'});const old=x.service.currentRequest.token;x.service.preparePrompt({text:'创建会话测试'});await assert.rejects(x.service.invokeTool({name:'create_session',arguments:{title:'test',text:'do',operationKey:'one',requestToken:old}}),/不属于当前/);});
test('assistant connects its declared tools without altering normal-session defaults',async t=>{const x=setup(t);x.service.deps.getDefaults=()=>({mcpProfile:'none'});const result=await x.service.ensureSession();assert.equal(result.session.mcpProfile,'lean');assert.deepEqual(result.session.codexMcpEntries.map(e=>e.name),['hub_assistant']);assert.match(x.service.overview().toolConfiguration,/普通会话配置保持不变/);});
test('resending an enhanced prompt rebuilds one envelope from original user text',t=>{const x=setup(t);const first=x.service.preparePrompt({text:'最近24小时有什么进展'});const second=x.service.preparePrompt(first);assert.equal(second.text.split('[AI_HUB_ASSISTANT_CONTEXT_V1]').length,2);assert.match(second.text,/"userText":"最近24小时有什么进展"/);});
test('a status question naming a session cannot authorize sending',async t=>{const x=setup(t);x.sessions.set('target',{id:'target',title:'桌宠研究'});x.service.preparePrompt({text:'请汇报桌宠研究进展'});await assert.rejects(x.service.invokeTool({name:'send_session',arguments:{sessionId:'target',text:'继续',operationKey:'one',requestToken:x.service.currentRequest.token}}),/未明确委托/);});
test('negated delegation cannot authorize a tool write',async t=>{const x=setup(t);x.sessions.set('target',{id:'target',title:'桌宠研究'});x.service.preparePrompt({text:'不要让桌宠研究继续'});await assert.rejects(x.service.invokeTool({name:'send_session',arguments:{sessionId:'target',text:'继续',operationKey:'one',requestToken:x.service.currentRequest.token}}),/未明确委托/);});
test('calendar yesterday respects the requested IANA timezone',()=>{const {resolveTimeRange}=require('../core/hub-assistant/context');const r=resolveTimeRange('昨天什么进展',{now:Date.parse('2026-10-01T08:00:00Z'),timeZone:'America/Los_Angeles'});assert.equal(new Date(r.from).toISOString(),'2026-09-30T07:00:00.000Z');assert.equal(new Date(r.to).toISOString(),'2026-10-01T06:59:59.999Z');});
test('calendar week starts Monday and rolling week remains seven days',()=>{const {resolveTimeRange}=require('../core/hub-assistant/context');const opts={now:Date.parse('2026-10-01T08:00:00Z'),timeZone:'America/Los_Angeles'};assert.equal(new Date(resolveTimeRange('本周有什么进展',opts).from).toISOString(),'2026-09-28T07:00:00.000Z');assert.equal(opts.now-resolveTimeRange('过去一周',opts).from,168*3600000);});
test('malformed source references are visible audit failures',()=>{const {auditCitations}=require('../core/hub-assistant/context');assert.deepEqual(auditCitations('结果 [E123] [F99]',{sources:[]}).invalid,['E123','F99']);});
test('changing model operationKey does not repeat the same user intent',async t=>{const x=setup(t);x.sessions.set('target',{id:'target',title:'桌宠研究',status:'idle'});x.service.preparePrompt({text:'请让桌宠研究继续做设计',clientSubmissionId:'intent-one'});const args={sessionId:'target',text:'继续做设计',operationKey:'first',requestToken:x.service.currentRequest.token};await x.service.invokeTool({name:'send_session',arguments:args});x.sessions.get('target').status='running';const duplicate=await x.service.invokeTool({name:'send_session',arguments:{...args,operationKey:'different'}});assert.equal(duplicate.duplicate,true);assert.equal(x.count().sent,1);});
test('lost create response retries the pre-reserved assistant identity without another launch',async t=>{
  const x=setup(t),create=x.service.deps.createSession;
  x.service.deps.createSession=async(...args)=>{await create(...args);throw new Error('lost launch response');};
  await assert.rejects(x.service.ensureSession(),/lost launch response/);
  const reserved=x.service.store.get('sessionId');assert.ok(x.sessions.has(reserved));
  const recovered=await x.service.ensureSession();assert.equal(recovered.sessionId,reserved);assert.equal(x.count().created,1);
});
test('crash after launch before confirmation cannot create a second assistant after reopening',async t=>{
  const x=setup(t),deps=x.service.deps;
  x.service.store.confirmAssistant=()=>{throw new Error('injected persistence failure');};
  await assert.rejects(x.service.ensureSession(),/injected persistence failure/);
  const reserved=x.service.store.get('sessionId');x.service.close();
  const reopened=new AssistantService(deps);t.after(()=>reopened.close());
  const recovered=await reopened.ensureSession();assert.equal(recovered.sessionId,reserved);assert.equal(x.count().created,1);
  // setup's teardown is idempotent for this intentionally already-closed service.
  x.service.close=()=>{};
});
test('reserved assistant with no recoverable entity remains unknown instead of relaunching',async t=>{
  const x=setup(t);x.service.deps.createSession=async()=>{throw new Error('launch outcome unknown');};
  await assert.rejects(x.service.ensureSession(),/launch outcome unknown/);
  const reserved=x.service.store.get('sessionId'),recovered=await x.service.ensureSession();
  assert.equal(recovered.ok,false);assert.equal(recovered.needsReconciliation,true);assert.equal(recovered.sessionId,reserved);assert.equal(x.count().created,0);
});
test('two services sharing a ledger cannot reserve two assistant identities',async t=>{
  const x=setup(t),second=new AssistantService(x.service.deps);t.after(()=>second.close());
  const attempts=await Promise.allSettled([x.service.ensureSession(),second.ensureSession()]);
  assert.equal(x.count().created,1);
  assert.equal(x.service.store.get('sessionId'),second.store.get('sessionId'));
  assert.equal(attempts.filter(r=>r.status==='fulfilled'&&r.value.ok).length,1);
  assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
  const retry=await second.ensureSession();assert.equal(retry.sessionId,x.service.store.get('sessionId'));assert.equal(x.count().created,1);
});
