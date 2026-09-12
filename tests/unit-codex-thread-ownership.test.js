'use strict';
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
const {claimThread,releaseThread,assertNoOtherHubOwner}=require('../core/codex-thread-ownership');
const home=()=>fs.mkdtempSync(path.join(os.tmpdir(),'codex-owner-test-'));
test('cross-process native ownership cannot be stolen by age and recovers after owner exit',async()=>{
  const root=home(),options={id:'first',env:{CODEX_HOME:root,CLAUDE_HUB_DATA_DIR:root}};
  const code='const {claimThread}=require('+JSON.stringify(path.resolve(__dirname,'../core/codex-thread-ownership'))+');claimThread('+JSON.stringify(options)+',"thread",process.pid);console.log("claimed");process.stdin.resume();';
  const child=spawn(process.execPath,['-e',code],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  try{
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error(stderr)));});
    assert.throws(()=>claimThread({...options,id:'second'},'thread',process.pid),/另一个进程/);
    const different=claimThread({...options,id:'second'},'different',process.pid);releaseThread(different);
  }finally{const exit=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await exit;}
  const lease=claimThread({...options,id:'second'},'thread',process.pid);
  releaseThread({...lease,nonce:'stale-release'});
  assert.throws(()=>claimThread({...options,id:'third'},'thread',process.pid),/另一个进程/);
  releaseThread(lease);const again=claimThread(options,'thread',process.pid);releaseThread(again);
});
test('live legacy Hub ownership blocks resume; missing native identity is protected by Hub id',async()=>{
  const root=home(),dir=path.join(root,'control');fs.mkdirSync(dir);
  const child=spawn(process.execPath,['-e','process.stdin.resume()'],{windowsHide:true,stdio:['pipe','ignore','ignore']});
  const options={id:'same-card',env:{CODEX_HOME:root,CLAUDE_HUB_DATA_DIR:root}};
  try{
    fs.writeFileSync(path.join(dir,child.pid+'.json'),JSON.stringify({pid:child.pid,cdpPort:1}));
    await assert.rejects(assertNoOtherHubOwner(options,'thread',async()=>[{id:'old',kind:'codex',codexSid:'thread'}]),/原 Hub 仍持有/);
    await assert.rejects(assertNoOtherHubOwner(options,'thread',async()=>[{id:'same-card',kind:'codex'}]),/原 Hub 仍持有/);
    await assertNoOtherHubOwner(options,'thread',async()=>[{id:'unrelated',kind:'codex',codexSid:'different'}]);
    const claudeOptions={...options,nativeProvider:'claude',env:{...options.env,CLAUDE_CONFIG_DIR:root}};
    await assert.rejects(assertNoOtherHubOwner(claudeOptions,'cc-thread',async()=>[{id:'old-claude',kind:'claude',ccSessionId:'cc-thread'}]),/原 Hub 仍持有/);
    await assertNoOtherHubOwner(claudeOptions,'cc-thread',async()=>[{id:'codex-only',kind:'codex',codexSid:'cc-thread'}]);
    await assert.rejects(assertNoOtherHubOwner(options,'thread',async()=>{throw Error('unreachable');}),/unreachable/);
  }finally{const exit=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await exit;}
  await assertNoOtherHubOwner(options,'thread',async()=>{throw Error('dead process must not be contacted');});
});
