'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LaunchAuth,isLoginFailure,SIGNED_IN_REUSE_MS,INCONCLUSIVE_REUSE_MS}=require('../core/launch-auth');
// A fake account center that keeps observations the way the real one does: a check stores
// its answer (a failed check stores "unknown"), a runtime report stores "login required".
function setup(state='signed_in',{recent=null}={}) {
  const calls=[],notifications=[],clock={t:1_000_000},stored=new Map(),scope={of:id=>id},credential={value:'c1'};
  const config={codexBackend:'subscription',codexSubscriptionProfile:'second',claudeBackend:'subscription'};
  const keep=(id,value)=>stored.set(scope.of(id),{...value,observedAt:clock.t,credential:credential.value});
  const accounts={
    check:async id=>{calls.push(['check',id]);
      try{const value={state:typeof state==='function'?state():state};keep(id,value);return value;}
      catch(error){keep(id,{state:'unknown'});throw error;}},
    login:async id=>{calls.push(['login',id]);return {pending:true};},
    scopeOf:id=>scope.of(id),
    recentObservation:id=>{if(recent)return recent(id,clock.t);const seen=stored.get(scope.of(id));return seen?{...seen,sameCredential:seen.credential===credential.value}:null;},
    markLoginRequired:id=>keep(id,{state:'login_required'}),
  };
  const service=new LaunchAuth({getConfig:()=>config,notify:x=>notifications.push(x),now:()=>clock.t,accounts});
  return {service,config,calls,notifications,clock,scope,credential,accounts};
}
test('new, resume and restart check the selected quota account rather than the historical profile',async()=>{
  const {service,calls}=setup();
  await service.ensure('codex',{codexProfile:'default'});await service.ensure('codex-resume',{codexProfile:'default'});
  // The second launch on the same account reuses the login just confirmed.
  assert.deepEqual(calls,[['check','codex-second']]);
  await service.ensure('codex',{launchProfile:'default'});assert.equal(calls.at(-1)[1],'codex-default');
});
test('a confirmed login is reused for five minutes, then probed again',async()=>{
  const {service,calls,clock}=setup();
  await service.ensure('claude');await service.ensure('claude');
  clock.t+=SIGNED_IN_REUSE_MS-1;await service.ensure('claude');
  assert.equal(calls.length,1);
  clock.t+=2;await service.ensure('claude');
  assert.equal(calls.length,2);
});
test('an inconclusive probe is not repeated for a minute and never opens a login window',async()=>{
  const {service,calls,clock}=setup('unknown');
  await service.ensure('codex');await service.ensure('codex');
  assert.deepEqual(calls,[['check','codex-second']]);
  clock.t+=INCONCLUSIVE_REUSE_MS;await service.ensure('codex');
  assert.deepEqual(calls,[['check','codex-second'],['check','codex-second']]);
  const failing=setup(()=>{throw Error('timeout');});
  await failing.service.ensure('claude');await failing.service.ensure('claude');
  assert.equal(failing.calls.length,1);
});
test('a fresh stored observation answers without probing; a stale, negative or other-credential one does not',async()=>{
  const fresh=setup('login_required',{recent:(id,now)=>({state:'signed_in',observedAt:now-60_000,sameCredential:true})});
  await fresh.service.ensure('claude');assert.equal(fresh.calls.length,0);
  const stale=setup('signed_in',{recent:(id,now)=>({state:'signed_in',observedAt:now-SIGNED_IN_REUSE_MS-1,sameCredential:true})});
  await stale.service.ensure('claude');assert.deepEqual(stale.calls,[['check','claude']]);
  const negative=setup('login_required',{recent:(id,now)=>({state:'login_required',observedAt:now})});
  await assert.rejects(negative.service.ensure('claude'),{code:'auth_required'});
  assert.deepEqual(negative.calls,[['check','claude'],['login','claude']]);
  const replaced=setup('signed_in',{recent:(id,now)=>({state:'signed_in',observedAt:now,sameCredential:false})});
  await replaced.service.ensure('claude');assert.deepEqual(replaced.calls,[['check','claude']]);
});
test('a newer login-required answer wins over the reused login, and a later login clears it',async()=>{
  let state='signed_in';
  const {service,calls}=setup(()=>state);
  await service.ensure('codex');assert.equal(calls.length,1);
  await service.recover('codex',{codexProfile:'second'},'Not logged in');
  state='login_required';
  await assert.rejects(service.ensure('codex'),{code:'auth_required'});
  assert.deepEqual(calls.map(c=>c[0]),['check','login','check','login']);
  state='signed_in';await service.ensure('codex');await service.ensure('codex');
  assert.deepEqual(calls.map(c=>c[0]),['check','login','check','login','check']);
});
test('a missing login is never reused: every launch asks again',async()=>{
  const {service,calls}=setup('login_required');
  await assert.rejects(service.ensure('claude'),{code:'auth_required'});
  await assert.rejects(service.ensure('claude'),{code:'auth_required'});
  assert.equal(calls.filter(c=>c[0]==='check').length,2);
});
test('explicit missing login opens one official window and prevents duplicate launches',async()=>{
  const {service,calls,notifications}=setup('login_required');
  const results=await Promise.allSettled([service.ensure('codex'),service.ensure('codex')]);
  assert(results.every(r=>r.status==='rejected'&&r.reason.code==='auth_required'));
  assert.deepEqual(calls,[['check','codex-second'],['login','codex-second']]);assert.equal(notifications.length,1);
});
test('all four native CLIs route missing login to their own connection',async()=>{
  const {service,calls}=setup('login_required');
  for(const kind of ['claude','codex','gemini','kimi'])await assert.rejects(service.ensure(kind),/官方登录/);
  assert.deepEqual(calls.filter(c=>c[0]==='login').map(c=>c[1]),['claude','codex-second','gemini-cli','kimi']);
});
test('unknown, offline, configured and transient checks never open login windows',async()=>{
  for(const state of ['unknown','offline','configured']){const {service,calls}=setup(state);await service.ensure('codex');assert.equal(calls.length,1);}
  const {service,calls}=setup();service.accounts.check=async()=>{throw Error('network timeout');};await service.ensure('codex');assert.equal(calls.length,0);
});
test('API and shell launches do not request subscription authorization',async()=>{
  const {service,config,calls}=setup('login_required');config.codexBackend='api';config.claudeBackend='api';
  for(const kind of ['powershell','codex','claude','deepseek','qwen'])await service.ensure(kind);assert.equal(calls.length,0);
});
test('confirmed runtime expiration recovers the running account, with a cooldown and no resend',async()=>{
  const {service,calls,notifications}=setup();
  await service.recover('codex',{codexProfile:'default'},'401 Unauthorized');
  await service.recover('codex',{codexProfile:'default'},'401 Unauthorized');
  assert.deepEqual(calls,[['login','codex-default']]);assert.equal(notifications.length,1);assert.match(notifications[0].message,/不会自动重发/);
  for(const message of ['403 Forbidden','request timeout','tool output: discuss not logged in errors'])assert.equal(isLoginFailure(message),false);
  assert.equal(isLoginFailure('Not logged in'),true);
});
test('a reused login belongs to one account identity and its local login files',async()=>{
  const {service,calls,scope,credential}=setup();
  scope.of=id=>id+':C:/home/a';
  await service.ensure('codex');await service.ensure('codex');assert.equal(calls.length,1);
  scope.of=id=>id+':C:/home/b';await service.ensure('codex');assert.equal(calls.length,2);
  credential.value='c2';await service.ensure('codex');assert.equal(calls.length,3);
  await service.ensure('codex');assert.equal(calls.length,3);
});
