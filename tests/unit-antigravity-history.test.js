'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseAntigravityTranscriptToTurns:parse,hash}=require('../core/antigravity-transcript-parser');
const {displayChatTurns}=require('../renderer/simple-chat-display');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-history-unit-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'.gemini','antigravity-cli','brain','a1111111-2222-4333-8444-555555555555','logs','transcript.jsonl');
 fs.mkdirSync(path.dirname(file),{recursive:true});return {file,full:path.join(path.dirname(file),'transcript_full.jsonl'),receiptsFile:path.join(root,'receipt.json')};}
const write=(file,rows)=>fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
test('history pages contain complete logical replies with stable anchors, not tool steps',t=>{
 const {file,receiptsFile}=fixture(t),rows=[];
 const add=(type,content,extra={})=>rows.push({step_index:rows.length,type,source:type==='USER_INPUT'?'USER_EXPLICIT':'MODEL',content,status:'DONE',...extra});
 for(let n=0;n<12;n++){
  add('USER_INPUT',`<USER_REQUEST>question ${n}</USER_REQUEST>`);
  for(let i=0;i<90;i++){add('PLANNER_RESPONSE',`progress ${n}/${i}`,{tool_calls:[{name:'read_file',args:{Path:'a.txt'}}]});add('GENERIC','tool output');}
  add('PLANNER_RESPONSE',`answer ${n}`);
 }
 write(file,rows);
 const tail=parse(file,{limit:9,receiptsFile}),all=parse(file,{limit:33,receiptsFile});
 assert.equal(tail.length,9);assert.equal(all.length,24);
 assert.deepEqual(tail.map(t=>t.id),all.slice(-9).map(t=>t.id));
 const cards=displayChatTurns(all);assert.equal(cards.length,24);
 for(const [n,card] of cards.filter(t=>t.role==='assistant').entries()){
  assert.equal(card.text,`answer ${n}`);assert.equal(card.chatProcessMessages.length,90);
  assert.equal(card.toolCalls.filter(t=>t.output==='tool output').length,90);
 }
});
test('live steps and full text merge even when the bound path is full; newest steps survive',t=>{
 const {file,full,receiptsFile}=fixture(t);
 const row={step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'full answer',created_at:'2026-10-22T01:00:00Z'};
 write(full,[row]);write(file,[{...row,content:'short',truncated_fields:['content']}, {...row,step_index:2,content:'new answer'}]);
 assert.deepEqual(parse(full,{receiptsFile,rawSteps:true}).map(t=>t.text),['full answer','new answer']);
 write(file,[{...row,created_at:'2026-10-22T02:00:00Z',content:'rewritten'}]);
 assert.equal(parse(full,{receiptsFile})[0].text,'rewritten');
});
test('same creation timestamp does not let an old full snapshot overwrite a newly completed step',t=>{
 const {file,full,receiptsFile}=fixture(t),row={step_index:0,type:'PLANNER_RESPONSE',source:'MODEL',created_at:'2026-10-22T01:00:00Z'};
 write(full,[{...row,status:'RUNNING',content:'old partial'}]);
 fs.utimesSync(full,new Date(1000),new Date(1000));
 write(file,[{...row,status:'DONE',content:'new completed answer'}]);
 assert.equal(parse(full,{receiptsFile})[0].text,'new completed answer');
});
test('tool output cannot be the answer or receive a completion label; damaged optional receipts preserve history',t=>{
 const {file,receiptsFile}=fixture(t);
 write(file,[{step_index:0,type:'USER_INPUT',content:'question'},
  {step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'progress',tool_calls:[{name:'run_command',args:{}}]},
  {step_index:2,source:'MODEL',type:'GENERIC',content:'command exited with code 0'}]);
 fs.writeFileSync(receiptsFile,'{broken');
 const steps=parse(file,{receiptsFile,rawSteps:true});
 assert.equal(steps.at(-1).text,'');assert.equal(steps.at(-1).toolCalls[0].output,'command exited with code 0');
 assert.equal(parse(file,{receiptsFile}).at(-1).text,'progress');
});
test('older completed messages remain in process while latest answer is shown once',t=>{
 const {file,receiptsFile}=fixture(t),stamp='2026-10-22T01:00:00Z';
 write(file,[{step_index:0,type:'USER_INPUT',content:'question'},...['old answer','latest answer'].map((content,i)=>({step_index:i+1,type:'PLANNER_RESPONSE',source:'MODEL',content,created_at:stamp}))]);
 fs.writeFileSync(receiptsFile,JSON.stringify(Object.fromEntries(['old answer','latest answer'].map((text,i)=>[`agy-${i+1}`,{textHash:hash(text),ts:Date.parse(stamp),outcome:'completed'}]))));
 const card=displayChatTurns(parse(file,{receiptsFile})).at(-1);
 assert.equal(card.text,'latest answer');assert.equal(card.chatProcessMessages[0].text,'old answer');
});
test('Antigravity long-body folding preserves complete Markdown and other providers default',()=>{
 const {renderMessageBody}=require('../renderer/conversation-message-view'),text='完整正文\n'.repeat(300),opts={escapeHtml:x=>x,renderMarkdown:x=>x};
 assert.match(renderMessageBody(text,opts),/conversation-long-message" open/);
 const html=renderMessageBody(text,{...opts,collapseLong:true});
 assert.doesNotMatch(html,/conversation-long-message" open/);assert.ok(html.includes(text));
});
test('Stop ahead of final planner output never publishes a tool hand-off as completion',t=>{
 const {file,receiptsFile}=fixture(t),{AntigravityTap}=require('../core/antigravity-tap');
 write(file,[{step_index:0,type:'USER_INPUT',content:'question'},
  {step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'checking',tool_calls:[{name:'run_command',args:{}}]},
  {step_index:2,source:'MODEL',type:'GENERIC',content:'command exited with code 0'}]);
 const tap=new AntigravityTap(),events=[];t.after(()=>tap.unregisterSession('h'));
 tap.on('turn-complete',e=>events.push(e));
 tap.registerSession('h',{transcriptPath:file,geminiChatId:'a1111111-2222-4333-8444-555555555555',antigravityEventsFile:path.join(path.dirname(receiptsFile),'events.jsonl')});
 const s=tap._bound.get('h');
 tap._event(s,{hubSessionId:'h',conversationId:s.geminiChatId,transcriptPath:file,observedAt:1,event:'Stop',fullyIdle:true,terminationReason:'NO_TOOL_CALL'});
 assert.equal(events.length,0);
 fs.appendFileSync(file,JSON.stringify({step_index:3,source:'MODEL',type:'PLANNER_RESPONSE',content:'actual answer'})+'\n');
 tap._poll(s);assert.equal(events.length,1);assert.equal(events[0].text,'actual answer');
});
test('worker cache refreshes when live sibling changes behind a bound full transcript',async t=>{
 const {file,full,receiptsFile}=fixture(t),{TranscriptParserService}=require('../core/transcript-parser-service');
 const service=new TranscriptParserService();t.after(()=>service.close());
 write(full,[{step_index:0,type:'USER_INPUT',content:'question'}]);
 const opts={limit:9,fromTail:true,receiptsFile};
 assert.equal((await service.parse('gemini',full,opts)).turns.length,1);
 write(file,[{step_index:1,type:'PLANNER_RESPONSE',source:'MODEL',content:'new live answer'}]);
 const next=await service.parse('gemini',full,opts);
 assert.equal(next.meta.cacheHit,false);assert.equal(next.turns.at(-1).text,'new live answer');
});
