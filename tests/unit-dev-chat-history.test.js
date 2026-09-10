'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _private: { GroupChatOrchestrator } } = require('../core/group-chat-orchestrator');
const { createHistoryReader, rememberPrompt, recollectHistory, createHistoryService } = require('../core/dev-chat-history');

function setup(t, kind = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-history-unit-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const orch = new GroupChatOrchestrator(dir, 'meeting');
  const makeTurn = text => {
    const {turnNum,runId}=orch.beginTurn(text);
    const p=orch.recordTurnPrompt(turnNum,'s',text,{runId,memberId:'m1',kind});
    rememberPrompt(orch,'s',p);
    return orch.getAttempt(p.attemptId);
  };
  const reader = createHistoryReader({orch,sid:'s',kind,sourcePath:path.join(dir,'source.jsonl'),speaker:'Agent'});
  let offset=0;
  const row = payload => reader.record({type:'event_msg',timestamp:new Date().toISOString(),payload},{startOffset:offset++});
  return {orch,reader,row,makeTurn,dir};
}
test('natural progress survives handoff, replay, repeated text, >40 messages and reload',t=>{
  const {orch,row,makeTurn,dir}=setup(t);
  const a=makeTurn('first');
  row({type:'task_started',turn_id:'old'}); row({type:'user_message',message:'first'});
  for(let i=0;i<45;i++)row({type:'item_completed',turn_id:'old',item:{type:'AgentMessage',id:`p${i}`,phase:'commentary',text:`progress ${i}`}});
  const b=makeTurn('second');
  row({type:'task_started',turn_id:'new'}); row({type:'user_message',message:'second'});
  row({type:'item_completed',turn_id:'old',item:{type:'AgentMessage',id:'late',phase:'commentary',text:'late old'}});
  const final={type:'item_completed',turn_id:'old',item:{type:'AgentMessage',id:'final',phase:'final_answer',text:'old final'}};
  row(final);row(final);
  row({type:'item_completed',turn_id:'new',item:{type:'AgentMessage',id:'r1',phase:'commentary',text:'same'}});
  row({type:'item_completed',turn_id:'new',item:{type:'AgentMessage',id:'r2',phase:'commentary',text:'same'}});
  const old=orch.state.messages.filter(m=>m.sourceMessage && m.attemptId===a.attemptId);
  assert.equal(old.length,47);
  assert.equal(orch.state.messages.filter(m=>m.sourceMessage && m.attemptId===b.attemptId).length,2);
  assert.ok(!orch.state.messages.some(m=>m.attemptId===b.attemptId && m.content==='old final'));
  const restored = new GroupChatOrchestrator(dir,'meeting');
  assert.equal(restored.state.messages.filter(m=>m.sourceMessage).length,49);
});
test('Claude uses real user UUID ancestry, keeps text and filters tool/thinking records',t=>{
  const {orch,reader,makeTurn}=setup(t,'claude'); const a=makeTurn('first');
  const at=new Date().toISOString();
  reader.record({type:'user',uuid:'u1',timestamp:at,message:{role:'user',content:'first'}},{startOffset:1});
  reader.record({type:'assistant',uuid:'a1',parentUuid:'u1',timestamp:at,message:{id:'msg1',content:[{type:'text',text:'自然进展\n- C:\\code\\file.js'},{type:'thinking',thinking:'hidden'}]}},{startOffset:2});
  reader.record({type:'user',uuid:'tool-result',parentUuid:'a1',timestamp:at,message:{content:[{type:'tool_result',content:'noise'}]}},{startOffset:3});
  const b=makeTurn('second');
  reader.record({type:'user',uuid:'u2',timestamp:at,message:{content:'second'}},{startOffset:4});
  reader.record({type:'assistant',uuid:'a2',parentUuid:'tool-result',timestamp:at,message:{id:'msg2',content:[{type:'text',text:'旧轮收尾'}],stop_reason:'end_turn'}},{startOffset:5});
  const messages=orch.state.messages.filter(m=>m.sourceMessage);
  assert.equal(messages.length,2);assert.ok(messages.every(m=>m.attemptId===a.attemptId));
  assert.ok(!messages.some(m=>m.content.includes('hidden')||m.content==='noise'||m.attemptId===b.attemptId));
});
test('unknown prompt/turn cannot be assigned to current attempt',t=>{
  const {orch,row,makeTurn}=setup(t);makeTurn('expected');
  row({type:'task_started',turn_id:'other'});row({type:'user_message',message:'different'});
  row({type:'item_completed',turn_id:'other',item:{type:'AgentMessage',id:'x',phase:'final_answer',text:'wrong'}});
  assert.equal(orch.state.messages.filter(m=>m.sourceMessage).length,0);
});
test('provider identity recovers early text despite TUI whitespace change, without fuzzy prompt matching',t=>{
  const {orch,reader,row,makeTurn}=setup(t);const a=makeTurn('first\n\nline');
  row({type:'task_started',turn_id:'provider-owned'});
  row({type:'user_message',message:'first\nline'});
  row({type:'item_completed',turn_id:'provider-owned',item:{id:'early',type:'AgentMessage',phase:'commentary',text:'early text'}});
  assert.equal(orch.state.messages.filter(m=>m.sourceMessage).length,0);
  orch.updateAttempt(a.attemptId,{providerTurnId:'provider-owned'},'test_bound');reader.refresh();
  assert.equal(orch.state.messages.filter(m=>m.sourceMessage).length,1);
  assert.equal(orch.state.devChatHistory.receipts[a.attemptId].sourcePromptMatched,false);
});

