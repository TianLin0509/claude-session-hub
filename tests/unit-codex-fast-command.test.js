'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {captureServiceTier,restoreServiceTier,observeCodexFastCommand,registerCodexSpeedIpc}=require('../core/codex-fast-command');
test('Codex confirmation parses real partial TUI repaints and excludes old acknowledgements',async()=>{
  const manager=new EventEmitter();manager.getSessionBufferSnapshot=()=>({cols:100,rows:12,seq:5,text:'\x1b[2J\x1b[3;1H• Service tier set to default\x1b[8;1H› Ask Codex to do anything'});
  const observer=await observeCodexFastCommand(manager,'target');
  try{
    assert.equal(await observer.ready(),true);await observer.arm();
    manager.emit('output',{sessionId:'other',data:'Service tier set to priority'});
    assert.equal((await observer.wait(5)).ok,false);
    // CLI 0.159.3 may retain the unchanged prefix and only repaint the tier.
    manager.emit('output',{sessionId:'target',data:'\x1b[3;23Hpriority\x1b[K'});
    assert.deepEqual(await observer.wait(100),{ok:true,tier:'fast'});
    await observer.arm();assert.equal((await observer.wait(5)).ok,false);
    manager.emit('output',{sessionId:'target',data:'\x1b[3;23Hdefault\x1b[K'});
    assert.equal((await observer.wait(100)).tier,'standard');
  }finally{observer.dispose();assert.equal(manager.listenerCount('output'),0);}
});
test('Codex speed restores only its top-level field, preserving concurrent edits and profile tiers',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-speed-unit-')),file=path.join(dir,'config.toml');
  fs.writeFileSync(file,"# settings\nservice_tier = 'fast' # user preference\nmodel = 'gpt-6-astra'\n[profiles.work]\nservice_tier='flex'\n");
  const saved=captureServiceTier(file);
  fs.writeFileSync(file,"# settings\nservice_tier = 'default'\nmodel = 'gpt-6-sol'\n[profiles.work]\nservice_tier='flex'\n");
  restoreServiceTier(saved,'default');
  assert.equal(fs.readFileSync(file,'utf8'),"# settings\nservice_tier = 'fast' # user preference\nmodel = 'gpt-6-sol'\n[profiles.work]\nservice_tier='flex'\n");
  fs.writeFileSync(file,"service_tier='flex'\n");restoreServiceTier(saved,'default');
  assert.equal(fs.readFileSync(file,'utf8'),"service_tier='flex'\n",'different concurrent tier is retained');
  fs.writeFileSync(file,"model='gpt-6-astra'\n[profiles.work]\nservice_tier='flex'\n");
  const absent=captureServiceTier(file);fs.writeFileSync(file,"service_tier='fast'\nmodel='gpt-6-astra'\n[profiles.work]\nservice_tier='flex'\n");
  restoreServiceTier(absent,'fast');assert.equal(fs.readFileSync(file,'utf8'),"model='gpt-6-astra'\n[profiles.work]\nservice_tier='flex'\n");
});
test('Codex IPC reaches requested tier after native toggles and keeps model, effort and global preference',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-speed-ipc-')),file=path.join(dir,'config.toml');
  fs.writeFileSync(file,"service_tier='fast'\nmodel='gpt-6-astra'\n");
  fs.writeFileSync(path.join(dir,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6-astra',additional_speed_tiers:['fast']}]}));
  const session={id:'test',kind:'codex',status:'idle',codexSessionsRoot:path.join(dir,'sessions'),currentModel:{id:'gpt-6-astra'},effort:'high',codexSpeedTier:'fast'};
  const manager=new EventEmitter();manager.getSession=()=>session;manager.updateSessionMeta=(_sid,fields)=>Object.assign(session,fields);
  manager.getSessionBufferSnapshot=()=>({cols:100,rows:12,text:'\x1b[2J\x1b[3;1H• Service tier set to priority\x1b[8;1H› Ask Codex to do anything'});
  const handlers=new Map();registerCodexSpeedIpc({handle:(key,fn)=>handlers.set(key,fn)},{sessionManager:manager,sendToRenderer(){}});
  const watcher=require('../core/group-chat-watcher'),original=watcher.sendToPty;let actual='fast',calls=0;
  watcher.sendToPty=async(sid,prompt,kind,options)=>{
    assert.equal(prompt,'/fast');calls++;actual=actual==='fast'?'standard':'fast';
    fs.writeFileSync(file,`service_tier='${actual==='fast'?'fast':'default'}'\nmodel='gpt-6-sol'\n`);
    manager.emit('output',{sessionId:sid,data:`\x1b[3;23H${actual==='fast'?'priority':'default'}\x1b[K`});
    const acknowledgement=await options.localCommandObserver.wait(100);
    await new Promise(resolve=>setTimeout(resolve,10));
    return acknowledgement;
  };
  try{
    const choose=tier=>handlers.get('codex:set-speed')({}, {sessionId:'test',tier});
    assert.equal((await choose('fast')).ok,true,'already-selected native tier requires two confirmed toggles');
    assert.equal(calls,2);assert.equal(session.codexSpeedTier,'fast');assert.equal(session.effort,'high');assert.equal(session.currentModel.id,'gpt-6-astra');
    assert.match(fs.readFileSync(file,'utf8'),/service_tier='fast'/);assert.match(fs.readFileSync(file,'utf8'),/model='gpt-6-sol'/);
    session.status='running';assert.equal((await choose('standard')).ok,false);assert.equal(calls,2);
    assert.equal(require('../core/session-speed').pendingSpeedSwitches.has('test'),false);
    assert.equal(manager.listenerCount('output'),0);
  }finally{watcher.sendToPty=original;}
});
