'use strict';
// Deliberate opt-in: uses real logged-in websites and their quotas.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {Client}=require('../core/web-roundtable/rpc');
const {sleep}=require('../core/web-roundtable/store');
async function main(){
  const argv=process.argv.slice(2),directory=argv[argv.indexOf('--data-dir')+1];
  if(!argv.includes('--live')||!argv.includes('--data-dir')||!directory||directory.startsWith('--'))throw Error('Explicit --live --data-dir <Hub data directory> required');
  const env={...process.env,AI_HUB_WEB_DATA_DIR:path.resolve(directory)};
  const out=path.resolve(__dirname,'../artifacts/web-roundtable/live-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
  const connect=()=>new Client([path.resolve(__dirname,'../core/web-roundtable/server.js')],{env}).init();
  const clients=await Promise.all([connect(),connect()]);
  let reader;
  try{
    const existing=argv.includes('--existing')?argv[argv.indexOf('--existing')+1]:null;
    const request_id='acceptance-'+Date.now();
    const args={request_id,providers:['deepseek','kimi','qwen'],prompt:'验收题：三个 AI 都说同一个结论就可靠吗？请说明一个反例、一个核验步骤。每轮回答和最终综合控制在120字内，不联网或调用工具。',rounds:2,synthesizer:'deepseek'};
    const old=existing?await clients[0].call('roundtable_get',{task_id:existing}):null;
    const startArgs=old?{request_id:old.requestId,...old.input}:args;
    const values=await Promise.all(clients.map(c=>c.call('roundtable_start',startArgs)));
    assert.equal(values[0].id,values[1].id);clients.forEach(c=>c.close());
    reader=await connect();
    const poll=async(id,label)=>{const end=Date.now()+15*60*1000;let latest;
      while(Date.now()<end){latest=await reader.call('roundtable_get',{task_id:id});fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(latest,null,2),'utf8');
        if(['succeeded','partial','failed','cancelled','interrupted'].includes(latest.state)){assert.equal(latest.state,'succeeded',JSON.stringify({id,error:latest.error,rounds:latest.rounds?.map(r=>r.results.map(x=>({provider:x.provider,state:x.state,error:x.error})))}));return latest;}
        await sleep(1500);
      }throw Error('Live task deadline; inspect '+id+' without resubmitting');};
    const first=await poll(values[0].id,'roundtable');assert.equal(first.rounds.length,2);assert.equal(first.synthesis.state,'succeeded');
    for(const p of args.providers){const rows=first.rounds.map(r=>r.results.find(x=>x.provider===p));assert.ok(rows.every(r=>r.answer&&r.submissionConfirmed));assert.equal(rows[0].url,rows[1].url);}
    const next=await reader.call('roundtable_start',{request_id:request_id+'-followup',providers:args.providers,prompt:'请回顾你刚才的观点，只保留一条最重要的核验建议，并说明它解决什么问题。80字以内，不联网或调用工具。',rounds:1,synthesizer:null,continue_from:first.id});
    const followup=await poll(next.id,'followup');for(const r of followup.rounds[0].results){assert.equal(r.url,first.rounds[0].results.find(x=>x.provider===r.provider).url);assert.ok(r.browser,'browser ownership evidence');}
    fs.copyFileSync(first.reportPath,path.join(out,'roundtable.html'));fs.copyFileSync(followup.reportPath,path.join(out,'followup.html'));
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({passed:true,task:first.id,followup:followup.id,dualClientSameTask:true,reconnectedClient:true,sameConversations:true,counts:{discussion:6,synthesis:1,followup:3},providers:args.providers},null,2),'utf8');
    console.log('PASS: 3 real providers, 2 rounds + synthesis + same-conversation continuation; independent stdio clients and durable results');console.log(out);
  }finally{reader?.close();for(const c of clients)if(!c.child.stdin.writableEnded)c.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
