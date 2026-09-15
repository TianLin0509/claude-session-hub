'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createWebStartup } = require('../core/chatgpt-web-startup');
const { openWebSettings } = require('../core/chatgpt-web-integration');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-startup-'));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'isolation.json'), JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:17862}));
  fs.writeFileSync(path.join(root, 'runtime/config.json'), JSON.stringify({host:'127.0.0.1',port:17862,mode:'full'}));
  return { AI_HUB_CHATGPT_ROOT: root, OPENAI_BASE_URL:'http://127.0.0.1:17841/v1' };
}
const offline = {ok:true,online:false,connected:false};
test('concurrent creation waits for readiness and starts one hidden dedicated launcher', async () => {
  const env=fixture(); let starts=0, checks=0, ready=false;
  const ensure=createWebStartup({status:async()=>{checks++;return ready?{ok:true,online:true}:offline;},running:()=>false,
    launch:async opts=>{starts++;assert.equal(opts.background,true);assert.equal(opts.env,env);},sleep:async()=>{ready=true;}});
  const a=ensure('chatgpt-web/high',env), b=ensure('chatgpt-web/medium',env);
  assert.equal(a,b); assert.equal((await a).online,true); assert.equal(starts,1); assert.equal(checks,2);
});
test('healthy service is reused without spawning or touching its owner', async () => {
  const ensure=createWebStartup({status:async()=>({ok:true,online:true}),running:()=>assert.fail('owner probe unnecessary'),launch:()=>assert.fail('must not start')});
  assert.equal((await ensure('chatgpt-web/high',fixture())).online,true);
});
test('separate Hub callers share the startup claim and do not focus a second instance', async () => {
  const env=fixture(); let starts=0, ready=false;
  const options={status:async()=>ready?{ok:true,online:true}:offline,running:()=>false,
    launch:async()=>{starts++;},sleep:async()=>{ready=true;}};
  await Promise.all([createWebStartup(options)('chatgpt-web/high',env),createWebStartup(options)('chatgpt-web/high',env)]);
  assert.equal(starts,1);
  assert.equal(fs.existsSync(path.join(env.AI_HUB_CHATGPT_ROOT,'runtime/ai-hub-startup.json')),false);
});
test('running owner and draining service are waited on without relaunch', async () => {
  for (const connected of [false,true]) {
    let ready=false;
    const ensure=createWebStartup({status:async()=>({ok:true,online:ready,connected}),running:()=>true,
      launch:()=>assert.fail('existing owner must not be relaunched'),sleep:async()=>{ready=true;}});
    assert.equal((await ensure('chatgpt-web/high',fixture())).online,true);
  }
});
test('bounded failure propagates and a later explicit retry can succeed', async () => {
  let time=0, ready=false, starts=0;
  const ensure=createWebStartup({status:async()=>ready?{ok:true,online:true}:offline,running:()=>false,
    launch:async()=>{starts++;},timeoutMs:10,pollMs:5,now:()=>time,sleep:async ms=>{time+=ms;}});
  const env=fixture(); await assert.rejects(ensure('chatgpt-web/high',env),/消息尚未发送/);
  ready=true; assert.equal((await ensure('chatgpt-web/high',env)).online,true); assert.equal(starts,1);
});
test('spawn errors propagate and invalid mode/model never launches', async () => {
  const ensure=createWebStartup({status:async()=>offline,running:()=>false,launch:async()=>{throw Error('spawn failed');}});
  const env=fixture(); await assert.rejects(ensure('chatgpt-web/high',env),/spawn failed/);
  assert.throws(()=>ensure('gpt-6-astra',env),/不可用/);
  fs.writeFileSync(path.join(env.AI_HUB_CHATGPT_ROOT,'runtime/config.json'),JSON.stringify({host:'127.0.0.1',port:17862,mode:'browser-only'}));
  assert.throws(()=>ensure('chatgpt-web/high',env),/Full MCP/);
});
test('test or alternate isolation root cannot launch the fixed production executable', async () => {
  await assert.rejects(openWebSettings({background:true,env:fixture()}),/隔离目录不匹配|未安装/);
});
test('installed launcher receives --hidden and isolated homes without inherited API credentials', {
  skip: !fs.existsSync('C:/DevTools/CodexWebGPT-AIHub/ai-hub-isolation-install.json'),
}, async t => {
  const {EventEmitter}=require('events'); let invocation;
  t.mock.method(require('child_process'),'spawn',(exe,args,options)=>{
    invocation={exe,args,options};const child=new EventEmitter();child.unref=()=>{};
    process.nextTick(()=>child.emit('spawn'));return child;
  });
  const env={...process.env,AI_HUB_CHATGPT_ROOT:'C:/VibeData/CodexChatGPTWeb/ai-hub-isolated',CODEX_HOME:'C:/ordinary',OPENAI_API_KEY:'never-pass',OPENAI_BASE_URL:'http://127.0.0.1:17841/v1',ELECTRON_RUN_AS_NODE:'1'};
  await openWebSettings({background:true,env});
  assert.deepEqual(invocation.args,['--hidden']);
  assert.equal(invocation.options.windowsHide,true);
  assert.equal(invocation.options.env.CODEX_HOME,path.resolve(env.AI_HUB_CHATGPT_ROOT,'codex-home'));
  for(const key of ['OPENAI_API_KEY','OPENAI_BASE_URL','ELECTRON_RUN_AS_NODE']) assert.equal(invocation.options.env[key],undefined);
});
