'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {AccountCenter}=require('../core/account-center');
const {createAccountAdapters,quotePS,jsonResult}=require('../core/account-adapters');
const {registerAccountCenterIpc}=require('../main/ipc/account-center-handlers');
function setup(t,overrides={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-accounts-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const config={codexSubscriptionProfiles:[{id:'default',label:'Main',home:path.join(root,'codex')}],deepseekApiKey:'secret-key-DO-NOT-EXPOSE'};const adapter={imageAccounts:async()=>[],check:async()=>({state:'signed_in',identity:'alice@example.com',message:'原生确认',source:'fixture'}),login:async()=>({}),...overrides};const service=new AccountCenter({dataDir:root,homeDir:root,env:{},getConfig:()=>config,adapter});return {root,config,adapter,service};}
test('snapshot keeps credential presence separate from auth and never serializes secrets or homes',async t=>{const {service,root}=setup(t);const s=await service.snapshot();const api=s.connections.find(r=>r.id==='api-deepseek');assert.equal(api.state,'configured');assert.equal(s.connections.find(r=>r.id==='claude').state,'signed_in');assert.equal(s.connections.find(r=>r.id==='claude').identity,'a•••@example.com');assert.ok(!JSON.stringify(s).includes('secret-key'));assert.ok(!JSON.stringify(s).includes(root));assert.equal(s.connections.find(r=>r.id==='bridge').state,'unknown');});

test('opening a webpage coalesces and preserves both auth observation and login lease',async t=>{
 let opens=0,logins=0;const {service}=setup(t,{open:async()=>{opens++;await new Promise(r=>setTimeout(r,10));return {message:'opened'};},login:async()=>{logins++;return {};}});
 const row=await service.row('web-deepseek'),key=service.scope(row);await service.check(row.id);const before=service.read(key);
 await Promise.all([service.open(row.id),service.open(row.id)]);assert.equal(opens,1);assert.equal(logins,0);assert.equal(service.leaseActive(row),false);assert.deepEqual(service.read(key),before);
 await service.login(row.id);const token=service.leaseToken(key);await service.open(row.id);assert.equal(service.leaseToken(key),token);assert.equal(logins,1);assert.deepEqual(service.read(key),before);
 await assert.rejects(service.open('codex-default'),/没有网页/);await assert.rejects(service.open('../../secret'),/不存在/);
});
test('failed and synchronous webpage opens propagate without poisoning the next attempt',async t=>{
 let calls=0;const {service}=setup(t,{open:()=>{calls++;throw Error('private-secret');}});
 await assert.rejects(service.open('bridge'),/无法打开/);await assert.rejects(service.open('bridge'),/无法打开/);assert.equal(calls,2);assert.equal(service.openFlights.size,0);assert.ok(!JSON.stringify(service.history()).includes('private-secret'));
});
test('managed webpage open cannot request SMS, and isolated adapters reject real opens',async t=>{
 const {root}=setup(t);let opened=0;const browser={open:async provider=>{assert.equal(provider,'doubao');opened++;return {};},preparePhone:()=>assert.fail('SMS must not run')};
 const adapter=createAccountAdapters({dataDir:root,env:{},browser});await adapter.open({managedBrowser:true,provider:'doubao'});assert.equal(opened,1);
 const isolated=createAccountAdapters({dataDir:root,env:{CLAUDE_HUB_HOME_DIR:root},browser});await assert.rejects(isolated.open({managedBrowser:true,provider:'doubao'}),/隔离/);assert.equal(opened,1);
});
test('two Hub services share one login admission; explicit release permits reopen',async t=>{let count=0;const s=setup(t,{login:async()=>{count++;await new Promise(r=>setTimeout(r,15));return {};}});const second=new AccountCenter({dataDir:s.root,homeDir:s.root,env:{},getConfig:()=>s.config,adapter:s.adapter});await Promise.all([s.service.login('web-deepseek'),second.login('web-deepseek')]);assert.equal(count,1);await second.release('web-deepseek');await s.service.login('web-deepseek');assert.equal(count,2);});
test('failed login releases admission and exposes failure, not success',async t=>{let count=0;const {service}=setup(t,{login:async()=>{count++;throw Error('missing tool');}});await assert.rejects(service.login('bridge'),/无法打开/);await assert.rejects(service.login('bridge'),/无法打开/);assert.equal(count,2);});
test('same account checks coalesce and failures are unknown rather than signed out',async t=>{let count=0;const {service}=setup(t,{check:async()=>{count++;await new Promise(r=>setTimeout(r,15));throw Error('network secret');}});const r=await Promise.allSettled([service.check('bridge'),service.check('bridge')]);assert.equal(count,1);assert.equal(r[0].status,'rejected');const row=(await service.snapshot()).connections.find(r=>r.id==='bridge');assert.equal(row.state,'unknown');assert.ok(!JSON.stringify(service.history()).includes('network secret'));});
test('changing native home or API key cannot inherit a previous identity',async t=>{const {service,config,root}=setup(t);await service.check('codex-default');config.codexSubscriptionProfiles[0].home=path.join(root,'different');assert.equal(service.read(service.scope(service.baseConnections().find(r=>r.id==='codex-default'))),null);await service.check('api-deepseek');config.deepseekApiKey='another';assert.equal(service.read(service.scope(service.baseConnections().find(r=>r.id==='api-deepseek'))),null);});
test('fresh image worker proof replaces queued observation without exposing raw worker results',async t=>{let when=0;const {service}=setup(t,{imageAccounts:async()=>[{id:'primary',state:'signed_in',observedAt:when,enabled:true,workerAlive:true}],check:async()=>({state:'unknown',message:'检查排队中'})});await service.check('image-primary');when=Date.now()+100;const row=(await service.snapshot()).connections.find(r=>r.id==='image-primary');assert.equal(row.state,'signed_in');});
test('unknown connection cannot select filesystem paths or arbitrary login commands',async t=>{const {service}=setup(t);await assert.rejects(service.login('../../secret'),/连接不存在/);await assert.rejects(service.login('api-deepseek'),/接入配置/);});
test('isolated adapter never calls real bridge, image pool or Codex Web GPT',async t=>{const {root}=setup(t);let calls=0;const adapter=createAccountAdapters({dataDir:root,homeDir:root,env:{CLAUDE_HUB_HOME_DIR:root},runImpl:async()=>{calls++;return {};}});await assert.rejects(adapter.imageAccounts(),/隔离/);await assert.rejects(adapter.check({provider:'bridge'}),/隔离/);await assert.rejects(adapter.login({provider:'chatgpt-web'}),/隔离/);assert.equal(calls,0);});
test('Claude official auth JSON is necessary for a positive status',async t=>{const {root}=setup(t);let args;const adapter=createAccountAdapters({dataDir:root,homeDir:root,env:{},runImpl:async(c,a)=>{args=a;return {code:0,stdout:'{"loggedIn":true,"email":"a@example.com"}',stderr:''};}});const result=await adapter.check({provider:'claude',home:root});assert.equal(result.state,'signed_in');assert.deepEqual(args,['auth','status','--json']);const bad=createAccountAdapters({dataDir:root,env:{},runImpl:async()=>({code:0,stdout:'{}'})});await assert.rejects(bad.check({provider:'claude',home:root}),/证据/);});
test('PowerShell literals preserve hostile profile characters and JSON errors propagate',()=>{assert.equal(quotePS("a'$(whoami)"),"'a''$(whoami)'");assert.throws(()=>jsonResult({code:1,stdout:'{"ok":false}'}));assert.deepEqual(jsonResult({code:0,stdout:'noise\n{"ok":true}'}),{ok:true});});
test('IPC converts errors to visible envelopes and validates ids',async()=>{const handlers={};registerAccountCenterIpc({handle:(n,f)=>handlers[n]=f},{snapshot:async()=>({connections:[]}),login:async()=>{throw Error('不可用');}});assert.equal((await handlers['accounts:login']({},{})).ok,false);assert.equal((await handlers['accounts:login']({},{id:'claude'})).error,'不可用');assert.equal((await handlers['accounts:snapshot']({})).ok,true);});
test('an older failing launch cannot release the newer login admission',async t=>{let rejectOld,count=0;const {service}=setup(t,{login:()=>++count===1?new Promise((_,reject)=>{rejectOld=reject;}):Promise.resolve({})});const old=service.login('bridge');while(!rejectOld)await new Promise(r=>setImmediate(r));const failed=assert.rejects(old,/无法打开/);await service.release('bridge');await service.login('bridge');rejectOld(Error('old failure'));await failed;await service.login('bridge');assert.equal(count,2);});
test('server token edits invalidate cached configuration and tilde profiles resolve correctly',async t=>{const {service,config,root}=setup(t);config.operations={aliyunMonitor:{bearerToken:'old'}};await service.check('server-monitor');config.operations.aliyunMonitor.bearerToken='new';assert.equal(service.read(service.scope(service.baseConnections().find(r=>r.id==='server-monitor'))),null);config.codexSubscriptionProfiles[0].home='~/.codex-other';assert.equal(service.baseConnections().find(r=>r.id==='codex-default').home,path.join(root,'.codex-other'));});
test('Feishu user login cannot stand in for the notification bot identity',async t=>{const {root}=setup(t);let args,command;const a=createAccountAdapters({dataDir:root,env:{},getConfig:()=>({notifications:{feishuCliPath:'fixture-cli'}}),runImpl:async(c,v)=>{command=c;args=v;return {code:0,stdout:JSON.stringify({identities:{bot:{available:true},user:{available:false}}})};}});const result=await a.check({provider:'feishu'});assert.equal(result.state,'login_required');assert.match(result.message,/独立机器人身份：已配置/);assert.equal(command,'fixture-cli');assert.deepEqual(args,['auth','status','--json']);});
test('batch validates all ids before launching and skips verified accounts',async t=>{
 let launched=[];const {service}=setup(t,{check:async row=>({state:row.id==='claude'?'signed_in':'unknown'}),login:async row=>{launched.push(row.id);return {stage:'manual',message:'official window'};}});
 await assert.rejects(service.loginMany(['web-doubao','api-deepseek']),/无效/);assert.equal(launched.length,0);
 const b=await service.loginMany(['claude','web-doubao','web-doubao']);while(service.batches.get(b.id).running)await new Promise(r=>setImmediate(r));
 assert.deepEqual(launched,['web-doubao']);assert.equal(service.batches.get(b.id).items[0].stage,'signed_in');
});
test('batch limits concurrency, isolates failures, and never stores the phone',async t=>{
 let active=0,max=0;const phone='13800000000';const {service,root}=setup(t,{check:async()=>({state:'login_required'}),login:async row=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;if(row.id==='web-qwen')throw Error('failed');return {stage:'waiting_code',message:'waiting'};}});
 const b=await service.loginMany(['web-deepseek','web-doubao','web-kimi','web-qwen','web-gemini'],{phone});while(service.batches.get(b.id).running)await new Promise(r=>setTimeout(r,5));
 assert.equal(max,3);assert.equal(service.batches.get(b.id).items.filter(r=>r.stage==='failed').length,1);assert.ok(!JSON.stringify(await service.snapshot()).includes(phone));assert.ok(!fs.readFileSync(path.join(root,'account-center','events.jsonl'),'utf8').includes(phone));
});
test('verification code targets one phone-capable account and is not persisted',async t=>{
 let received;const {service,root}=setup(t,{submitCode:async(row,code)=>{received={id:row.id,code};return {stage:'checking',message:'submitted'};}});
 await assert.rejects(service.submitCode('claude','123456'),/官方窗口/);await service.submitCode('web-doubao','123456');assert.deepEqual(received,{id:'web-doubao',code:'123456'});assert.ok(!JSON.stringify(await service.snapshot()).includes('123456'));
});
test('SMS automation never retries an uncertain mutation',async t=>{
 const {root}=setup(t);let attempts=0;const a=createAccountAdapters({dataDir:root,env:{},browser:{open:async()=>({}),command:async()=>true,preparePhone:async()=>{attempts++;throw Error('disconnected after click');}}});
 const r=await a.login({provider:'doubao',managedBrowser:true,phoneLogin:true},{phone:'13800000000'});assert.equal(attempts,1);assert.equal(r.stage,'manual');
});
test('official phone form yields to CAPTCHA and submits each SMS request only once',()=>{
 const {phoneStep}=require('../core/account-browser'),vm=require('vm');let clicks=0,challenge=false;
 class Input {get value(){return this.current||'';}set value(v){this.current=v;}getClientRects(){return [1];}dispatchEvent(){}}
 const input=new Input();input.placeholder='Phone number';input.dataset={};
 const button={innerText:'Send code',getClientRects:()=>[1],getAttribute:()=>null,click:()=>clicks++};
 const document={querySelector:()=>challenge?{}:null,querySelectorAll:s=>s==='input'?[input]:[button]};
 const run=()=>vm.runInNewContext(`(${phoneStep.toString()})('deepseek','13800000000')`,{document,HTMLInputElement:Input,Event:class{}});
 challenge=true;assert.equal(run().stage,'manual');assert.equal(clicks,0);assert.equal(input.value,'');
 challenge=false;assert.equal(run().stage,'advance');assert.equal(input.value,'13800000000');assert.equal(clicks,0);
 run();assert.equal(clicks,1);run();assert.equal(clicks,1);
});
test('browser checks require provider-page evidence and never infer login from a composer',async t=>{
 const {root}=setup(t),http=require('http'),{WebSocketServer}=require('ws'),{AccountBrowser}=require('../core/account-browser');
 let result={host:'chat.deepseek.com',login:false,profile:false,challenge:false};
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{type:'page',url:'https://chat.deepseek.com/',webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/page'}]));});
 const wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',data=>{const query=JSON.parse(data);assert.equal(query.method,'Runtime.evaluate');ws.send(JSON.stringify({id:query.id,result:{result:{value:result}}}));}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
 const browser=new AccountBrowser({dataDir:root});fs.mkdirSync(browser.profile('deepseek'),{recursive:true});fs.writeFileSync(path.join(browser.profile('deepseek'),'DevToolsActivePort'),String(server.address().port));
 assert.equal((await browser.check('deepseek')).state,'unknown');result.profile=true;assert.equal((await browser.check('deepseek')).state,'signed_in');
 result.login=true;assert.equal((await browser.check('deepseek')).state,'login_required');result.challenge=true;assert.equal((await browser.check('deepseek')).state,'unknown');
 result.host='other.example';await assert.rejects(browser.check('deepseek'),/页面已切换/);assert.throws(()=>browser.profile('../../arbitrary'),/不支持/);
});

test('opening a running managed browser activates the existing site tab before reporting reuse',async t=>{
 const {root}=setup(t),http=require('http'),{WebSocketServer}=require('ws'),{AccountBrowser}=require('../core/account-browser');const methods=[];
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{type:'page',url:'https://chat.deepseek.com/',webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/page'}]));});
 const wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',data=>{const q=JSON.parse(data);methods.push(q.method);ws.send(JSON.stringify({id:q.id,result:q.method==='Page.bringToFront'?{}:{result:{value:{ready:true}}}}));}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
 const browser=new AccountBrowser({dataDir:root});browser.executable=()=>assert.fail('must reuse the running browser');fs.mkdirSync(browser.profile('deepseek'),{recursive:true});fs.writeFileSync(path.join(browser.profile('deepseek'),'DevToolsActivePort'),String(server.address().port));
 assert.equal((await browser.open('deepseek')).reused,true);assert.deepEqual(methods,['Page.bringToFront','Runtime.evaluate']);
});

test('managed browsers refresh on their own through the path that clears the lease and resumes tasks',async t=>{
 let checks=0,resumed=0,state='login_required';
 const {service,root}=setup(t,{check:async()=>({state,message:(checks++,'fixture'),source:'fixture'})});
 service.recovery={list:()=>[],resume:async()=>{resumed++;return {started:1,errors:[]};}};
 await service.login('web-deepseek');
 const row=await service.row('web-deepseek'),key=service.scope(row);
 assert.equal(service.leaseActive(row),true);
 await service.snapshot();
 assert.ok(checks>0,'a managed browser must not wait for a manual check');
 assert.equal(service.leaseActive(row),true,'no login evidence keeps the pending window visible');
 state='signed_in';service.save(key,{state:'login_required',message:'stale',observedAt:Date.now()-9000});
 await service.snapshot();
 assert.equal(service.leaseActive(row),false,'a finished login releases its own lease');
 assert.equal(resumed,1,'tasks waiting for that login resume without a button');
 // Background refreshes stay out of the activity log; only real user actions are recorded.
 assert.ok(!fs.readFileSync(path.join(root,'account-center','events.jsonl'),'utf8').includes('检查完成'));
});
test('refreshing everything checks each connection once, reports failures and logs one line',async t=>{
 const seen=[];const {service,root}=setup(t,{check:async row=>{seen.push(row.id);if(row.id==='bridge')throw Error('tool secret');return {state:'signed_in'};}});
 const result=await service.checkAll();
 const rows=await service.connections();
 assert.deepEqual(seen.sort(),rows.map(r=>r.id).sort());
 assert.equal(result.failed,1);assert.equal(result.checked,rows.length-1);
 const log=fs.readFileSync(path.join(root,'account-center','events.jsonl'),'utf8').trim().split('\n');
 assert.equal(log.length,1);assert.match(JSON.parse(log[0]).message,/未确认/);
 assert.ok(!log.join('').includes('tool secret'));
});

test('an open login window keeps that one connection polled until the tool reports a login',async t=>{
 let checks=0,state='unknown';
 const {service}=setup(t,{check:async row=>{if(row.id==='bridge')checks++;return {state:row.id==='bridge'?state:'unknown'};}});
 await service.snapshot();
 assert.equal(checks,0,'a helper-process tool is not probed on every poll');
 await service.login('bridge');
 await service.snapshot();
 assert.equal(checks,1,'while its login window is open the page confirms by itself');
 state='signed_in';
 service.save(service.scope(await service.row('bridge')),{state:'unknown',observedAt:Date.now()-9000});
 const row=(await service.snapshot()).connections.find(r=>r.id==='bridge');
 assert.equal(checks,2);assert.equal(row.state,'signed_in');assert.equal(row.pending,false);
 await service.snapshot();
 assert.equal(checks,2,'a confirmed login drops back out of the polling set');
});
test('an image account proved by its own pool listing stops waiting, without re-queuing checks',async t=>{
 let state='unknown',queued=0;
 const {service}=setup(t,{imageAccounts:async()=>[{id:'primary',loginGroup:'primary',enabled:true,state,observedAt:Date.now()}],
  check:async row=>{if(row.provider==='images')queued++;return {state:'unknown',message:'排队中'};}});
 await service.login('image-primary');
 assert.equal((await service.snapshot()).connections.find(r=>r.id==='image-primary').pending,true);
 assert.equal(queued,0,'the shared image queue is never polled behind the user’s back');
 state='signed_in';
 const row=(await service.snapshot()).connections.find(r=>r.id==='image-primary');
 assert.equal(row.state,'signed_in');assert.equal(row.pending,false);
 assert.equal(service.leaseActive(await service.row('image-primary')),false);
});

test('a background status poll never restarts web tasks on its own',async t=>{
 let resumed=0;
 const {service}=setup(t,{check:async()=>({state:'signed_in'})});
 service.recovery={list:()=>[],resume:async()=>{resumed++;return {started:1,errors:[]};}};
 await service.snapshot();
 assert.equal(resumed,0,'without a login the Hub opened, nobody asked it to continue anything');
 await service.check('web-deepseek');
 assert.equal(resumed,1,'the explicit continue-tasks action still resumes');
});

test('an abandoned login admission expires instead of pinning the row to "window open" forever',async t=>{
 // The reported bug: clicked 登录, nobody watched, the row claimed a login window was
 // open for the rest of the day and could never reach 已登录.
 const {service}=setup(t,{check:async()=>({state:'unknown'})});
 await service.login('web-deepseek');
 const row=await service.row('web-deepseek'),file=service.file(service.scope(row),'login');
 assert.equal((await service.snapshot()).connections.find(r=>r.id==='web-deepseek').pending,true);
 const held=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.writeFileSync(file,JSON.stringify({...held,at:Date.now()-11*60*1000}));
 assert.equal(service.leaseActive(row),false,'an admission older than the TTL is not a live window');
 assert.equal(fs.existsSync(file),false,'and it cleans itself up, so login can be retried');
 assert.equal((await service.snapshot()).connections.find(r=>r.id==='web-deepseek').pending,false);
 assert.equal((await service.login('web-deepseek')).pending,true);
});
test('the last confirmed login survives a later offline check so a closed browser is not "signed out"',async t=>{
 let state='signed_in';
 const {service}=setup(t,{check:async()=>({state})});
 await service.check('web-deepseek');
 const proof=(await service.snapshot()).connections.find(r=>r.id==='web-deepseek');
 assert.equal(proof.state,'signed_in');assert.ok(proof.signedInAt>0);
 state='offline';
 await service.check('web-deepseek');
 const closed=(await service.snapshot()).connections.find(r=>r.id==='web-deepseek');
 assert.equal(closed.state,'offline','the current reading is still reported honestly');
 assert.equal(closed.signedInAt,proof.signedInAt,'but the proof we did have is not thrown away');
 // A connection that was never proved must not inherit one.
 assert.equal((await service.snapshot()).connections.find(r=>r.id==='bridge').signedInAt,0);
});
test('an open login window keeps being confirmed even when no page is watching',async t=>{
 let state='unknown';
 const {service}=setup(t,{check:async()=>({state})});
 t.after(()=>service.stopPump());
 await service.login('web-deepseek');
 assert.ok(service.pumpTimer,'the Hub itself keeps the promise of 自动确认');
 state='signed_in';
 await service.snapshot();
 assert.equal(service.leaseActive(await service.row('web-deepseek')),false);
 await service.snapshot();
 assert.equal(service.pumpTimer,null,'and it stops once nothing is pending');
});

test('reading an admission that another Hub is still writing neither throws nor steals it',async t=>{
 const {service}=setup(t);
 const row=await service.row('bridge'),file=service.file(service.scope(row),'login');
 fs.mkdirSync(service.root,{recursive:true});
 fs.writeFileSync(file,'');                       // created, not yet written
 assert.equal(service.leaseActive(row),true,'an unreadable admission is still an admission');
 assert.equal(fs.existsSync(file),true,'and must not be deleted out from under its owner');
 assert.equal((await service.snapshot()).connections.find(r=>r.id==='bridge').pending,true);
 fs.writeFileSync(file,JSON.stringify({at:Date.now(),pid:process.pid,token:'t'}));
 assert.equal(service.leaseActive(row),true);
});
