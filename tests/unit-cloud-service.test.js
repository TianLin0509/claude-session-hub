'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CloudService } = require('../core/cloud/service');
const registry = require('../core/cloud/catalog.json');

const sample = () => ({ collectedAt: new Date().toISOString(), sampleSeconds: 4, cores: 2,
  host: { cpuPct: 7, memoryTotalBytes: 2048000000, memoryFreeBytes: 256000000, diskTotalBytes: 40000000000, diskFreeBytes: 6000000000, uptimeSeconds: 1200, os: 'Windows Server 2022' },
  services: registry.services.filter(s=>s.backend).map(s=>({id:s.id,port:s.port,running:true,stable:true,processCount:1,cpuPct:0,workingSetBytes:32000000})) });
function fixture(t, request, opts={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cloud-unit-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return new CloudService({dataDir:dir,enabled:true,request,certificates:async()=>[],...opts});
}
test('disabled edition never reads cloud state or invokes the transport',async t=>{
  let calls=0;const s=fixture(t,async()=>{calls++;return sample();},{enabled:false});
  assert.deepEqual(s.getState(),{enabled:false});
  await assert.rejects(s.refresh(),/cloud_disabled/);assert.equal(calls,0);
});
test('refresh requests are coalesced; a failed refresh retains the successful snapshot',async t=>{
  let calls=0,release; const s=fixture(t,async()=>{calls++;if(calls===1)return await new Promise(r=>release=r);throw new Error('ssh_failed');});
  const a=s.refresh(), b=s.refresh();await Promise.resolve();release(sample());await Promise.all([a,b]);
  assert.equal(calls,1);const at=s.getState().snapshot.collectedAt;
  await s.refresh();assert.equal(s.getState().snapshot.collectedAt,at);assert.ok(s.getState().error);
  assert.equal(s.getState().catalog.length,23);assert.equal(s.getState().catalog.filter(x=>!x.backend).length,10);
});
test('malformed metrics cannot replace a known-good snapshot',async t=>{
  let next=sample(); const s=fixture(t,async()=>next);
  await s.refresh();const good=s.getState().snapshot;
  for(const mutate of [s=>s.services=[],s=>s.services.pop(),s=>s.services[1]=s.services[0],s=>s.cores=0,s=>s.sampleSeconds=NaN,s=>s.services[0].cpuPct=-1,s=>s.services[0].workingSetBytes=-1,s=>s.services[0].processCount=0,s=>s.services[0].port=1,s=>s.host.memoryFreeBytes=Number.MAX_SAFE_INTEGER]){
    next=sample();mutate(next);await s.refresh();assert.deepEqual(s.getState().snapshot,good);assert.equal(s.getState().error.code,'cloud_invalid_response');
  }
  next=sample();Object.assign(next.services[0],{running:false,processCount:0,cpuPct:null,workingSetBytes:null});await s.refresh();assert.equal(s.getState().error,null);
});

test('synchronous transport failures cannot leave refresh or scan permanently busy',async t=>{
  let calls=0;const s=fixture(t,()=>{calls++;throw new Error('ssh_failed');});
  await s.refresh();await s.refresh();assert.equal(calls,2);assert.equal(s.getState().refreshing,false);
  await s.planOptimization();await s.planOptimization();assert.equal(calls,4);assert.equal(s.getState().optimization.phase,'error');
});

test('private entry is resolved only when opened and never appears in the renderer state or cache',async t=>{
  let url='https://me.lt-stockpartner.tech/drop/test_only_secret/';const opened=[];
  const s=fixture(t,async()=>({url}));await s.openService('company-drop',async u=>opened.push(u));
  assert.equal(opened.length,1);assert.ok(!JSON.stringify(s.getState()).includes('test_only_secret'));
  for(url of ['https://evil.example/drop/a/','https://me.lt-stockpartner.tech/drop/a/?key=b','https://user:pass@me.lt-stockpartner.tech/drop/a/','http://me.lt-stockpartner.tech/drop/a/'])await assert.rejects(s.openService('company-drop',async u=>opened.push(u)),/invalid_private_entry/);
  assert.equal(opened.length,1);await assert.rejects(s.openService('https://evil.example',()=>{}),/unknown_service/);
});
test('refresh preference accepts only manual, 5 or 15 minutes',t=>{
  const s=fixture(t,async()=>sample());assert.equal(s.getState().settings.refreshMinutes,5);
  assert.equal(s.setSettings({refreshMinutes:0}).settings.refreshMinutes,0);
  assert.throws(()=>s.setSettings({refreshMinutes:1}),/invalid_refresh_interval/);
});
test('optimization uses a main-owned expiring plan, never renderer paths, and retries only failed groups',async t=>{
  const seen=[];let clock=1000000,logFails=true;
  const s=fixture(t,async(op,payload)=>{seen.push({op,payload});if(op==='metrics')return sample();
    if(op==='plan')return {items:[{id:'file1',group:'temp',path:'C:\\Windows\\Temp\\old.tmp',bytes:10,modifiedTicks:'639028224000000000'},{id:'file2',group:'logs',path:'C:\\TeamWeekly\\logs\\app.log.1',bytes:20,modifiedTicks:'639028224000000000'}],warnings:[]};
    return {results:payload.items.map(i=>({id:i.id,status:i.group==='logs'&&logFails?'failed':'done',releasedBytes:i.group==='temp'?10:5,message:i.group==='logs'&&logFails?'file_busy':'ok'}))};
  },{now:()=>clock});
  await s.planOptimization();const id=s.getState().optimization.plan.id;
  await assert.rejects(s.runOptimization({planId:'forged',groups:['temp']}),/stale_plan/);
  await s.runOptimization({planId:id,groups:['temp','logs'],items:[{path:'C:\\business.db'}]});
  assert.equal(s.getState().optimization.releasedBytes,10);
  logFails=false;await s.runOptimization({planId:id,groups:['temp','logs']});
  assert.equal(s.getState().optimization.releasedBytes,15);
  assert.deepEqual(s.getState().history.map(entry=>entry.releasedBytes),[10,5]);
  assert.deepEqual(s.getState().history[1].groups.map(group=>group.id),['logs']);
  assert.equal(seen.filter(x=>x.op==='execute'&&x.payload.items.some(i=>i.group==='temp')).length,1);
  assert.ok(!JSON.stringify(seen).includes('business.db'));
  clock+=600001;await assert.rejects(s.runOptimization({planId:id,groups:['temp']}),/stale_plan/);
});
