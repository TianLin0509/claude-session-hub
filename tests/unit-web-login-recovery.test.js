'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const store=require('../core/web-roundtable/store'),jobs=require('../core/web-roundtable/jobs'),recovery=require('../core/web-roundtable/recovery'),roundtable=require('../core/web-roundtable/roundtable');
const {AccountCenter}=require('../core/account-center');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-web-recovery-')),previous=process.env.AI_HUB_WEB_DATA_DIR;process.env.AI_HUB_WEB_DATA_DIR=root;
test.after(()=>{if(previous===undefined)delete process.env.AI_HUB_WEB_DATA_DIR;else process.env.AI_HUB_WEB_DATA_DIR=previous;fs.rmSync(root,{recursive:true,force:true});});
function blocked(id,submitted=false){const j={id,kind:'web',state:'needs_attention',updatedAt:new Date().toISOString(),input:{provider:'deepseek',prompt:'private question'},submissionAttempted:submitted,url:submitted?'https://chat.deepseek.com/a/chat/s/original':undefined,recovery:{reason:'login_required',accountId:'web-deepseek'}};store.write(id,j);recovery.track(j);return j;}
test('website human challenge produces a durable account-linked recovery without entering the editor',async()=>{
  const j={id:'challenge-before',kind:'web',input:{provider:'deepseek',prompt:'private question'}};let sent=0,closed=0;
  await jobs.runWeb(j,p=>{Object.assign(j,p);recovery.track(j);store.write(j.id,j);},'run',{open:async()=>({page:{},close:async()=>closed++}),adapters:{get:()=>({url:'https://chat.deepseek.com/'}),snapshot:async()=>({challenge:true,login:false}),send:async()=>sent++}});
  assert.equal(j.state,'needs_attention');assert.equal(j.recovery.reason,'human_verification');assert.equal(sent,0);assert.equal(closed,1);
  const t=recovery.list(root).find(t=>t.id===j.id);assert.equal(t.mode,'resume');assert.equal(t.accountId,'web-deepseek');assert.ok(!JSON.stringify(t).includes('private question'));
});
test('verification after submission persists collect-only recovery and preserves the original URL',async()=>{
  const j={id:'challenge-after',kind:'web',input:{provider:'deepseek',prompt:'question'}};let sent=0,filled='';
  await jobs.runWeb(j,p=>{Object.assign(j,p);recovery.track(j);store.write(j.id,j);},'run',{
    open:async()=>({page:{call:async(_name,args)=>{filled=args.text;}},close:async()=>{}}),
    adapters:{get:()=>({url:'https://chat.deepseek.com/'}),validUrl:()=>true,dismissPromo:async()=>{},focus:async()=>{},
      snapshot:async()=>({ready:true,login:false,challenge:sent>0,answers:[],echo:0,composerText:filled,url:'https://chat.deepseek.com/a/chat/s/kept'}),send:async()=>{sent++;}}
  });
  assert.equal(sent,1);assert.equal(j.submissionAttempted,true);assert.equal(j.recovery?.reason,'human_verification',JSON.stringify(j));assert.equal(j.url,'https://chat.deepseek.com/a/chat/s/kept');assert.equal(recovery.list(root).find(t=>t.id===j.id).mode,'collect');
});
test('permission snapshot never resumes jobs; only a fresh positive check schedules them',async()=>{
  let signed=false,resumes=0;const service=new AccountCenter({dataDir:root,getConfig:()=>({}),homeDir:root,adapter:{imageAccounts:async()=>[],check:async()=>({state:signed?'signed_in':'unknown',source:'fixture'})},recovery:{list:()=>[{accountId:'web-deepseek',canResume:true}],resume:async()=>{resumes++;return {started:1,errors:[]};}}});
  const row=await service.row('web-deepseek');service.save(service.scope(row),{state:'signed_in'});
  await service.snapshot();assert.equal(resumes,0);await service.check(row.id);assert.equal(resumes,0);
  signed=true;const result=await service.check(row.id);assert.equal(resumes,1);assert.match(result.message,/只补收/);
});
test('recovery failure remains visible without erasing valid login evidence',async()=>{
  const service=new AccountCenter({dataDir:root,getConfig:()=>({}),homeDir:root,adapter:{imageAccounts:async()=>[],check:async()=>({state:'signed_in'})},recovery:{list:()=>[],resume:async()=>{throw Error('MCP failed');}}});
  const r=await service.check('web-kimi');assert.equal(r.state,'signed_in');assert.match(r.message,/MCP failed/);assert.equal(service.read(service.scope(await service.row('web-kimi'))).state,'signed_in');
});
test('cross-client scheduling persists queued admission before launch and starts only one worker',async()=>{
  blocked('schedule-once');let launches=0;
  const call=()=>store.locked('create-schedule-once',()=>jobs.schedule(jobs.status('schedule-once'),'collect',async()=>{launches++;await store.sleep(15);}));
  await Promise.all([call(),call(),call()]);assert.equal(launches,1);assert.equal(store.read('schedule-once').state,'queued');
});
test('submitted tasks without a known conversation fail instead of resending, and cancellation is final',async()=>{
  const j=blocked('no-conversation',true);delete j.url;store.write(j.id,j);await assert.rejects(jobs.resumeWeb(j.id,'deepseek'),/No known submitted/);
  blocked('cancelled-child',true);store.cancel('cancelled-child');await assert.rejects(jobs.resumeWeb('cancelled-child','deepseek'),/Cancelled/);
  assert.ok(!recovery.list(root).some(t=>t.id==='cancelled-child'));
});
test('account recovery routes both pre-send and post-send tasks through original provider task IDs',async()=>{
  const isolated=path.join(root,'routing');fs.mkdirSync(path.join(isolated,'web-roundtable','recovery'),{recursive:true});
  for(const [id,submitted] of [['before',false],['after',true]]){const j={id,kind:'web',input:{provider:'kimi'},state:'needs_attention',submissionAttempted:submitted,recovery:{reason:'login_required'}};fs.writeFileSync(path.join(isolated,'web-roundtable',id+'.json'),JSON.stringify(j));fs.writeFileSync(path.join(isolated,'web-roundtable/recovery',id+'.json'),'{}');}
  const calls=[];const service=new recovery.AccountRecovery({dataDir:isolated,makeClient:provider=>({init:async()=>{},call:async(name,args)=>calls.push({provider,name,args}),close:()=>{}})});
  const r=await service.resume({managedBrowser:true,provider:'kimi'});assert.equal(r.started,2);assert.deepEqual(calls.map(c=>c.args.task_id).sort(),['after','before']);assert.ok(calls.every(c=>c.name==='web_resume'&&c.provider==='kimi'));
});
test('roundtable pauses with peer answers intact and resumes the unfinished round without replay',async()=>{
  const job={id:'paused-roundtable',kind:'roundtable',state:'running',createdAt:'now',input:{providers:['deepseek','kimi','qwen'],prompt:'test question',rounds:2,synthesizer:'kimi'}};
  const replies=new Map();let sends=0;
  const save=p=>{Object.assign(job,p);store.write(job.id,job);};
  const makeClient=provider=>({init:async()=>{},close:()=>{},call:async(name,args)=>{
    if(name==='web_get')return replies.get(args.task_id);
    if(name==='web_ask'){const id=store.taskId('web',args.request_id);if(!replies.has(id)){sends++;const wait=provider==='deepseek'&&args.request_id.includes('-r1-');const j={id,provider,kind:'web',input:{provider,prompt:args.prompt},state:wait?'needs_attention':'succeeded',answer:wait?null:'answer '+sends,...(wait?{recovery:{reason:'login_required'}}:{})};replies.set(id,j);}return replies.get(id);}
    throw Error(name);
  }});
  await roundtable.run(job,save,{makeClient,pollMs:1});assert.equal(job.state,'needs_attention');assert.equal(job.resumeRound,0);assert.equal(job.rounds[0].results.filter(r=>r.state==='succeeded').length,2);assert.equal(sends,3);
  const held=job.rounds[0].results.find(r=>r.provider==='deepseek');Object.assign(replies.get(held.id),{state:'succeeded',answer:'recovered answer'});
  await roundtable.run(job,save,{makeClient,pollMs:1});assert.equal(job.state,'succeeded');assert.equal(job.rounds.length,2);assert.equal(sends,7);assert.equal(job.rounds[0].results[0].answer,'recovered answer');
});
test('cancelled paused parent hides recovery tasks and prevents children from resuming',async()=>{
  const j=blocked('cancelled-parent-child');const parent={id:'cancelled-parent',kind:'roundtable',state:'needs_attention',createdAt:'now',input:{providers:['deepseek'],prompt:'question'},inFlight:{deepseek:{task_id:j.id}}};store.write(parent.id,parent);recovery.link(j.id,parent.id);
  await roundtable.cancel(parent.id);assert.equal(store.read(parent.id).state,'cancelled');await assert.rejects(jobs.resumeWeb(j.id,'deepseek'),/Cancelled/);assert.ok(!recovery.list(root).some(t=>t.id===j.id));
});
test('finished parent and exited workers leave no completed tasks in the recovery queue',()=>{
  const child=blocked('finished-child');child.state='succeeded';store.write(child.id,child);
  store.write('finished-parent',{id:'finished-parent',kind:'roundtable',state:'succeeded',pid:2147483646});recovery.link(child.id,'finished-parent');
  assert.ok(!recovery.list(root).some(t=>t.id===child.id));
});
