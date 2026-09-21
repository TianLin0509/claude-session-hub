'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const store=require('../core/web-roundtable/store'),jobs=require('../core/web-roundtable/jobs'),roundtable=require('../core/web-roundtable/roundtable');
const {Client}=require('../core/web-roundtable/rpc');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hub-web-roundtable-'));
const previous=process.env.AI_HUB_WEB_DATA_DIR;process.env.AI_HUB_WEB_DATA_DIR=temporary;
test.after(()=>{if(previous===undefined)delete process.env.AI_HUB_WEB_DATA_DIR;else process.env.AI_HUB_WEB_DATA_DIR=previous;fs.rmSync(temporary,{recursive:true,force:true});});
test('concurrent requests deduplicate, differing payloads cannot silently reuse a request ID',async()=>{
  let sends=0;const input={provider:'deepseek',prompt:'test',reply_to:null};
  const results=await Promise.all(Array.from({length:12},()=>jobs.create('web','same-request',input,{launch:async()=>{sends++;await store.sleep(10);}})));
  assert.equal(sends,1);assert.equal(new Set(results.map(r=>r.id)).size,1);
  await assert.rejects(jobs.create('web','same-request',{...input,prompt:'different'}),/different arguments/);
  assert.throws(()=>store.read('../escape'),/Invalid task ID/);
});
test('provider locks never expire while owner is alive, stale owners are reclaimed',()=>{
  const release=store.acquire('browser-deepseek');assert.ok(release);assert.equal(store.acquire('browser-deepseek'),null);release();
  const dir=path.join(store.root(),'browser-deepseek.lock');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'owner.json'),JSON.stringify({pid:2147483646,token:'dead'}));
  const next=store.acquire('browser-deepseek');assert.ok(next);next();
});
test('a contender cannot read a half-published owner or steal a lock during publication',()=>{
  const dir=path.join(store.root(),'publishing.lock');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'owner.json'),'');
  assert.equal(store.acquire('publishing'),null);
  fs.writeFileSync(path.join(dir,'owner.json'),JSON.stringify({pid:process.pid,token:'live'}));assert.equal(store.acquire('publishing'),null);
  fs.rmSync(dir,{recursive:true});
});
test('official browser UI reports active MCP use rather than opening an invisible duplicate',async()=>{
  const release=store.acquire('browser-deepseek');try{const browser=new(require('../core/account-browser').AccountBrowser)({dataDir:temporary});await assert.rejects(browser.open('deepseek'),/MCP/);}finally{release();}
});
test('missing workers are interrupted and submitted tasks cannot create a new conversation through collect',async()=>{
  store.write('dead-job',{id:'dead-job',kind:'web',state:'waiting',pid:2147483646,input:{provider:'deepseek'},submissionAttempted:true,url:'https://evil.example/chat/id'});
  assert.equal(jobs.status('dead-job').state,'interrupted');await assert.rejects(jobs.collect('dead-job','deepseek'),/No known submitted/);
});
test('provider URL contract rejects cross-host, credentials and executable URLs',()=>{
  const {validUrl}=require('../core/web-roundtable/providers');assert.ok(validUrl('kimi','https://www.kimi.com/chat/abcdef?chat_enter_method=home'));
  for(const u of ['javascript:alert(1)','https://www.kimi.com.evil/chat/id','https://u:p@www.kimi.com/chat/id','https://www.kimi.com/login'])assert.equal(validUrl('kimi',u),false);
});
test('MCP initialize, discovery, provider isolation and tool errors run over real stdio',async()=>{
  const c=await new Client([path.resolve(__dirname,'../core/web-roundtable/provider-server.js'),'deepseek']).init();try{
    const listed=await c.request('tools/list');assert.ok(listed.tools.some(t=>t.name==='web_ask'));assert.ok(listed.tools.some(t=>t.name==='web_collect'));
    const status=await c.call('web_status');assert.equal(status.provider,'deepseek');assert.equal(status.authentication,'not_checked');
    store.write('foreign',{kind:'web',state:'succeeded',input:{provider:'kimi'}});await assert.rejects(c.call('web_get',{task_id:'foreign'}),/another MCP/);
    await assert.rejects(c.call('web_ask',{request_id:'bad',prompt:''}),/1\.\.40000/);
  }finally{c.close();await new Promise(r=>c.child.once('exit',r));}
});
test('two real MCP clients share one queued worker and cancellation prevents browser launch',async()=>{
  const release=store.acquire('browser-deepseek');
  const clients=await Promise.all([1,2].map(()=>new Client([path.resolve(__dirname,'../core/web-roundtable/provider-server.js'),'deepseek']).init()));
  let job;
  try{
    const args={request_id:'real-concurrent-queue',prompt:'This must never be sent'};
    const values=await Promise.all(clients.map(c=>c.call('web_ask',args)));assert.equal(values[0].id,values[1].id);
    clients[0].close();await clients[1].call('web_cancel',{task_id:values[1].id});
    for(let i=0;i<60;i++){job=await clients[1].call('web_get',{task_id:values[1].id});if(job.state==='cancelled')break;await store.sleep(100);}
    assert.equal(job.state,'cancelled');assert.equal(job.submissionAttempted,undefined);assert.equal(job.browser,undefined);
    for(let i=0;job.pid&&store.alive(job.pid)&&i<60;i++)await store.sleep(100);
  }finally{release();clients[1].close();await Promise.all(clients.map(c=>c.child.exitCode===null?new Promise(r=>c.child.once('exit',r)):Promise.resolve()));}
});
async function fixtureRun(id,{fail,rounds=2,cancel=false,seed}={}){
  const root=path.join(temporary,id);fs.mkdirSync(root,{recursive:true});
  const job=seed||{id,createdAt:new Date().toISOString(),input:{providers:['deepseek','kimi','qwen'],rounds,synthesizer:'deepseek',prompt:'审查一个假设'},state:'running'};
  store.write(id,job);if(cancel)store.cancel(id);
  const clients=[];
  await roundtable.run(job,p=>{Object.assign(job,p);store.write(id,job);},{pollMs:1,makeClient:p=>{const c=new Client([path.resolve(__dirname,'fixtures/web-provider-mcp.js'),p],{env:{...process.env,HUB_WEB_FIXTURE_ROOT:root,HUB_WEB_FIXTURE_FAIL:fail||''}});clients.push(c);return c;}});
  await Promise.all(clients.map(c=>c.child.exitCode===null?new Promise(r=>c.child.once('exit',r)):Promise.resolve()));
  const log=path.join(root,'sends.jsonl');return {job,root,sends:fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[]};
}
test('roundtable calls independent MCPs, parallel first round, same conversation debates and synthesis',async()=>{
  const {job,sends}=await fixtureRun('fixture-success');assert.equal(job.state,'succeeded');assert.equal(sends.length,7);
  for(const p of ['deepseek','kimi','qwen']){const own=sends.filter(s=>s.provider===p);assert.equal(own[1].reply_to,own[0].request_id);assert.match(own[1].prompt,/其他模型的待核验资料/);}
  assert.equal(sends.filter(s=>s.provider==='deepseek')[2].reply_to,'fixture-success-r2-deepseek');assert.ok(fs.existsSync(job.reportPath));
});
test('one provider failing cannot erase others, vote as agreement, or silently switch synthesizer',async()=>{
  const {job,sends}=await fixtureRun('fixture-partial',{fail:'deepseek'});assert.equal(job.state,'partial');assert.equal(job.synthesis.state,'skipped');assert.equal(sends.length,5);
  assert.equal(job.rounds[1].results.find(r=>r.provider==='deepseek').state,'skipped');assert.match(fs.readFileSync(job.reportPath,'utf8'),/Login required/);
});
test('coordinator replay deduplicates child dispatch through unchanged request IDs',async()=>{
  const first=await fixtureRun('fixture-restart');const replay={...first.job,rounds:[],synthesis:undefined,state:'running'};
  const again=await fixtureRun('fixture-restart',{seed:replay});assert.equal(again.job.state,'succeeded');assert.equal(again.sends.length,7);
});
test('cancellation prevents unsent rounds and produces a report',async()=>{const {job,sends}=await fixtureRun('fixture-cancel',{cancel:true});assert.equal(job.state,'cancelled');assert.equal(sends.length,0);assert.ok(fs.existsSync(job.reportPath));});
test('oversize debate input fails explicitly without silent truncation',()=>{
  assert.throws(()=>roundtable.discussionPrompt('question',[{provider:'deepseek',answer:'x'.repeat(41000)}],'debate'),/no truncation/);
});
test('HTML treats model output as text, never active HTML or a javascript link',()=>{
  const html=require('../core/web-roundtable/report').render({id:'safe',state:'partial',createdAt:'now',input:{providers:['kimi'],prompt:'<img src=x onerror=alert(1)>'},rounds:[{results:[{provider:'kimi',state:'succeeded',answer:'<script>alert(1)</script>',url:'javascript:alert(1)'}]}]});
  assert.ok(html.startsWith('<!doctype html>\n'));assert.match(html,/charset="utf-8"/);assert.doesNotMatch(html,/<script>|href="javascript:/);assert.match(html,/&lt;script&gt;/);
});
test('Hub browser/full profiles expose the parent MCP; none preserves the explicit disable',()=>{
  const integration=require('../core/web-roundtable/integration');for(const p of ['full','browser'])assert.equal(integration.entries([],p,temporary)[0].name,'web_roundtable');assert.deepEqual(integration.entries([],'none',temporary),[]);
  const plan=require('../core/claude-mcp-profile').buildClaudeMcpProfileArgs({hubDataDir:temporary,homeDir:temporary,mcpProfile:'none'});assert.deepEqual(JSON.parse(fs.readFileSync(plan.configPath)).mcpServers,{});
  const native=require('../core/session-manager')._private.buildNativeCodexOptions;
  const info={kind:'codex',cwd:temporary,mcpProfile:'browser',currentModel:{id:'gpt-5.4'},effort:'high',codexSpeedTier:'inherit'};
  const args=native(info,{}, {CODEX_HOME:temporary}).processArgs;
  assert.ok(args.includes('mcp_servers.web_roundtable.enabled=true'));assert.ok(args.some(a=>a.includes('web-roundtable')&&a.includes('server.js')));
  assert.ok(!native({...info,mcpProfile:'none'}, {}, {CODEX_HOME:temporary}).processArgs.some(a=>a.includes('web_roundtable')));
});
test('uncertain later submission blocks another follow-up before any browser is opened',async()=>{
  const parent={id:'prior-complete',state:'succeeded',kind:'web',input:{provider:'deepseek'},answer:'old',url:'https://chat.deepseek.com/a/chat/s/fixture'};
  store.write(parent.id,parent);store.write('later-unknown',{id:'later-unknown',state:'needs_attention',kind:'web',input:{provider:'deepseek'},submissionAttempted:true});store.write('next-'+parent.id,{taskId:'later-unknown'});
  const job={id:'blocked-followup',input:{provider:'deepseek',reply_to:parent.id,prompt:'new'}};let opens=0;
  await jobs.runWeb(job,p=>Object.assign(job,p),'run',{open:async()=>{opens++;throw Error('must not open');}});
  assert.equal(opens,0);assert.equal(job.state,'failed');assert.match(job.error,/later submission/);
});
test('refresh incorporates a collected child into the roundtable without asking again',async()=>{
  const child={id:'collected',kind:'web',input:{provider:'kimi'},state:'succeeded',answer:'Recovered answer',url:'https://www.kimi.com/chat/recovered'};store.write(child.id,child);
  store.write('refresh-me',{id:'refresh-me',kind:'roundtable',createdAt:'now',input:{providers:['kimi'],rounds:1,synthesizer:null,prompt:'question'},state:'partial',rounds:[{results:[{id:child.id,provider:'kimi',state:'needs_attention'}]}]});
  const refreshed=await roundtable.refresh('refresh-me');assert.equal(refreshed.state,'succeeded');assert.equal(refreshed.rounds[0].results[0].answer,'Recovered answer');assert.match(fs.readFileSync(refreshed.reportPath,'utf8'),/Recovered answer/);
});
