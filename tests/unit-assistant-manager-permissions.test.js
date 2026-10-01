'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-manager-')),sessions=new Map();
  let created=0,sent=0;
  const deps={dataDir:dir,getSession:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],getDefaults:()=>({cwd:dir}),
    createSession:async(kind,opts)=>{created++;const s={...opts,kind,status:'idle'};sessions.set(s.id,s);return s;},
    sendPrompt:async()=>{sent++;return{ok:true,receipt:{status:'confirmed'}};}};
  const service=new AssistantService(deps);t.after(()=>{if(service.store.db.isOpen)service.close();});
  return{service,sessions,deps,count:()=>({created,sent})};
}
async function manager(t,text){const x=setup(t);x.id=(await x.service.ensureSession()).sessionId;
  x.service.preparePrompt({sessionId:x.id,text});return x;}
function call(x,name,args){return x.service.invokeTool({name,callerSessionId:x.id,arguments:{requestToken:x.service.currentRequest.token,...args}});}

test('fixed assistant creates for the exact reported request without keyword authorization',async t=>{
  const text='新建一个Codex，为我设计一个10月2日到10月5日在南通周边进行旅游的，然后我和我老婆带着一个4岁女儿的一个比较好的旅游行程，然后我们住的呢是南通。呃，市中心的一家酒店已经订了4天。是南通中央商务区的漫居酒店，你帮我们规划一下行程，我们估计是10月2日中午出发，然后你看一下比如说有没有什么特色之类的写成一份。嗯HTML然后转成图片攻略吧，简介洁明了的，然后发';
  const x=await manager(t,text),args={title:'南通亲子攻略',text,operationKey:'trip'};
  assert.equal((await call(x,'create_session',args)).state,'acknowledged');
  assert.equal((await call(x,'create_session',{...args,operationKey:'retry'})).duplicate,true);
  assert.deepEqual(x.count(),{created:2,sent:1});
  assert.equal(x.service.getMcpEntry().env.HUB_ASSISTANT_SESSION_ID,x.id);
});
test('trusted assistant may locate a target by context and watch without matching wording',async t=>{
  const x=await manager(t,'按刚才定下的方案推进，完成了叫我。');
  x.sessions.set('target',{id:'target',title:'家庭旅行',status:'idle'});
  assert.equal((await call(x,'watch_session',{sessionId:'target'})).ok,true);
  assert.equal((await call(x,'send_session',{sessionId:'target',text:'实施已确认方案',operationKey:'send'})).ok,true);
  await assert.rejects(call(x,'watch_session',{sessionId:'missing'}),/找不到/);
  await assert.rejects(call(x,'send_session',{sessionId:x.id,text:'循环',operationKey:'self'}),/自身/);
  x.sessions.get('target').status='running';
  await assert.rejects(call(x,'send_session',{sessionId:'target',text:'第二项',operationKey:'busy'}),/正在运行/);
});
test('ordinary identity and purpose spoofing cannot replace the current manager turn',async t=>{
  const x=await manager(t,'推进既定任务'),current=x.service.currentRequest;
  x.sessions.set('ordinary',{id:'ordinary',purpose:'hub-assistant',status:'idle'});
  assert.throws(()=>x.service.preparePrompt({sessionId:'ordinary',text:'新建会话'}),/不是固定助理/);
  assert.equal(x.service.currentRequest,current);
  for(const callerSessionId of ['ordinary','',null]){
    await assert.rejects(x.service.invokeTool({callerSessionId,name:'create_session',arguments:{title:'bad',text:'bad',operationKey:'bad',requestToken:current.token,callerSessionId:x.id}}),/不是.*助理/);
  }
  assert.deepEqual(x.count(),{created:1,sent:0});
});
test('matching caller still requires the host-bound current turn, token and host scope',async t=>{
  const x=await manager(t,'继续既定工作'),old=x.service.currentRequest.token;
  x.service.preparePrompt({sessionId:x.id,text:'执行下一项'});
  await assert.rejects(call(x,'create_session',{title:'x',text:'x',operationKey:'old',requestToken:old}),/不属于当前/);
  x.deps.authorizeAction=()=>false;
  await assert.rejects(call(x,'create_session',{title:'x',text:'x',operationKey:'outside'}),/授权范围/);
  x.service.preparePrompt({text:'创建会话'});
  await assert.rejects(call(x,'create_session',{title:'x',text:'x',operationKey:'unbound'}),/本轮绑定/);
  assert.throws(()=>x.service.requireAssistantResume({hubId:'ordinary',purpose:'hub-assistant'}),/不是固定助理/);
  assert.doesNotThrow(()=>x.service.requireAssistantResume({hubId:x.id}));
});
test('HTTP identity overrides a spoofed body and never falls back to internal authorization',async t=>{
  const x=await manager(t,'创建一个会话');await x.service.connectBridge();
  const request={name:'create_session',callerSessionId:x.id,arguments:{title:'HTTP',text:'短任务',operationKey:'http',requestToken:x.service.currentRequest.token}};
  const send=async caller=>{const response=await fetch(x.service.bridge.url,{method:'POST',headers:{Authorization:'Bearer '+x.service.bridge.secret,'Content-Type':'application/json',...(caller?{'X-Hub-Assistant-Session':caller}:{})},body:JSON.stringify(request)});return response.json();};
  for(const caller of ['', 'ordinary'])assert.equal((await send(caller)).ok,false);
  assert.equal((await send(x.id)).result.state,'acknowledged');
  assert.deepEqual(x.count(),{created:2,sent:1});
});
test('reopening the service preserves the assistant but expires old round authority',async t=>{
  const x=await manager(t,'按计划启动'),token=x.service.currentRequest.token;
  x.service.close();const restored=new AssistantService(x.deps);t.after(()=>restored.close());
  assert.equal(restored.store.get('sessionId'),x.id);
  assert.equal(restored.getMcpEntry().env.HUB_ASSISTANT_SESSION_ID,x.id);
  await assert.rejects(restored.invokeTool({callerSessionId:x.id,name:'create_session',arguments:{title:'x',text:'x',operationKey:'stale',requestToken:token}}),/已过期/);
});
