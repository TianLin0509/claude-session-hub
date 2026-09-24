'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {resolveAccount,withGlobalAccount,prepareLaunch}=require('../core/codex-global-account');
const {CodexNativeSession}=require('../core/codex-native-session');
function setup(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'global-account-'));
 const a=path.join(root,'a'),b=path.join(root,'b');for(const p of [a,b])fs.mkdirSync(p);
 const env={...process.env,CODEX_HOME:a,CLAUDE_HUB_DATA_DIR:path.join(root,'data'),CLAUDE_HUB_HOME_DIR:root,
  CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
  CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT:'1',CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(root,'threads'),
  CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers'),HUB_CODEX_PROFILE:''};
 const config={codexBackend:'subscription',codexSubscriptionProfile:'default',codexSubscriptionProfiles:[{id:'default',label:'A',home:a},{id:'second',label:'B',home:b}]};
 const s=new CodexNativeSession({id:'global-test',cwd:root,env,ownershipHome:a,accountId:'default',
  resolveAccount:()=>resolveAccount(config,env),threadParams:{cwd:root,model:'gpt-6-astra'},turnParams:{model:'gpt-6-astra',effort:'max'}});
 return {root,a,b,env,config,s};
}
async function until(fn){const end=Date.now()+7000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}}
async function close(s){if(s.closed && !s.entry)return;await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('close timeout')),7000);s.once('exit',()=>{clearTimeout(t);resolve();});s.kill();});}
test('another Hub account change bypasses stale routing cache and malformed config blocks routing',()=>{
 const {root,a,b}=setup(),data=path.join(root,'data');fs.mkdirSync(data);
 const before={CLAUDE_HUB_DATA_DIR:process.env.CLAUDE_HUB_DATA_DIR,HUB_CODEX_PROFILE:process.env.HUB_CODEX_PROFILE};
 const hub=require('../core/hub-config'),{currentConfig}=require('../core/codex-global-account');
 try{
  process.env.CLAUDE_HUB_DATA_DIR=data;delete process.env.HUB_CODEX_PROFILE;hub.clearConfigCache();
  const file=path.join(data,'config.json'),raw={providers:{codex:{subscription_profile:'default',subscription_profiles:[{id:'default',home:a},{id:'second',home:b}]}}};
  fs.writeFileSync(file,JSON.stringify(raw));assert.equal(hub.getConfig().codexSubscriptionProfile,'default');
  raw.providers.codex.subscription_profile='second';fs.writeFileSync(file,JSON.stringify(raw));
  assert.equal(hub.getConfig().codexSubscriptionProfile,'default');
  assert.equal(currentConfig().codexSubscriptionProfile,'second');
  fs.writeFileSync(file,'broken json');assert.throws(()=>currentConfig());
 }finally{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}hub.clearConfigCache();}
});
test('global selection preserves unrelated config, rejects unknown IDs and environment conflicts',()=>{
 const {config,env,b}=setup(),existing={custom:42,providers:{claude:{secret:'keep'},codex:{subscription_profile:'default',api_key:'keep-too'}}};
 const merged=withGlobalAccount(existing,config,'second',env);
 assert.equal(merged.providers.codex.subscription_profile,'second');assert.equal(merged.custom,42);
 assert.equal(merged.providers.claude.secret,'keep');assert.equal(existing.providers.codex.subscription_profile,'default');
 assert.throws(()=>withGlobalAccount(existing,config,'unknown',env),/不存在/);
 assert.throws(()=>withGlobalAccount(existing,config,'second',{...env,HUB_CODEX_PROFILE:'default'}),/环境变量/);
 const next={...config,codexSubscriptionProfile:'second'};
 assert.equal(prepareLaunch({codexProfile:'default'},next,env).account.home,b);
 assert.equal(prepareLaunch({codexProfile:'default'},next,env).opts.codexHistoryHome,b);
 assert.throws(()=>prepareLaunch({codexProfile:'default',codexSid:'missing'},next,env),/原始历史/);
});
test('global account migration retires old writer, retains thread/history/policy and sends once on new home',async()=>{
 const {s,config,a,b}=setup();
 try{
  await s.start();await s.send('first',{clientSubmissionId:'first'});await until(()=>s.runtime.state==='completed');
  const id=s.threadId,file=s.options.resumePath,old=s.entry.client,lease=s.ownershipLease.file;
  config.codexSubscriptionProfile='second';
  await s.send('second',{clientSubmissionId:'second'});await until(()=>s.runtime.state==='completed');
  assert.equal(s.threadId,id);assert.equal(s.options.resumePath,file);assert.equal(s.options.env.CODEX_HOME,b);
  assert.notEqual(s.entry.client,old);assert(old.proc.exitCode!==null || old.proc.signalCode!==null);
  assert.equal(s.ownershipLease.file,lease);assert(lease.startsWith(a));
  const thread=(await s.entry.client.request('thread/read',{threadId:id,includeTurns:true})).thread;
  assert.equal(thread.turns.length,2);assert(JSON.stringify(thread).includes('first'));
  await s.send('second',{clientSubmissionId:'second'});assert.equal((await s.entry.client.request('thread/read',{threadId:id})).thread.turns.length,2);
  const launch=prepareLaunch({codexProfile:'default',codexSid:id,codexSessionsRoot:path.join(a,'sessions'),resumeTranscriptPath:file},config,s.options.env);
  assert.equal(launch.opts.codexProfile,'second');assert.equal(launch.opts.codexHistoryHome,a);
 }finally{await close(s);}
});
test('active turns are not interrupted; unknown submission is not replayed during account change',async()=>{
 const {s,config,a}=setup();
 try{
  await s.start();await s.send('fixture:hold');const old=s.entry.client;
  config.codexSubscriptionProfile='second';assert.equal(await s.followGlobalAccount(),false);
  assert.equal(s.entry.client,old);assert.equal(s.options.env.CODEX_HOME,a);assert.equal(s.runtime.state,'running');
  await s.interrupt();await until(()=>s.runtime.state==='interrupted');
  s.runtime.submission={id:'unknown',status:'unknown'};
  assert.equal(await s.followGlobalAccount(),false);
  await assert.rejects(s.send('must not send'),/未发送|不明|账号已变化/);
  assert.equal(s.entry.client,old);
 }finally{await close(s);}
});
test('missing history blocks migration without replacing the thread or falling back to old quota',async()=>{
 const {s,config,a}=setup();
 try{
  await s.start();await s.send('history');await until(()=>s.runtime.state==='completed');const id=s.threadId,old=s.entry.client;s.options.resumePath=null;
  config.codexSubscriptionProfile='second';
  await assert.rejects(s.send('not sent'),/原始历史路径未知/);
  assert.equal(s.threadId,id);assert.equal(s.entry.client,old);assert.equal(s.options.env.CODEX_HOME,a);
 }finally{await close(s);}
});
test('an unsubmitted empty session changes account without inventing history or keeping the old writer home',async()=>{
 const {s,config,b}=setup();delete s.options.env.CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT;
 try{
  await s.start();const oldId=s.threadId;config.codexSubscriptionProfile='second';
  await s.send('first ever');await until(()=>s.runtime.state==='completed');
  assert.notEqual(s.threadId,oldId);assert.equal(s.options.ownershipHome,b);assert.equal(s.options.env.CODEX_HOME,b);
  assert.equal((await s.entry.client.request('thread/read',{threadId:s.threadId})).thread.turns.length,1);
 }finally{await close(s);}
});
test('rejected new-account resume cannot fall back or send a duplicate and explicit reconnect can retry',async()=>{
 const {s,config,b}=setup();const {CodexAppServerClient}=require('../main/codex-app-server-client');let fail=true;
 try{
  await s.start();await s.send('saved');await until(()=>s.runtime.state==='completed');const id=s.threadId;
  s.options.clientFactory=options=>{
   const c=new CodexAppServerClient({cwd:options.cwd,env:options.env,args:options.processArgs});
   const request=c.request.bind(c);
   c.request=(method,...args)=>method==='thread/resume' && fail ? Promise.reject(Object.assign(Error('new-account resume rejected'),{uncertain:false})) : request(method,...args);
   return c;
  };
  config.codexSubscriptionProfile='second';
  await assert.rejects(s.send('never sent'),/new-account resume rejected/);
  assert.equal(s.options.env.CODEX_HOME,b);assert.equal(s.threadId,id);assert.equal(s.runtime.connection,'disconnected');
  fail=false;await s.reconnect();assert.equal(s.threadId,id);assert.equal(s.runtime.connection,'connected');
  assert.equal((await s.entry.client.request('thread/read',{threadId:id})).thread.turns.length,1);
 }finally{await close(s);}
});
test('history identity is checked before the native resume request can touch the wrong thread',async()=>{
 const {s}=setup();
 try{
  await s.start();const wrong=s.options.resumePath;
  await assert.rejects(s.openThread('thread/resume','wrong-id'),/身份不匹配/);
  assert.equal(s.options.resumePath,wrong);assert.equal(s.runtime.connection,'connected');
 }finally{await close(s);}
});
test('simultaneous reconnect and account sync share one writer replacement',async()=>{
 const {s,config}=setup();let closes=0,starts=0;
 // Both entry points can arrive while the same startup promise is resolving.
 // Stub transport only: exercise the real account-switch concurrency boundary.
 s.ready=Promise.resolve();s.threadId='existing-thread';s.options.resumePath='known-history';
 Object.assign(s.runtime,{state:'idle',connection:'connected'});
 s.entry={refs:1,client:{close(){closes++;},async waitForExit(){}}};
 s.detach=()=>{s.entry=null;};
 s.start=async()=>{starts++;};
 config.codexSubscriptionProfile='second';
 await Promise.all([s.followGlobalAccount(),s.followGlobalAccount()]);
 assert.equal(closes,1,'one old writer retirement');assert.equal(starts,1,'one replacement writer');
});
