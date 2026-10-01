'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
const { registerSessionIpc } = require('../main/ipc/session-handlers');
const { creationDefaults } = require('../core/session-creation-defaults');
function promptHarness(preparePrompt) {
  const handlers = new Map(), sent = [], manager = new EventEmitter();
  manager.getSession = id => ({id,kind:'powershell'});
  manager.writeToSession = (id,text) => sent.push({id,text});
  const service = registerPromptSubmitIpc({handle:(name,fn)=>handlers.set(name,fn)}, {sessionManager:manager,preparePrompt});
  return {handlers,sent,service};
}
test('context preparation is shared by UI and internal submission and preserves target',async()=>{
  const h=promptHarness(request=>({...request,sessionId:'other',text:'context\n'+request.text}));
  await h.handlers.get('session:send-prompt')(null,{sessionId:'one',text:'first'});
  await h.service.submitPrompt(null,{sessionId:'one',text:'second'});
  assert.deepEqual(h.sent,[{id:'one',text:'context\nfirst\r'},{id:'one',text:'context\nsecond\r'}]);h.service.dispose();
});
test('context preparation failure makes zero writes and returns notSent',async()=>{
  const h=promptHarness(()=>{throw new Error('assistant is busy');});
  const r=await h.service.submitPrompt(null,{sessionId:'one',text:'question'});
  assert.equal(r.ok,false);assert.equal(r.notSent,true);assert.equal(h.sent.length,0);h.service.dispose();
});
test('slash commands retain their original content without preparation',async()=>{
  let calls=0;const h=promptHarness(()=>{calls++;throw new Error('must not call');});
  await h.service.submitPrompt(null,{sessionId:'one',text:'/status'});
  assert.equal(calls,0);assert.equal(h.sent[0].text,'/status\r');h.service.dispose();
});
test('concurrent assistant submit cannot replace authority while the first context is preparing',async()=>{
  let release, calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const handlers=new Map(),writes=[],manager=new EventEmitter();
  manager.getSession=id=>({id,kind:'powershell',purpose:'hub-assistant'});
  manager.writeToSession=(id,text)=>writes.push(text);
  const service=registerPromptSubmitIpc({handle:(name,fn)=>handlers.set(name,fn)}, {sessionManager:manager,
    async preparePrompt(request){calls++;await gate;return request;}});
  const first=service.submitPrompt(null,{sessionId:'assistant',text:'first'});
  const second=await service.submitPrompt(null,{sessionId:'assistant',text:'second'});
  assert.equal(second.notSent,true);assert.equal(calls,1);
  release();await first;assert.deepEqual(writes,['first\r']);service.dispose();
});
test('shared create entry preserves workspace resolution, registration and renderer event',()=>{
  const handlers=new Map(),calls=[];const sm={on(){},createSession(kind,opts){calls.push(['create',kind,opts.cwd]);return {id:opts.id,kind,...opts};}};
  const service=registerSessionIpc({handle:(k,f)=>handlers.set(k,f),on(){}},{sessionManager:sm,workspaceService:{resolveForSession(cwd){calls.push(['resolve',cwd]);return {path:'C:/isolated-work'};}},registerSessionForTap(s){calls.push(['tap',s.id]);},sendToRenderer(event,data){calls.push([event,data.session.id]);}});
  service.createSession({kind:'codex',opts:{id:'assistant-test'}});
  assert.deepEqual(calls,[['resolve',undefined],['create','codex','C:/isolated-work'],['tap','assistant-test'],['session-created','assistant-test']]);
});
test('assistant work creation keeps saved model/profile and ordinary tuning defaults',()=>{
  const opts=creationDefaults('codex',{defaultModels:{codex:'gpt-6-astra'},codexSubscriptionProfile:'chosen'});
  assert.equal(opts.model,'gpt-6-astra');assert.equal(opts.codexProfile,'chosen');assert.equal(opts.effort,'high');assert.equal(opts.codexSpeedTier,'standard');assert.equal(opts.mcpProfile,'none');
  assert.equal(creationDefaults('claude').effort,'high');assert.equal(creationDefaults('deepseek').effort,'max');
});
test('new assistant and delegated targets wait for CLI readiness without changing ordinary sends',async()=>{
  const watcher=require('../core/group-chat-watcher'),old=watcher.sendToPty;
  const manager=new EventEmitter(),options=[];manager.getSession=id=>({id,kind:'codex',...(id==='assistant'?{purpose:'hub-assistant'}:{})});
  watcher.sendToPty=async(_id,_text,_kind,opts)=>{options.push(opts.requireReady);return{ok:true,sendStatus:'ok'};};
  const registration=registerPromptSubmitIpc({handle(){}},{sessionManager:manager});
  try{
    await registration.submitPrompt(null,{sessionId:'assistant',text:'question'});
    await registration.submitPrompt(null,{sessionId:'target',text:'delegation',waitForCliReady:true});
    await registration.submitPrompt(null,{sessionId:'ordinary',text:'ordinary'});
    assert.deepEqual(options,[true,true,false]);
  }finally{watcher.sendToPty=old;registration.dispose();}
});