test('Claude empty thinking terminal cannot release the next stage; text terminals can',t=>{
  const {orch,reader,makeTurn}=setup(t,'claude');const a=makeTurn('first');
  reader.record({type:'user',uuid:'u',message:{content:'first'}});
  reader.record({type:'assistant',uuid:'thinking',parentUuid:'u',message:{stop_reason:'end_turn',content:[{type:'thinking',thinking:''}]}});
  assert.equal(orch.state.devChatHistory.receipts[a.attemptId].sourceCompletedAt,undefined);
  reader.record({type:'assistant',uuid:'answer',parentUuid:'thinking',message:{stop_reason:'max_tokens',content:[{type:'text',text:'正文仍保留'}]}});
  assert.ok(orch.state.devChatHistory.receipts[a.attemptId].sourceCompletedAt);
  assert.equal(orch.state.messages.filter(m=>m.sourceMessage).length,1);
});

test('source read failure is reported instead of a successful empty recollection',async t=>{
  const {orch,dir}=setup(t);
  await assert.rejects(recollectHistory({orch,sid:'s',kind:'codex',sourcePath:path.join(dir,'missing.jsonl')}),{code:'ENOENT'});
  // stat succeeds for a directory; opening/reading it as JSONL must still fail.
  await assert.rejects(recollectHistory({orch,sid:'s',kind:'codex',sourcePath:dir}));
  const source=path.join(dir,'source.jsonl');fs.writeFileSync(source,'{}\n');
  t.mock.method(fs.promises,'open',async()=>{throw Object.assign(new Error('read denied'),{code:'EACCES'});});
  await assert.rejects(recollectHistory({orch,sid:'s',kind:'codex',sourcePath:source}),{code:'EACCES'});
});

