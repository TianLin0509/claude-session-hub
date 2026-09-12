'use strict';
// Deterministic native event/persistence overhead, excludes network/model time.
const {performance}=require('perf_hooks'),fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {AcpSession}=require('../core/acp-session');
async function main(){
  const runs=[];
  for(let repeat=0;repeat<3;repeat++){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'acp-event-perf-'));
    const s=new AcpSession({id:'perf',kind:'qwen',profileId:'fixture',cwd:root,storeDir:root,
      launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/acp-agent.js')],cwd:root,env:process.env}});
    const samples=[];
    try{
      await s.start();await s.send('cancel');
      for(let i=0;i<30;i++)s.history.set('old'+i,{id:'old'+i,status:'completed',items:[{id:'oldmessage'+i,type:'agentMessage',text:'历史'.repeat(5000)}]});
      const before=process.memoryUsage().rss;
      for(let i=0;i<300;i++){
        const start=performance.now();s.notification({method:'session/update',params:{sessionId:s.threadId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中文事件 🧪 '+i+'\n'}}}});
        samples.push(performance.now()-start);
      }
      samples.sort((a,b)=>a-b);const p95=samples[Math.floor(samples.length*0.95)];assert(p95<500,'native processing overhead exceeds 500 ms');
      runs.push({repeat,p95Ms:p95,maxMs:samples.at(-1),rssDeltaBytes:process.memoryUsage().rss-before,events:samples.length,historyTurns:30});
      await s.interrupt();await s.idle(2000);
    }finally{s.kill();}
  }
  fs.mkdirSync('artifacts/acp',{recursive:true});fs.writeFileSync('artifacts/acp/event-performance.json',JSON.stringify({fixture:true,boundary:'Main event normalization plus UTF-8 durable history writes; excludes renderer and model',runs},null,2));console.log(JSON.stringify(runs));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
