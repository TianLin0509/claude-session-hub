'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountProfileUsage } = require('../main/usage/account-profile-usage');
function fixture() {
  let time=1000, identity='first'; const calls=[];
  const data={ 'default:first':{usage5h:{pct:20},usage7d:{pct:70},ts:800}, 'second:first':{usage5h:{pct:40},usage7d:{pct:60},ts:700} };
  const deps={ now:()=>time,
    claudeProfiles:()=>[{id:'default',label:'main'},{id:'second',label:'spare'}],
    claudeScope:(id='default')=>id+':'+identity, claudeCached:key=>data[key],
    refreshClaude:async scope=>{calls.push(scope);},
    codexScope:()=>({profileId:'second',profileLabel:'spare',scopeKey:'x-second',backend:'subscription'}),
    codexCached:()=>({usage5h:{pct:30},usage7d:{pct:50},observedAt:600,secret:'must not escape'}),
    codexOrder:()=>['default','second'],
    otherCodex:()=>[{profileId:'default',scopeKey:'x-main',usage5h:{pct:10},usage7d:{pct:20},observedAt:500}],
    refreshCodex:async()=>{calls.push('codex-current');}, refreshOtherCodex:async()=>{calls.push('codex-others');},
  };
  return {deps,calls,data,setTime:v=>{time=v;},setIdentity:v=>{identity=v;}};
}
test('all accounts retain both windows, stable ordering and real observation times', async()=>{
  const f=fixture(), service=createAccountProfileUsage(f.deps), rows=await service.refresh();
  assert.deepEqual(rows.claude.map(r=>r.usage5h.pct),[20,40]);
  assert.deepEqual(rows.codex.map(r=>r.profileId),['default','second']);
  assert.deepEqual(rows.codex.map(r=>r.usage7d.pct),[20,50]);
  assert.equal(rows.claude[0].lastSeen,800,'reading an old cache does not renew its age');
  assert.equal(JSON.stringify(rows).includes('must not escape'),false);
  assert.ok(f.calls.includes('second:first'));
});
test('a failed account preserves only its own stale data and does not block others', async()=>{
  const f=fixture(); f.deps.refreshClaude=async scope=>{if(scope.startsWith('second'))throw Error('offline');f.calls.push(scope);};
  const service=createAccountProfileUsage(f.deps), rows=await service.refresh();
  assert.equal(rows.claude[1].error,'offline'); assert.equal(rows.claude[1].lastSeen,700);
  assert.equal(rows.claude[0].error,''); assert.equal(rows.codex.length,2);
  f.setIdentity('new-login');
  const changed=service.list(); assert.equal(changed.claude[1].usage5h,null);assert.equal(changed.claude[1].error,'');
});
test('manual click refreshes the requested Claude account without changing the selection', async()=>{
  const f=fixture(), service=createAccountProfileUsage(f.deps);
  await service.refresh({provider:'claude',profileId:'second',force:true});
  assert.deepEqual(f.calls,['second:first']);
  assert.equal(service.list().claude[0].selected,true);
  await assert.rejects(service.refresh({provider:'claude',profileId:'missing',force:true}),/账号不存在/);
  await assert.rejects(service.refresh({provider:'__proto__'}),/不支持/);
});
test('background reads are bounded and simultaneous callers share a flight', async()=>{
  const f=fixture(),service=createAccountProfileUsage(f.deps);
  await Promise.all([service.refresh(),service.refresh()]);
  assert.equal(f.calls.filter(x=>x==='second:first').length,1);
  await service.refresh();assert.equal(f.calls.filter(x=>x==='second:first').length,1);
  f.setTime(122000);await service.refresh();assert.equal(f.calls.filter(x=>x==='second:first').length,2);
});

test('skipped or cached reads retain errors until a valid live observation', async()=>{
  const f=fixture();
  f.deps.refreshClaude=async()=>{throw Error('claude offline');};
  f.deps.refreshCodex=async()=>{throw Error('codex offline');};
  const service=createAccountProfileUsage(f.deps);
  await service.refresh({force:true});
  f.deps.refreshClaude=async()=>({source:'cache',data:f.data['default:first']});
  f.deps.refreshCodex=async()=>null;
  let rows=await service.refresh({force:true});
  assert.equal(rows.claude[0].error,'claude offline');
  assert.equal(rows.codex[1].error,'codex offline');
  f.deps.refreshClaude=async()=>({source:'claude-native',data:{usage5h:{pct:30}}});
  f.deps.refreshCodex=async()=>({usage7d:{pct:60}});
  rows=await service.refresh({force:true});
  assert.equal(rows.claude[0].error,'');assert.equal(rows.codex[1].error,'');
});

test('other profile failures do not discard successful current and Claude readings', async()=>{
  const f=fixture();f.deps.refreshOtherCodex=async()=>{throw Error('other offline');};
  const service=createAccountProfileUsage(f.deps);
  let rows=await service.refresh();
  assert.equal(rows.claude[0].usage5h.pct,20);assert.equal(rows.codex[0].error,'other offline');
  assert.equal(rows.codex[1].error,'');
  f.deps.otherCodex=()=>{throw Error('bad profile');};
  rows=service.list();assert.equal(rows.claude.length,2);assert.equal(rows.codex[0].error,'bad profile');
});

test('repeated forced clicks coalesce and queued different accounts finish', async()=>{
  const f=fixture();let release;
  f.deps.refreshClaude=scope=>{f.calls.push(scope);return new Promise(resolve=>{release=resolve;});};
  const service=createAccountProfileUsage(f.deps);
  const first=service.refresh({provider:'claude',profileId:'default',force:true});
  const same=service.refresh({provider:'claude',profileId:'default',force:true});
  assert.equal(first,same);
  const next=service.refresh({provider:'claude',profileId:'second',force:true});
  const nextSame=service.refresh({provider:'claude',profileId:'second',force:true});
  assert.equal(next,nextSame);
  release();await first;await new Promise(resolve=>setImmediate(resolve));release();await next;
  assert.deepEqual(f.calls,['default:first','second:first']);
});
