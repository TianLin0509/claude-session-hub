'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {backstageStatus}=require('../core/native-backstage-status');
const model=(backend,state,patch={})=>({runtimeBackend:backend,nativeRuntime:{connection:'connected',state,startedAt:1000,observedAt:2000,...patch}});
for(const backend of ['codex-app-server','claude-stream-json']) {
  test(backend+' distinguishes acknowledged silence, running, stopping and terminal states',()=>{
    const starting=backstageStatus(model(backend,'starting',{submission:{sendStatus:'accepted'}}),5000);
    assert.match(starting.title,/已收到/);assert.equal(starting.animated,true);assert.equal(starting.elapsed,'3s');
    const running=backstageStatus(model(backend,'running'),65000);
    assert.equal(running.state,'running');assert.equal(running.elapsed,'1m 4s');assert.equal(running.animated,true);
    // Even hours without text cannot invent a completion/disconnection.
    assert.equal(backstageStatus(model(backend,'running'),3600000).state,'running');
    assert.equal(backstageStatus(model(backend,'running',{cancellation:{status:'pending'}})).state,'stopping');
    for(const state of ['waiting','completed','interrupted','failed','idle','unknown'])assert.equal(backstageStatus(model(backend,state)).animated,false,state);
  });
  test(backend+' never animates old running state after disconnect, unknown receipt or closure',()=>{
    for(const patch of [{connection:'disconnected'},{submission:{status:'unknown'}},{cancellation:{status:'unknown'}}]){
      const status=backstageStatus(model(backend,'running',patch));assert.equal(status.state,'unknown');assert.equal(status.animated,false);
    }
    const closed=backstageStatus({...model(backend,'running'),status:'dormant'});
    assert.equal(closed.state,'dormant');assert.equal(closed.animated,false);
  });
}
test('a new unconfirmed submission replaces the prior completed label without claiming receipt',()=>{
  const status=backstageStatus(model('codex-app-server','completed',{submission:{status:'submitting',submittedAt:3000}}),9000);
  assert.equal(status.state,'starting');assert.equal(status.title,'正在发送');assert.equal(status.elapsed,'6s');
});
test('a rejected new submission is visible over an old completed turn, without stopping an active turn',()=>{
  const rejected={submission:{status:'rejected',error:'not accepted'}};
  assert.equal(backstageStatus(model('codex-app-server','completed',rejected)).state,'failed');
  assert.equal(backstageStatus(model('codex-app-server','running',rejected)).state,'running');
});

test('Claude waiting elapsed time survives native status refreshes',async()=>{
  const {ClaudeNativeSession}=require('../core/claude-native-session');
  const driver=new ClaudeNativeSession({executable:process.execPath,
    commandArgs:[require('node:path').join(__dirname,'fixtures/claude-stream.js'),'--fixture=hold']});
  try {
    await driver.submit('silent');
    const before=driver.runtime;
    assert.equal(before.state,'starting');
    assert.ok(before.submission.submittedAt>0);
    const now=before.submission.submittedAt+10000;
    driver.update({actualModel:'model-confirmed'});
    const after={...driver.runtime,observedAt:now-1000};
    assert.equal(backstageStatus({runtimeBackend:'claude-stream-json',nativeRuntime:after},now).elapsed,'10s');
  } finally {await driver.close();}
});
