'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const p=require('../core/claude-subscription-profiles');
const usage=require('../core/claude-usage-scope');
const {selectClaudeStatuslineUsage}=require('../main/usage/claude-statusline-usage');
const {LaunchAuth}=require('../core/launch-auth');
function setup(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-claude-accounts-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={USERPROFILE:home,HOME:home,CLAUDE_HUB_HOME_DIR:home};
  const config={claudeSubscriptionProfile:'second',claudeSubscriptionProfiles:p.normalizeProfiles([],home)};
  return {home,env,config};
}

test('default identity ignores obsolete nested account, including when canonical identity is missing', t=>{
  const {home}=setup(t),dir=path.join(home,'.claude');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'obsolete@example.com'}}));
  fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'current@example.com'}}));
  assert.equal(p.accountLabel(dir),'current@example.com');
  fs.unlinkSync(path.join(home,'.claude.json'));
  assert.equal(p.accountLabel(dir),'');
});
test('new sessions follow selection; persisted and legacy histories retain their account',t=>{
  const {config,env,home}=setup(t);
  assert.equal(p.profileForSession({},config,env).id,'second');
  const chosen=p.profileForSession({claudeProfile:'second'},config,env);
  config.claudeSubscriptionProfile='default';
  assert.equal(p.profileForSession({claudeProfile:'second',claudeConfigDir:chosen.home,useResume:true},config,env).id,'second');
  config.claudeSubscriptionProfile='second';
  assert.equal(p.profileForSession({resumeCCSessionId:'old'},config,env).id,'default');
  assert.equal(p.resolveProfile(config,'default',env).home,path.join(home,'.claude'));
  assert.equal(p.resolveProfile(config,'default',env).configDir,'');
  assert.equal(p.profileForSession({resumeCCSessionId:'old',resumeTranscriptPath:path.join(chosen.home,'projects','project','old.jsonl')},config,env).id,'second');
  assert.throws(()=>p.profileForSession({claudeProfile:'missing'},config,env),/不存在/);
  assert.throws(()=>p.profileForSession({claudeProfile:'second',claudeConfigDir:path.join(home,'old')},config,env),/已改变/);
});
test('overlapping and out-of-isolation login directories fail instead of silently switching',t=>{
  const {config,env,home}=setup(t);
  config.claudeSubscriptionProfiles[1].home=path.join(home,'.claude');
  assert.throws(()=>p.resolveProfile(config,'second',env),/共用/);
  config.claudeSubscriptionProfiles[1].home=path.join(home,'..','real-account');
  assert.throws(()=>p.resolveProfile(config,'second',env),/隔离/);
});
test('quota windows and old unscoped cache cannot leak from A to B',t=>{
  const {config,env}=setup(t),a=usage.scope(config,'default',env),b=usage.scope(config,'second',env);
  const cache={A:{claudeScope:a,ts:10,usage5h:{pct:91},usage7d:{pct:80}},B:{claudeScope:b,ts:20,usage5h:{pct:2}}};
  const selected=selectClaudeStatuslineUsage(usage.selectStatusline(cache,b));
  assert.equal(selected.usage5h.pct,2);assert.equal(selected.usage7d,null);
  assert.equal(usage.cached({claude:{usage5h:{pct:99}}},b).usage5h,null);
  assert.notEqual(a,b);
});
test('account identity change invalidates scoped quota without reading token contents',t=>{
  const {config,env}=setup(t),home=p.resolveProfile(config,'second',env).home;
  fs.mkdirSync(home,{recursive:true});
  fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'one@example.com'}}));
  const before=usage.scope(config,'second',env);
  fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'two@example.com'}}));
  assert.notEqual(before,usage.scope(config,'second',env));
});
test('login checks address the chosen Claude connection',()=>{
  const auth=new LaunchAuth({getConfig:()=>({claudeSubscriptionProfile:'second'}),accounts:{}});
  assert.equal(auth.connection('claude',{}),'claude-second');
  assert.equal(auth.connection('claude-resume',{claudeProfile:'default'}),'claude');
});
test('all Claude fork entrances preserve the originating account',t=>{
  const {config,env,home}=setup(t);
  const source={id:'hub-b',kind:'claude',ccSessionId:'11111111-1111-4111-8111-111111111111',cwd:home,
    claudeProfile:'second',claudeConfigDir:p.resolveProfile(config,'second',env).home};
  const plan=require('../core/session-fork-plan').planSessionFork({source,siblingPool:[],runtimeKind:'claude'});
  assert.equal(plan.opts.claudeProfile,'second');
  assert.equal(p.profileForSession(plan.opts,{...config,claudeSubscriptionProfile:'default'},env).id,'second');
});
test('both accounts inherit only the established network policy, never primary credentials',t=>{
  const {config,env,home}=setup(t),dir=path.join(home,'.claude');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({env:{HTTPS_PROXY:'http://127.0.0.1:17891',ANTHROPIC_AUTH_TOKEN:'do-not-copy',OTHER:'private'}}));
  const target={};p.applyNetworkEnv(target,config,env);
  assert.deepEqual(target,{HTTPS_PROXY:'http://127.0.0.1:17891'});
});
