'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
test('caller timeouts retain the live child startup lock; only child death permits another launch',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-start-lock-'));
  const file=path.resolve(__dirname,'../main/codex-runtime-broker-client.js');
  const nativeRequire=require('node:module').createRequire(file),alive=new Set([process.pid]);let starts=0;
  const fakeProcess=Object.create(process);
  fakeProcess.kill=pid=>{if(!alive.has(pid))throw Object.assign(Error('dead'),{code:'ESRCH'});};
  const module={exports:{}};
  const wrapper=vm.runInNewContext('(function(require,module,exports,__dirname,process){'+fs.readFileSync(file,'utf8')+'\n})',{
    console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,URL});
  wrapper(name=>name==='child_process'?{spawn(){const child=new EventEmitter();child.pid=700000+(++starts);alive.add(child.pid);child.unref=()=>{};return child;}}:nativeRequire(name),
    module,module.exports,path.dirname(file),fakeProcess);
  await assert.rejects(module.exports.connectBroker({dataDir:dir,timeoutMs:120}));
  await assert.rejects(module.exports.connectBroker({dataDir:dir,timeoutMs:120}));
  assert.equal(starts,1);
  alive.delete(700001);
  await assert.rejects(module.exports.connectBroker({dataDir:dir,timeoutMs:350}));
  assert.equal(starts,2);
});
