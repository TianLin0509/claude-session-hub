'use strict';
// Independent reviewer probes. All accounts and files are synthetic and isolated.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {AccountCenter}=require('../core/account-center');
const {LaunchAuth}=require('../core/launch-auth');

function rig(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-review-auth-codex2-'));
  const home=path.join(root,'home'),a=path.join(home,'codex-a'),b=path.join(home,'codex-b');
  fs.mkdirSync(a,{recursive:true});fs.mkdirSync(b,{recursive:true});
  const config={claudeBackend:'subscription',codexBackend:'subscription',codexSubscriptionProfile:'review',
    codexSubscriptionProfiles:[{id:'review',label:'review',home:a}]};
  const calls=[],state={value:'signed_in'};
  const adapter={imageAccounts:async()=>[],check:async row=>{calls.push(['check',row.provider,row.home]);return {state:state.value};},
    login:async row=>{calls.push(['login',row.provider,row.home]);return {pending:true};}};
  const accounts=new AccountCenter({dataDir:path.join(root,'data'),getConfig:()=>config,adapter,homeDir:home,env:{},recovery:{list:()=>[]}});
  const service=new LaunchAuth({accounts,getConfig:()=>config});
  t.after(()=>accounts.stopPump());
  return {root,home,a,b,config,calls,state,adapter,accounts,service};
}

test('a newer explicit login-required observation overrides a launch reuse',async t=>{
  const r=rig(t);await r.service.ensure('claude');
  r.state.value='login_required';await r.accounts.check('claude',{quiet:true,resume:false});
  await assert.rejects(r.service.ensure('claude'),{code:'auth_required'});
});

test('runtime expiration cannot resurrect the old signed-in disk observation',async t=>{
  const r=rig(t);await r.service.ensure('claude');
  r.state.value='login_required';await r.service.recover('claude',{},'Not logged in');
  await assert.rejects(r.service.ensure('claude'),{code:'auth_required'});
});

test('replacing native credentials in the same profile invalidates its launch observation',async t=>{
  const r=rig(t),file=path.join(r.a,'auth.json');
  const write=n=>fs.writeFileSync(file,JSON.stringify({tokens:{id_token:'review',access_token:'fake-'+n,refresh_token:'fake-'+n,account_id:n}}));
  write('A');await r.service.ensure('codex');
  write('B');r.state.value='login_required';
  await assert.rejects(r.service.ensure('codex'),{code:'auth_required'});
});

test('a check started for home A must not mark replacement home B as checked',async t=>{
  const r=rig(t);let resolveA;
  r.adapter.check=async row=>{
    r.calls.push(['check',row.provider,row.home]);
    if(row.home===r.a)return new Promise(resolve=>{resolveA=resolve;});
    return {state:'login_required'};
  };
  const first=r.service.ensure('codex');
  while(!resolveA)await new Promise(resolve=>setImmediate(resolve));
  r.config.codexSubscriptionProfiles[0].home=r.b;
  const second=r.service.ensure('codex');
  const secondResult=second.then(()=>({ok:true}),e=>({ok:false,code:e.code}));
  resolveA({state:'signed_in'});await first;
  assert.deepEqual(await secondResult,{ok:false,code:'auth_required'});
  assert.ok(r.calls.some(c=>c[0]==='check'&&c[2]===r.b));
});

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

for(const firstState of ['login_required','signed_in']){
  test('credentials changed during precheck use current proof instead of '+firstState,{timeout:5000},async t=>{
    const r=rig(t),file=path.join(r.a,'auth.json'),started=deferred(),oldProbe=deferred();
    const currentState=firstState==='login_required'?'signed_in':'login_required';
    fs.writeFileSync(file,JSON.stringify({fixture:'old'}));
    const scope=r.accounts.scopeOf('codex-review');
    r.adapter.check=async row=>{
      const credential=JSON.parse(fs.readFileSync(file,'utf8')).fixture;
      r.calls.push(['check',credential]);
      if(credential==='old'){started.resolve();return oldProbe.promise;}
      return {state:currentState};
    };
    const precheck=r.service.precheck('codex');
    await started.promise;
    fs.writeFileSync(file,JSON.stringify({fixture:'new-current-credential'}));
    const launched=r.service.ensure('codex').then(()=>({allowed:true}),error=>({allowed:false,code:error.code}));
    await new Promise(resolve=>setImmediate(resolve));
    oldProbe.resolve({state:firstState});
    await precheck;
    assert.deepEqual(await launched,currentState==='signed_in'?{allowed:true}:{allowed:false,code:'auth_required'});
    assert.ok(r.calls.some(call=>call[0]==='check'&&call[1]==='new-current-credential'));
    assert.equal(r.calls.filter(call=>call[0]==='login').length,currentState==='signed_in'?0:1);
    assert.equal(r.accounts.recentObservation('codex-review').state,currentState);
    assert.equal(r.accounts.recentObservation('codex-review').sameCredential,true);
    assert.equal(r.accounts.scopeOf('codex-review'),scope,'credential refresh must not move persistent account state');
    assert.equal(r.accounts.flights.size,0);
  });
}

