'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CompanyAiTasks}=require('../core/company-ai-tasks');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'company-ai-test-'));const finals=new Map(),prompts=[],closed=[],created=[];
 const service=new CompanyAiTasks({dataDir:root,concurrency:1,pollMs:5,
  createSession:async(kind,opts)=>{assert.equal(kind,'codeagent');created.push(opts);return {id:opts.id};},
  sendPrompt:async(id,text,receipt)=>{prompts.push({id,text,receipt});return {ok:true};},lastFinal:id=>finals.get(id),closeSession:id=>closed.push(id)});
 try{
  let open=true;
  await require('../core/company-ai-tasks').closeOwnedSession({closeSessionRecoverably:async()=>({ok:false,error:'native-session-id-missing'}),getSession:()=>open?{}:null,closeSession:()=>{open=false;}},'owned');
  assert.equal(open,false);
  const env={};require('../core/auto-dispatch-rules').applySessionEnv(env,'company-ai',{enabled:true,tools:['AskUserQuestion']});assert.equal(env.AI_HUB_NO_CHOICE,'1');
  assert.doesNotMatch(require('../core/auto-dispatch-rules').autoRuleFor('company-ai').text,/假设与备选/);
  const first=service.run({text:'draft A'});const cancel=new AbortController();const second=service.run({text:'draft B'},{signal:cancel.signal});
  const rejected=assert.rejects(second,/取消/);cancel.abort();await rejected;
  await sleep(15);assert.equal(created.length,1);assert.equal(prompts.length,1);
  finals.set(prompts[0].id,{text:'stale response [任务回执:wrong]'});await sleep(15);assert.equal(service.active.size,1);
  const marker=prompts[0].text.match(/\[任务回执:[a-f0-9-]+\]/)[0];finals.set(prompts[0].id,{text:'整理结果\n'+marker});
  const answer=await first;assert.equal(answer.text,'整理结果');assert.equal(answer.model,'CodeAgent');assert.ok(closed.includes(answer.sessionId));
  assert.deepEqual(service.sessionPlan({id:answer.sessionId}),{});assert.equal(service.sessionPlan({id:'other'}),null);
  const aborted=new AbortController();const third=service.run({text:'draft C'},{signal:aborted.signal});const failed=assert.rejects(third,/取消/);await sleep(10);aborted.abort();await failed;
  assert.equal(new Set(created.map(x=>x.id)).size,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'company-ai-tasks',answer.jobId,'task.json'))).state,'done');
  const stalled=new CompanyAiTasks({dataDir:root,pollMs:5,createSession:()=>new Promise(()=>{}),closeSession:()=>{}});
  const pending=stalled.run({text:'stalled',timeoutMs:1000});await assert.rejects(pending,/超时/);stalled.close();
  const restarted=new CompanyAiTasks({dataDir:root});assert.equal(restarted.queue.length,0);restarted.close();
  console.log('PASS company AI queue, isolated sessions, receipts, cancellation, bounded startup, persistence');
 }finally{service.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
