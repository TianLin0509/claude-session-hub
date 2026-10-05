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
test('the assistant stays one session however large its context grows (the CLI compacts it)',async t=>{
  const x=setup(t),retired=[];x.deps.retireSession=async id=>retired.push(id);
  const a=await x.service.ensureSession();
  assert.equal(x.service.observeUsage(a.sessionId,{input_tokens:2000,cache_read_input_tokens:90000,cache_creation_input_tokens:1000}),93000);
  x.service.observeUsage(a.sessionId,{input_tokens:3000,cache_read_input_tokens:600000});
  x.service.store.set('lastActiveAt:'+a.sessionId,Date.now()-30*3600000);
  assert.equal((await x.service.ensureSession()).sessionId,a.sessionId,'no automatic new session: not for size, idle or a new day');
  assert.deepEqual(retired,[]);
  assert.equal(x.service.observeUsage('not-an-assistant',{input_tokens:999999}),null);
});
test('codex usage counts cached tokens once; a failed manual new session keeps the old assistant bound',async t=>{
  const x=setup(t);x.service.store.set('assistantDefaultsVersion',2);x.service.store.set('backendKind','codex');
  const a=await x.service.ensureSession();
  assert.equal(x.service.observeUsage(a.sessionId,{input_tokens:160000,cache_read_input_tokens:150000}),160000);
  x.deps.sendPrompt=async()=>({ok:false});x.deps.createSession=async()=>{throw new Error('CLI 未登录');};
  await assert.rejects(x.service.rotateNow(),/未登录/);
  assert.equal(x.service.store.get('sessionId'),a.sessionId);assert.equal(x.service.isAssistantSession(a.sessionId),true);
});
test('checkpoint policy: once a day after 2 idle hours or the 4 am boundary, only for a used assistant',()=>{
  const r=require('../core/hub-assistant/rotation'),now=new Date(2026,9,3,10,0,0).getTime(),h=3600000;
  assert.equal(r.checkpointReason({tokens:40000,lastActiveAt:now-1*h,now}),null);
  assert.equal(r.checkpointReason({tokens:40000,lastActiveAt:now-2.5*h,now}),'idle');
  assert.equal(r.checkpointReason({tokens:10000,lastActiveAt:now-5*h,now}),null,'nearly empty sessions need no record');
  const early=new Date(2026,9,3,4,30,0).getTime();
  assert.equal(r.checkpointReason({tokens:40000,lastActiveAt:early-1*h,now:early}),'daily');
  assert.equal(r.checkpointReason({tokens:40000,lastActiveAt:now-3*h,lastCheckpointAt:now-2*h,now}),null,'already written today');
  assert.equal(r.checkpointReason({tokens:40000,lastActiveAt:now-3*h,lastCheckpointAt:now-26*h,now}),'idle');
  assert.equal(r.checkpointReason({tokens:40000,lastActiveAt:now-27*h,lastCheckpointAt:now-26*h,now}),null,'not used since the last record');
});
test('the daily checkpoint writes a handoff in the same session; manual new session still hands off; turns are logged',async t=>{
  const x=setup(t),retired=[];x.deps.retireSession=async id=>retired.push(id);
  const a=await x.service.ensureSession();
  x.service.preparePrompt({sessionId:a.sessionId,text:'查进展',clientSubmissionId:'metric-turn'});
  x.service.observeUsage(a.sessionId,{input_tokens:1000,cache_read_input_tokens:44000},Date.now());
  const metrics=fs.readFileSync(path.join(x.deps.dataDir,'assistant','turn-metrics.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(metrics.at(-1).tokens,45000);assert.equal(typeof metrics.at(-1).ms,'number');
  assert.equal(await x.service.maybeCheckpointInBackground(),null,'recently active: nothing to record');
  x.service.store.set('lastActiveAt:'+a.sessionId,Date.now()-3*3600000);
  let handoffId=null,prompt='';x.deps.sendPrompt=async(id,text,requestId)=>{assert.equal(id,a.sessionId);prompt=text;handoffId=requestId;return{ok:true,receipt:{status:'confirmed'}};};
  x.service.liveHistory={read:()=>({records:handoffId?[{clientSubmissionId:handoffId,text:'还在等调度报告；田哥要求汇报只讲结果。'}]:[]})};
  const c=await x.service.maybeCheckpointInBackground();
  assert.equal(c.ok,true);assert.equal(c.sessionId,a.sessionId);assert.match(prompt,/交接记录/);assert.match(prompt,/还是这个会话/);
  assert.equal((await x.service.ensureSession()).sessionId,a.sessionId,'same session after the record');assert.deepEqual(retired,[]);
  assert.ok(x.service.continuity.packet().records.some(row=>row.text.startsWith('【交接记录】还在等调度报告')));
  assert.equal(x.service.overview().context.lastCheckpoint.reason,'idle');
  assert.equal(await x.service.maybeCheckpointInBackground(),null,'once a day');
  handoffId=null;x.deps.sendPrompt=async(id,text,requestId)=>{assert.match(text,/换班交接/);handoffId=requestId;return{ok:true,receipt:{status:'confirmed'}};};
  const b=await x.service.rotateNow();
  assert.notEqual(b.sessionId,a.sessionId);assert.deepEqual(retired,[a.sessionId]);
  assert.equal(x.service.overview().context.lastRotation.reason,'manual');
  x.sessions.get(b.sessionId).status='running';assert.throws(()=>x.service.rotateNow(),/正在回答/);
});
test('the background timer only checks followed tasks; the workbench is rebuilt on demand and old archives are pruned',async t=>{
  const x=setup(t);await x.service.ensureSession();
  const workbench=path.join(x.deps.dataDir,'assistant','workbench','CURRENT.md');
  x.service.pollWatches();assert.equal(fs.existsSync(workbench),false,'polling must not rebuild the workbench');
  x.service.context({hours:3});assert.equal(fs.existsSync(workbench),true,'asking rebuilds it');
  const folder=path.join(x.deps.dataDir,'assistant','workbench','sessions','abc');fs.mkdirSync(folder,{recursive:true});
  for(let i=0;i<6;i++){const f=path.join(folder,'v'+i+'.md');fs.writeFileSync(f,'x');fs.utimesSync(f,new Date(Date.now()-i*1000),new Date(Date.now()-i*1000));}
  x.service.context({hours:3});assert.deepEqual(fs.readdirSync(folder).sort(),['v0.md','v1.md','v2.md']);
  const snaps=path.join(x.deps.dataDir,'assistant','snapshots');fs.mkdirSync(snaps,{recursive:true});const old=path.join(snaps,'old.json');fs.writeFileSync(old,'{}');fs.utimesSync(old,new Date(Date.now()-8*86400000),new Date(Date.now()-8*86400000));
  x.service.snapshots.prune();assert.equal(fs.existsSync(old),false);
});
test('growth memory: dated entries, no duplicates, consolidation, caps, no secrets, every change backed up',()=>{
  const {AssistantMemory}=require('../core/hub-assistant/memory'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-memory-')),m=new AssistantMemory(dir),now=Date.parse('2026-10-04T08:00:00Z');
  assert.equal(m.update({file:'user',action:'add',text:'汇报进展先给结论，再列待田哥处理的事',reason:'田哥明说',now}).ok,true);
  assert.match(m.read().user,/- 汇报进展先给结论，再列待田哥处理的事（2026-10-0[34]，田哥明说）/);
  assert.equal(m.update({file:'user',action:'add',text:'汇报进展先给结论，再列待田哥处理的事',now}).unchanged,true);
  m.update({file:'memory',action:'add',text:'仿真项目在 C:/AIWork/SuperRAN',now});
  assert.throws(()=>m.update({file:'memory',action:'add',text:'api_key: sk-abcdefghijklmnopqrstuvwxyz',now}),/密钥/);
  assert.throws(()=>m.update({file:'user',action:'add',text:'第一行\n第二行',now}),/一句话/);
  assert.throws(()=>m.update({file:'user',action:'remove',text:'不存在的条目',now}),/没有找到/);
  m.update({file:'user',action:'remove',text:'先给结论',now});assert.doesNotMatch(m.read().user,/先给结论/);
  assert.throws(()=>m.update({file:'user',action:'rewrite',text:'- 很长'.repeat(1200),now}),/上限/);
  m.update({file:'user',action:'rewrite',text:'- 简单问答只用一句话（2026-10-04）',now});assert.match(m.read().user,/# 田哥的偏好与习惯/);
  assert.ok(fs.readdirSync(path.join(dir,'history')).length>=4);assert.match(fs.readFileSync(path.join(dir,'CHANGES.md'),'utf8'),/USER.md · rewrite/);
  assert.match(fs.readFileSync(m.promptPath,'utf8'),/简单问答只用一句话[\s\S]*仿真项目在/);
});
test('only the bound assistant writes memory; Claude loads it as a system prompt, others read it on a new session first turn',async t=>{
  const x=setup(t),a=await x.service.ensureSession();
  assert.match(a.session.appendSystemPromptFile,/assistant-system-prompt\.md$/);
  x.service.preparePrompt({sessionId:a.sessionId,text:'记住：简单问答只用一句话',clientSubmissionId:'remember-1'});
  const token=x.service.currentRequest.token;
  await assert.rejects(x.service.invokeTool({name:'update_memory',callerSessionId:'someone-else',arguments:{file:'user',action:'add',text:'x',requestToken:token}}),/不是/);
  await assert.rejects(x.service.invokeTool({name:'update_memory',callerSessionId:a.sessionId,arguments:{file:'user',action:'add',text:'x',requestToken:'stale'}}),/当前用户回合/);
  const r=await x.service.invokeTool({name:'update_memory',callerSessionId:a.sessionId,arguments:{file:'user',action:'add',text:'简单问答只用一句话',reason:'田哥明说',requestToken:token}});
  assert.equal(r.ok,true);assert.match(fs.readFileSync(a.session.appendSystemPromptFile,'utf8'),/简单问答只用一句话/);
  assert.match(x.service.context({hours:3}).assistantMemory.user,/简单问答只用一句话/);
  const claudeFirst=x.service.preparePrompt({sessionId:a.sessionId,text:'你好',clientSubmissionId:'c2'}).text;assert.doesNotMatch(claudeFirst,/新会话第一轮/);
  const codex=await x.service.setProfile({kind:'codex'});const cid=(await x.service.ensureSession()).sessionId;assert.equal(codex.ok,true);
  assert.match(x.service.preparePrompt({sessionId:cid,text:'你好',clientSubmissionId:'k1'}).text,/新会话第一轮/);
  assert.doesNotMatch(x.service.preparePrompt({sessionId:cid,text:'再问',clientSubmissionId:'k2'}).text,/新会话第一轮/);
});
