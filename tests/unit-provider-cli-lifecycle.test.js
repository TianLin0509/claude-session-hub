'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {JsonlTail}=require('../core/jsonl-tail');
const pty=require('node-pty');
function fixture(kind){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cli-lifecycle-'));
  fs.mkdirSync(path.join(home,'.qwen'));fs.writeFileSync(path.join(home,'.qwen/settings.json'),'{}');
  const martty=path.join(home,'node_modules/martty');fs.mkdirSync(martty,{recursive:true});
  fs.writeFileSync(path.join(martty,'package.json'),'{}');
  const Class=kind==='qwen'?require('../core/qwen-cli-session').QwenCliSession:require('../core/martty-cli-session').MarttyCliSession;
  const session=new Class({id:'lifecycle',kind,home,cwd:home,model:'test',launch:{command:process.execPath,args:[path.join(home,'agent.js')],env:{}}});
  return{session,close(){session.kill();fs.rmSync(home,{recursive:true,force:true});}};
}
for(const kind of ['qwen','glm'])test(kind+' closing during asynchronous startup never creates a terminal',async t=>{
  const f=fixture(kind);let release,spawns=0;
  t.mock.method(JsonlTail.prototype,'start',()=>new Promise(resolve=>{release=resolve;}));
  t.mock.method(pty,'spawn',()=>{spawns++;throw Error('SPAWN_AFTER_CLOSE');});
  try{
    const startup=f.session.start();const checked=assert.rejects(startup,/关闭/);
    f.session.kill();release();await checked;
    assert.equal(spawns,0);
  }finally{f.close();}
});
for(const kind of ['qwen','glm'])test(kind+' a failed pre-send callback leaves no pending submission',async()=>{
  const f=fixture(kind),s=f.session;s.start=async()=>{};s.runtime={...s.runtime,connection:'connected',state:'idle'};
  try{
    await assert.rejects(s.send('hello',{beforeStart(){throw Error('save failed');}}),/save failed/);
    assert.equal(s.pending,null);
  }finally{f.close();}
});
test('GLM disconnect while pasting rejects the send without an unhandled promise',async t=>{
  const f=fixture('glm'),s=f.session;s.start=async()=>{};s.runtime={...s.runtime,connection:'connected',state:'idle'};
  const input=require('../core/martty-prompt-input'),paste=require('../core/pty-prompt-submit');
  t.mock.method(input,'writeMarttyPrompt',async()=>{
    s.fail(Error('transport disconnected'));
    await new Promise(resolve=>setImmediate(resolve));
  });
  t.mock.method(paste,'waitForPasteSettled',async()=>{});
  s.write=()=>{};
  try{await assert.rejects(s.send('hello'),/transport disconnected/);}
  finally{f.close();}
});
test('GLM native thread switch retires old turns and ignores their late events',()=>{
  const f=fixture('glm'),s=f.session;s.threadId='old';s.currentModel='current';
  const observe=(direction,message)=>s.observe({direction,at:Date.now(),message});
  try{
    observe('client',{id:1,method:'session/prompt',params:{sessionId:'old',prompt:[{type:'text',text:'old task'}]}});
    observe('client',{id:2,method:'session/new',params:{}});
    observe('agent',{id:2,result:{sessionId:'new'}});
    assert.equal(s.active,null);
    observe('agent',{id:1,error:{message:'old cancellation'}});
    observe('agent',{method:'session/update',params:{sessionId:'old',update:{sessionUpdate:'config_option_update',configOptions:[{category:'model',currentValue:'stale-model'}]}}});
    observe('agent',{id:3,method:'session/request_permission',params:{sessionId:'old'}});
    assert.equal(s.runtime.state,'idle');assert.equal(s.runtime.requests.length,0);assert.equal(s.currentModel,'current');
  }finally{f.close();}
});
test('GLM persistence failure still terminates the owned terminal and reports the error',()=>{
  const f=fixture('glm'),s=f.session;let killed=false;
  s.pty={kill(){killed=true;}};
  s.persist=()=>{throw Error('disk full');};
  try{assert.throws(()=>s.kill(),/disk full/);assert.equal(killed,true);assert.equal(s.closed,true);}
  finally{s.persist=()=>{};f.close();}
});