test('a launch after credential replacement does not wait on an earlier launch',{timeout:5000},async t=>{
  const r=rig(t),file=path.join(r.a,'auth.json'),started=deferred(),oldProbe=deferred();
  let newProbeStarted=false;
  fs.writeFileSync(file,JSON.stringify({fixture:'old'}));
  r.adapter.check=async()=>{
    if(JSON.parse(fs.readFileSync(file,'utf8')).fixture==='old'){
      started.resolve();return oldProbe.promise;
    }
    newProbeStarted=true;return {state:'signed_in'};
  };
  const first=r.service.ensure('codex').then(()=>({allowed:true}),error=>({allowed:false,code:error.code}));
  await started.promise;
  fs.writeFileSync(file,JSON.stringify({fixture:'new-current-credential'}));
  const second=r.service.ensure('codex').then(()=>({allowed:true}),error=>({allowed:false,code:error.code}));
  await new Promise(resolve=>setImmediate(resolve));
  const startedNew=newProbeStarted;
  oldProbe.resolve({state:'login_required'});
  const results=await Promise.all([first,second]);
  assert.equal(startedNew,true,'a different credential starts its own probe while the old probe is pending');
  assert.deepEqual(results,[{allowed:true},{allowed:true}]);
  assert.equal(r.calls.filter(call=>call[0]==='login').length,0);
  assert.equal(r.service.flights.size,0);
});

for(const staleOutcome of ['signed_in','error']){
  test('a late old '+staleOutcome+' cannot replace a current login failure or clear its login window',{timeout:5000},async t=>{
    const r=rig(t),file=path.join(r.a,'auth.json'),started=deferred(),oldProbe=deferred();
    fs.writeFileSync(file,JSON.stringify({fixture:'old'}));
    // The old probe captured this admission; only valid proof for the current credentials may clear it.
    await r.accounts.login('codex-review');
    r.adapter.check=async()=>{
      if(JSON.parse(fs.readFileSync(file,'utf8')).fixture==='old'){
        started.resolve();return oldProbe.promise;
      }
      return {state:'login_required'};
    };
    const oldCheck=r.accounts.check('codex-review',{quiet:true,resume:false}).then(value=>({value}),error=>({error}));
    await started.promise;
    fs.writeFileSync(file,JSON.stringify({fixture:'new-current-credential'}));
    const currentCheck=r.accounts.check('codex-review',{quiet:true,resume:false}).then(value=>({value}),error=>({error}));
    await new Promise(resolve=>setImmediate(resolve));
    if(staleOutcome==='error')oldProbe.reject(Object.assign(new Error('fixture tool error'),{code:'ENOENT'}));
    else oldProbe.resolve({state:'signed_in'});
    const [oldResult,currentResult]=await Promise.all([oldCheck,currentCheck]);
    assert.equal(currentResult.value?.state,'login_required');
    assert.equal(oldResult.value?.state,'login_required');
    const observation=r.accounts.recentObservation('codex-review');
    assert.equal(observation.state,'login_required');
    assert.equal(observation.sameCredential,true);
    assert.equal(r.accounts.leaseActive(await r.accounts.row('codex-review')),true);
    assert.equal(r.accounts.flights.size,0);
  });
}

test('tail cleaning preserves an OSC title spanning the raw-window boundary',()=>{
  const h=require('../core/host-shell-detector');
  const raw='visible answer\n\x1b]0;'+ 'x'.repeat(40000)+'\nPS C:\\review> \x07';
  assert.equal(h.cleanTail(raw,500),h.stripAnsi(raw).slice(-500));
  assert.equal(h.detectHostShellTakeover(raw),false);
});

test('a login-looking string inside a long OSC title is not a visible login failure',()=>{
  const h=require('../core/host-shell-detector');
  const raw='visible answer\n\x1b]0;'+'x'.repeat(40000)+'Please run /login\x07';
  const monitor=h.createAuthBannerMonitor();
  assert.equal(monitor.tick(raw,123),'none');
  assert.equal(monitor.tick(raw,123),'none');
});
