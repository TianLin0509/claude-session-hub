'use strict';
const fs=require('node:fs'),path=require('node:path');
const {ClaudeBrokerSession}=require('../core/claude-broker-session');
const owner=Object.create(ClaudeBrokerSession.prototype);
const record={submissionId:'submission',userMessageId:'user',status:'running',createdAt:1,
  messages:new Map([['tool-result',{type:'user',uuid:'tool-result',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'x'.repeat(8_000_000)}]}}]]),
  streams:new Map([['root',{type:'assistant',message:{id:'live',content:[{type:'text',text:''}]}}]])};
owner.options={id:'fixture'};owner.changedUsers=new Set();owner.contentRevision=0;
owner.native={options:{},runtime:{userMessageId:'user'},records:new Map([['submission',record]]),activities:{records:new Map()},recoveryRecords:()=>[]};
// Establish the initial snapshot before measuring subsequent small updates.
JSON.stringify(owner.snapshotExtra({full:true}));
JSON.stringify(owner.snapshotExtra({messagePatches:true}));
const samples=[];let payloadBytes=0;const start=performance.now();
for(let i=0;i<24;i++){
  record.streams.get('root').message.content[0].text+='新增文字';owner.changedUsers.add('user');owner.contentRevision++;
  const at=performance.now();payloadBytes+=Buffer.byteLength(JSON.stringify(owner.snapshotExtra({messagePatches:true})));samples.push(performance.now()-at);
}
samples.sort((a,b)=>a-b);
const result={synthetic:true,events:24,toolBytes:8_000_000,totalMs:performance.now()-start,p95Ms:samples[Math.floor(samples.length*.95)],payloadBytes};
const label=process.argv[2]||'current';if(!/^[a-z0-9-]+$/.test(label))throw Error('invalid label');
const out=path.resolve('artifacts/claude-codex-parity');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'broker-content-'+label+'.json'),JSON.stringify(result,null,2));console.log(result);
