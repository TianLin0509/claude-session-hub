'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {speedControl,claudeSupportsFast}=require('../core/session-speed');
const {parseFastConfirmation,observeClaudeFastCommand}=require('../core/claude-fast-command');
test('Fast capability never changes model or treats effort as speed',()=>{
  for(const model of ['sonnet','claude-sonnet-4-8','opus','claude-opus-4-7','claude-opus-4-6']) assert.equal(claudeSupportsFast(model),false);
  for(const model of ['claude-opus-5','claude-opus-4-8','opus-5[1m]']) assert.equal(claudeSupportsFast(model),true);
  const session={kind:'codex',runtimeBackend:'codex-app-server',effort:'ultra',codexSpeedTier:'standard'};
  assert.equal(speedControl(session,{fromCache:true,supportsFast:true}).label,'标准');
  assert.equal(speedControl(session,{fromCache:true,supportsFast:false}).visible,false);
  assert.equal(speedControl({...session,codexSpeedTier:'inherit'},{fromCache:true,supportsFast:true}).label,'跟随配置');
});
test('Claude needs matching fresh command and positive acknowledgement',async()=>{
  assert.equal(parseFastConfirmation('Fast mode ON',true),null);
  assert.equal(parseFastConfirmation('/fast off\nFast mode OFF',true),null);
  assert.equal(parseFastConfirmation('/fast on\nChecking fast mode availability',true),null);
  assert.equal(parseFastConfirmation('/fast on\nFast mode unavailable: credits exhausted',true).ok,false);
  const {EventEmitter}=require('events');const manager=new EventEmitter();
  const observer=observeClaudeFastCommand(manager,'target',true);
  manager.emit('output',{sessionId:'other',data:'/fast on\nFast mode ON'});
  assert.equal((await observer.wait(5)).ok,false);
  manager.emit('output',{sessionId:'target',data:'/fast on\nFast mode O'});
  manager.emit('output',{sessionId:'target',data:'N'});
  assert.equal((await observer.wait(5)).ok,true);
  observer.dispose();assert.equal(manager.listenerCount('output'),0);
});
