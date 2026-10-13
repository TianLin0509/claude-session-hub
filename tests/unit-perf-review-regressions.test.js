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
