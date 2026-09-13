'use strict';
// Synthetic history matches the reported scale without copying user content.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const { AcpSession } = require('../core/acp-session');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acp-history-perf-'));
  const session = new AcpSession({ id:'performance', kind:'qwen', cwd:root, profileId:'fixture', storeDir:root });
  session.threadId = 'synthetic-thread';
  const payload = 'x'.repeat(800000);
  for (let i=0;i<5;i++) session.history.set('old-'+i, { id:'old-'+i,status:'completed',items:
    Array.from({length:2},(_,j)=>({id:`old-${i}-tool-${j}`,type:'acpTool',status:'completed',title:'Edit fixture',
      content:[{type:'content',content:{type:'text',text:payload}}],result:[{type:'content',content:{type:'text',text:payload}}],rawOutput:{newContent:payload}})) });
  session.runtime = {...session.runtime, state:'running', connection:'connected', turnId:'live'};
  session.active = {turnId:'live',accepted:true,reject:()=>{}};
  session.history.set('live',{id:'live',status:'inProgress',items:[]});
  session.persist();
  const historyBytes = Buffer.byteLength(JSON.stringify([...session.history.values()]));
  const walPath = session.storePath + '.sqlite-wal';
  const walBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  let bytesWritten=0,writes=0;
  let itemPayloadBytes=0,itemWrites=0;
  if(session._historyStore) {
    const save=session._historyStore.saveItem.bind(session._historyStore);
    session._historyStore.saveItem=(turnId,item)=>{itemPayloadBytes+=Buffer.byteLength(JSON.stringify(item));itemWrites++;return save(turnId,item);};
  }
  const saved = new Map();
  for(const method of ['writeFileSync','appendFileSync']) {
    const original=fs[method];saved.set(method,original);
    fs[method]=function(file,data,...args){ if((typeof file==='string' && file.startsWith(root)) || typeof file==='number') {
      bytesWritten+=Buffer.byteLength(data);writes++;
    } return original.call(this,file,data,...args); };
  }
  const samples=[],start=performance.now();
  let heartbeatDelay;
  const heartbeat=new Promise(resolve=>setTimeout(()=>{heartbeatDelay=performance.now()-start;resolve();},0));
  try {
    for(let i=0;i<24;i++) {
      const at=performance.now();
      session.notification({method:'session/update',params:{sessionId:session.threadId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`新增 ${i} 🧪\n`}}}});
      samples.push(performance.now()-at);
    }
  } finally { for(const [method,original] of saved)fs[method]=original; }
  await heartbeat;
  samples.sort((a,b)=>a-b);
  const walGrowth = fs.existsSync(walPath) ? fs.statSync(walPath).size-walBefore : 0;
  const result={fixture:true,historyBytes,events:samples.length,
    p95Ms:samples[Math.floor(samples.length*.95)],maxMs:samples.at(-1),heartbeatDelayMs:heartbeatDelay,
    persistencePayloadBytes:bytesWritten+itemPayloadBytes,jsFileWrites:writes,itemWrites,
    walFileGrowthBytes:walGrowth,measurement:'Persistence payload bytes, not physical disk traffic; WAL can reuse existing allocation'};
  session.kill();
  const out=path.resolve('artifacts/acp-runtime-parity');fs.mkdirSync(out,{recursive:true});
  const label=process.argv[2] || 'current';if(!/^[a-z0-9-]+$/.test(label))throw Error('invalid label');
  fs.writeFileSync(path.join(out,`history-performance-${label}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;});
