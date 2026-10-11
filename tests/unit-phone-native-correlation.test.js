const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LiveHistory,readFinals}=require('../core/hub-assistant/live-history');
const envelope=id=>'[AI_HUB_ASSISTANT_CONTEXT_V1]'+JSON.stringify({role:'assistant',userText:'task',sessions:{sessions:[]},history:{clientSubmissionId:id}})+'[/AI_HUB_ASSISTANT_CONTEXT_V1]';
test('Claude image companion preserves photo identity in full, incremental and cold reads',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phone-photo-meta-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'native.jsonl'),meta={id:'photo',kind:'claude',ccSessionId:'native',transcriptPath:file};
 const write=rows=>fs.appendFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
 write([{type:'user',sessionId:'native',message:{content:envelope('photo-request-3333')}}]);
 const live=new LiveHistory();live.read(meta);
 write([{type:'user',sessionId:'native',message:{content:[{type:'tool_result',content:'x'.repeat(1200000)}]}},
  {type:'user',sessionId:'native',isMeta:true,turnCompanion:true,message:{content:[{type:'image',source:{type:'base64',data:'AA=='}},{type:'text',text:'[Image: original 3840x3104, displayed at 2000x1617.]'}]}},
  {type:'assistant',sessionId:'native',uuid:'photo-final',message:{stop_reason:'end_turn',content:[{type:'text',text:'photo answer'}]}}]);
 for(const result of [readFinals(meta,{startOffset:0}),live.read(meta),new LiveHistory().read(meta)]){
  assert.equal(result.records.at(-1).clientSubmissionId,'photo-request-3333');assert.equal(result.records.at(-1).text,'photo answer');
 }
 write([{type:'user',sessionId:'native',message:{content:[{type:'text',text:'new desktop question'}]}},
  {type:'assistant',sessionId:'native',uuid:'desktop-final',message:{stop_reason:'end_turn',content:[{type:'text',text:'desktop answer'}]}}]);
 assert.equal(live.read(meta).records.at(-1).clientSubmissionId,null,'real desktop prompts must clear the old photo identity');
});
test('Claude final is bound to its native user envelope, survives tool results and cold tail restart',()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'phone-claude-')),'native.jsonl'),meta={id:'assistant',kind:'claude',ccSessionId:'native',transcriptPath:file};
 const rows=[{type:'user',sessionId:'native',message:{content:envelope('phone-request-1111')}},{type:'assistant',sessionId:'native',uuid:'old',message:{stop_reason:'end_turn',content:[{type:'text',text:'old'}]}},{type:'user',sessionId:'native',message:{content:envelope('phone-request-2222')}},{type:'user',sessionId:'native',message:{content:[{type:'tool_result',content:'x'.repeat(1200000)}]}},{type:'assistant',sessionId:'native',uuid:'new',message:{stop_reason:'end_turn',content:[{type:'text',text:'new'}]}}];
 fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
 const records=new LiveHistory().read(meta).records;
 assert.equal(records.at(-1).clientSubmissionId,'phone-request-2222');assert.equal(records.at(-1).text,'new');
 fs.appendFileSync(file,JSON.stringify({type:'user',sessionId:'native',message:{content:'desktop task'}})+'\n'+JSON.stringify({type:'assistant',sessionId:'native',uuid:'desktop',message:{stop_reason:'end_turn',content:[{type:'text',text:'desktop'}]}})+'\n');
 assert.equal(new LiveHistory().read(meta).records.at(-1).clientSubmissionId,null);assert.equal(readFinals({...meta,ccSessionId:'wrong'}).available,false);
});
test('cold photo queue reconciles an image answer and starts the next photo exactly once',async t=>{
 const {PhoneChannel}=require('../core/hub-phone/channel'),{credentials,open}=require('../core/hub-phone/crypto');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phone-photo-queue-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'native.jsonl'),meta={id:'photo',kind:'claude',ccSessionId:'native',transcriptPath:file};
 const old='400cee7c-6d3f-4862-9bbb-f5b5223e501b',next='3b671321-8319-48ab-8b2e-d08c4a3a9bba';
 fs.writeFileSync(file,[{type:'user',sessionId:'native',message:{content:envelope(old)}},
  {type:'user',sessionId:'native',message:{content:[{type:'tool_result',content:'x'.repeat(1200000)}]}},
  {type:'user',sessionId:'native',isMeta:true,turnCompanion:true,message:{content:[{type:'text',text:'[Image: original 3840x3104, displayed at 2000x1617.]'}]}},
  {type:'assistant',sessionId:'native',uuid:'done',message:{stop_reason:'end_turn',content:[{type:'text',text:'existing photo answer'}]}}
 ].map(JSON.stringify).join('\n')+'\n');
 const c=credentials(),state={credentials:c,enabled:true,cursor:1,inbox:[
  {id:old,type:'text',text:'old',shared:'115509-capture-'+old+'.jpg',state:'waiting',sessionId:'photo'},
  {id:next,type:'text',text:'new',shared:'223613-capture-'+next+'.jpg',state:'queued'}],outbox:[],notices:[]};
 const calls=[],history=new LiveHistory(),assistant={overview:()=>({status:'idle'}),notifications:()=>({notifications:[]}),readLiveFinal:()=>history.read(meta),
  photo:{overview:()=>({status:'idle'}),ensureSession:async()=>({ok:true,sessionId:'photo'}),send:async r=>{calls.push(r);return{receipt:{receipt:{status:'confirmed'}}}}}};
 const channel=new PhoneChannel({assistant,journal:{state,change:fn=>fn(state)}});channel.request=async()=>({messages:[]});
 await channel.tick();await channel.tick();
 assert.equal(state.inbox[0].state,'answered');assert.equal(state.inbox[1].state,'waiting');assert.deepEqual(calls.map(r=>r.requestId),[next]);
 const replies=state.outbox.filter(r=>r.id==='answer-'+old);assert.equal(replies.length,1);
 assert.equal(open(c.key,c.channel,replies[0].id,'hub',replies[0].payload).text,'existing photo answer');
});
