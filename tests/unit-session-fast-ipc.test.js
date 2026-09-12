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
