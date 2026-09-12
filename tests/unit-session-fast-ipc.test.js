'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {EventEmitter}=require('events');
const {registerSessionIpc}=require('../main/ipc/session-handlers');
test('Claude fast confirmation preserves global defaults; rejection never changes session preference',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-fast-ipc-')),file=path.join(dir,'settings.json');
 const previousDir=process.env.CLAUDE_CONFIG_DIR,previousNoFast=process.env.CLAUDE_HUB_NO_FAST;
 process.env.CLAUDE_CONFIG_DIR=dir;delete process.env.CLAUDE_HUB_NO_FAST;
 const watcher=require('../core/group-chat-watcher'),original=watcher.sendToPty;
 const session={id:'test',kind:'claude',currentModel:{id:'claude-opus-5'},status:'idle',fastMode:false};
 const manager=new EventEmitter();manager.getSession=()=>session;manager.updateSessionMeta=(_id,fields)=>Object.assign(session,fields);
 const handlers=new Map();registerSessionIpc({handle:(ch,fn)=>handlers.set(ch,fn),on(){}},{sessionManager:manager,sendToRenderer(){}});
 const setFast=enabled=>handlers.get('session:set-fast')({}, {sessionId:'test',enabled});
 try{
  fs.writeFileSync(file,JSON.stringify({fastMode:false,theme:'dark'}));
  watcher.sendToPty=async(sid,prompt,kind,options)=>{
   assert.equal(prompt,'/fast on');assert.equal(kind,'claude');
   fs.writeFileSync(file,JSON.stringify({fastMode:true,theme:'light'}));
   manager.emit('output',{sessionId:sid,data:prompt+'\nFast mode ON'});
   return options.localCommandObserver.wait(10);
  };
  assert.equal((await setFast(true)).ok,true);assert.equal(session.fastMode,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{fastMode:false,theme:'light'});
  watcher.sendToPty=async()=>({ok:false,message:'credits exhausted'});
  assert.equal((await setFast(false)).ok,false);assert.equal(session.fastMode,true);
  session.currentModel.id='claude-sonnet-4-8';assert.equal((await setFast(true)).ok,false);
  assert.equal(manager.listenerCount('output'),0);
 }finally{watcher.sendToPty=original;if(previousDir===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previousDir;if(previousNoFast===undefined)delete process.env.CLAUDE_HUB_NO_FAST;else process.env.CLAUDE_HUB_NO_FAST=previousNoFast;}
});

test('native Claude switches speed over the protocol, keeps the relaunch overlay and never claims an unconfirmed switch',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-fast-native-')),overlay=path.join(dir,'session.json');
 const previousNoFast=process.env.CLAUDE_HUB_NO_FAST;delete process.env.CLAUDE_HUB_NO_FAST;
 fs.writeFileSync(overlay,JSON.stringify({fastMode:false,permissions:{allow:['Read']}}));
 const {ClaudeNativeSession}=require('../core/claude-native-session');
 const session={id:'n1',kind:'claude',currentModel:{id:'claude-opus-5'},status:'idle',fastMode:false,
  runtimeBackend:'claude-stream-json',nativeRuntime:{state:'idle',connection:'connected',epoch:1,revision:1}};
 const manager=new EventEmitter();manager.getSession=()=>session;
 manager.updateSessionMeta=(_id,fields)=>Object.assign(session,fields);
 const native=new ClaudeNativeSession({id:'n1',kind:'claude',cwd:dir,launchArgs:['--model','claude-opus-5'],
  settingsFile:overlay,sessionId:'11111111-2222-3333-4444-555555555555'});
 const controls=[];
 native.ready=Promise.resolve();
 native.client={control:async request=>{controls.push(request);
  if(request.settings.fastMode===false)throw new Error('fast mode unavailable');return {};}};
 manager.getNativeClaude=()=>native;
 const updates=[];
 const handlers=new Map();registerSessionIpc({handle:(ch,fn)=>handlers.set(ch,fn),on(){}},
  {sessionManager:manager,sendToRenderer:(_channel,payload)=>updates.push(payload)});
 const setFast=enabled=>handlers.get('session:set-fast')({}, {sessionId:'n1',enabled});
 try{
  const on=await setFast(true);
  assert.equal(on.ok,true);
  assert.deepEqual(controls,[{subtype:'apply_flag_settings',settings:{fastMode:true}}]);
  assert.equal(session.fastMode,true);
  assert.equal(updates.length,1);
  // The relaunch overlay follows the confirmed tier without losing other keys.
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay,'utf8')),{fastMode:true,permissions:{allow:['Read']}});
  // A rejected control request must leave the session and overlay untouched.
  const off=await setFast(false);
  assert.equal(off.ok,false);
  assert.match(off.message,/fast mode unavailable/);
  assert.equal(session.fastMode,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay,'utf8')),{fastMode:true,permissions:{allow:['Read']}});
  assert.equal(require('../core/session-speed').pendingSpeedSwitches.has('n1'),false);
  // The engine's own state is enough: a model the static table does not know
  // must still be switchable, otherwise Fast can be turned on but never off.
  session.currentModel.id='claude-opus-9-future';
  session.nativeRuntime.fastMode=true;
  controls.length=0;
  const again=await setFast(false).catch(error=>({ok:false,message:error.message}));
  assert.equal(again.ok,false,'the stub rejects fastMode:false');
  assert.deepEqual(controls,[{subtype:'apply_flag_settings',settings:{fastMode:false}}],
    'the request reached the engine instead of being blocked by the model table');
 }finally{if(previousNoFast===undefined)delete process.env.CLAUDE_HUB_NO_FAST;else process.env.CLAUDE_HUB_NO_FAST=previousNoFast;}
});
