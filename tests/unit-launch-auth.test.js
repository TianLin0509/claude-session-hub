'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LaunchAuth,isLoginFailure}=require('../core/launch-auth');
function setup(state='signed_in') {
  const calls=[],notifications=[];
  const config={codexBackend:'subscription',codexSubscriptionProfile:'second',claudeBackend:'subscription'};
  const service=new LaunchAuth({getConfig:()=>config,notify:x=>notifications.push(x),accounts:{
    check:async id=>{calls.push(['check',id]);return {state};},
    login:async id=>{calls.push(['login',id]);return {pending:true};}
  }});
  return {service,config,calls,notifications};
}
test('new, resume and restart check the selected quota account rather than the historical profile',async()=>{
  const {service,calls}=setup();
  await service.ensure('codex',{codexProfile:'default'});await service.ensure('codex-resume',{codexProfile:'default'});
  assert.deepEqual(calls,[['check','codex-second'],['check','codex-second']]);
  await service.ensure('codex',{launchProfile:'default'});assert.equal(calls.at(-1)[1],'codex-default');
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