test('late history keeps its attempt and an empty handoff cannot downgrade a saved final',t=>{
  const {orch,row,makeTurn}=setup(t);const a=makeTurn('first');
  row({type:'task_started',turn_id:'old'});row({type:'user_message',message:'first'});
  orch.patchTurnResult(a.turnNum,'s',{text:'saved final',status:'completed',attemptId:a.attemptId,finality:'provider_final'});
  orch.patchTurnResult(a.turnNum,'s',{text:'',status:'handed_off',attemptId:a.attemptId});
  const canonical=orch.state.messages.find(m=>m.role==='assistant' && !m.sourceMessage);
  assert.equal(canonical.status,'completed');assert.equal(canonical.content,'saved final');
  // A legacy retry may already own the turn's canonical answer.
  canonical.attemptId='new-attempt';canonical.content='new attempt final';
  orch.state.attempts[a.attemptId].status='superseded';
  row({type:'item_completed',turn_id:'old',item:{id:'late',type:'AgentMessage',phase:'final_answer',text:'old attempt final'}});
  assert.equal(canonical.content,'new attempt final');
  assert.equal(canonical.attemptId,'new-attempt');
  assert.ok(orch.state.messages.some(m=>m.sourceMessage && m.attemptId===a.attemptId && m.content==='old attempt final'));
});

test('an interrupted collector replays a late final on restart without duplicating progress',async t=>{
  const {orch,dir,makeTurn}=setup(t);makeTurn('first');
  const sourcePath=path.join(dir,'source.jsonl');
  const encode=payload=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})+'\n';
  fs.writeFileSync(sourcePath,encode({type:'task_started',turn_id:'provider'})+encode({type:'user_message',message:'first'})
    +encode({type:'agent_message',message:'ordinary progress'}));
  const service=createHistoryService({getOrchestrator:()=>orch});
  await service.watch({sid:'s',meetingId:'meeting',kind:'codex',sourcePath});service.dispose();
  fs.appendFileSync(sourcePath,encode({type:'task_complete',turn_id:'provider',last_agent_message:'late final'}));
  const restored=new GroupChatOrchestrator(dir,'meeting');
  const restarted=createHistoryService({getOrchestrator:()=>restored});
  t.after(()=>restarted.dispose());
  await restarted.watch({sid:'s',meetingId:'meeting',kind:'codex',sourcePath});
  assert.deepEqual(restored.state.messages.filter(m=>m.sourceMessage).map(m=>m.content),['ordinary progress','late final']);
  assert.ok(Object.values(restored.state.devChatHistory.receipts)[0].sourceCompletedAt);
});

test('a deferred write failure forces replay and flushes the original message durably',async t=>{
  const {orch,dir,makeTurn}=setup(t);const a=makeTurn('first\n\nline');
  const sourcePath=path.join(dir,'source.jsonl');
  fs.writeFileSync(sourcePath,[{type:'task_started',turn_id:'provider'},{type:'user_message',message:'first\nline'},
    {type:'agent_message',message:'early text'}].map(payload=>JSON.stringify({type:'event_msg',payload})).join('\n')+'\n');
  const service=createHistoryService({getOrchestrator:()=>orch,logger:{error(){}}});t.after(()=>service.dispose());
  const options={sid:'s',meetingId:'meeting',kind:'codex',sourcePath};
  await service.watch(options);
  orch.updateAttempt(a.attemptId,{providerTurnId:'provider'});
  const original=orch._saveState.bind(orch);let failed=false;
  orch._saveState=(event,details)=>{
    if(event==='dev_chat_message_saved' && !failed){failed=true;throw new Error('test durable write failure');}
    return original(event,details);
  };
  await assert.rejects(service.watch(options),/test durable write failure/);
  await service.watch(options);
  const restored=new GroupChatOrchestrator(dir,'meeting');
  assert.equal(restored.state.messages.filter(m=>m.sourceMessage && m.content==='early text').length,1);
});

test('task_complete only coalesces the immediately preceding assistant message',t=>{
  const {orch,row,makeTurn}=setup(t);makeTurn('first');
  row({type:'task_started',turn_id:'provider'});row({type:'user_message',message:'first'});
  row({type:'agent_message',message:'检查通过'});
  row({type:'agent_message',message:'继续补查一个边界'});
  row({type:'task_complete',turn_id:'provider',last_agent_message:'检查通过'});
  const messages=orch.state.messages.filter(m=>m.sourceMessage);
  assert.equal(messages.length,3,'an earlier equal-text progress message is not the terminal event mirror');
  assert.deepEqual(messages.map(m=>m.phase),['commentary','commentary','final']);
});
